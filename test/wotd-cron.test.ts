import { afterEach, describe, expect, test } from "bun:test";
import type { CronContext } from "discord-hono";
import { createRest } from "discord-hono";
import { postWotd, runWotd } from "../src/cron/wotd.js";
import type { AppEnv } from "../src/lib/errors.js";

const CORPUS_URL = "https://corpus.aynu.org";
const MDB_URL = "https://mdb.aynu.org";
const GLOSSARY_URL = "https://itak.aynu.org/api/gdoc";
const CHANNEL_ID = "channel-123";
const NOW = new Date("2026-07-03T10:00:00Z"); // 2026-07-03 JST
const TODAY = "2026-07-03";
const YESTERDAY = "2026-07-02";

// --- Minimal in-memory D1 stub, mirroring the wotd_history schema. --------

interface HistoryRow {
	date: string;
	token: string;
	posted: number;
}

class FakeStatement {
	#query: string;
	#db: FakeD1;
	#args: unknown[] = [];

	constructor(query: string, db: FakeD1) {
		this.#query = query;
		this.#db = db;
	}

	bind(...values: unknown[]) {
		this.#args = values;
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (
			this.#query.includes("SELECT posted FROM wotd_history WHERE date = ?")
		) {
			const [date] = this.#args as [string];
			const row = this.#db.rows.get(date);
			return (row ? { posted: row.posted } : null) as T | null;
		}
		if (this.#query.includes("SELECT token FROM wotd_history WHERE date = ?")) {
			const [date] = this.#args as [string];
			const row = this.#db.rows.get(date);
			return (row ? { token: row.token } : null) as T | null;
		}
		throw new Error(`FakeStatement.first: unsupported query: ${this.#query}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (
			this.#query.includes("SELECT token FROM wotd_history WHERE date >= ?")
		) {
			const [since] = this.#args as [string];
			const results = [...this.#db.rows.values()]
				.filter((r) => r.date >= since)
				.map((r) => ({ token: r.token }));
			return { results: results as T[] };
		}
		throw new Error(`FakeStatement.all: unsupported query: ${this.#query}`);
	}

	async run() {
		if (this.#query.includes("INSERT INTO wotd_history")) {
			const [date, token] = this.#args as [string, string];
			this.#db.rows.set(date, { date, token, posted: 1 });
			return { success: true, meta: {} };
		}
		throw new Error(`FakeStatement.run: unsupported query: ${this.#query}`);
	}
}

class FakeD1 {
	rows = new Map<string, HistoryRow>();
	prepare(query: string) {
		return new FakeStatement(query, this);
	}
}

class MemoryKV {
	#store = new Map<string, string>();
	async get(key: string, type?: "json" | "text"): Promise<unknown> {
		const raw = this.#store.get(key);
		if (raw === undefined) return null;
		return type === "json" ? JSON.parse(raw) : raw;
	}
	async put(key: string, value: string): Promise<void> {
		this.#store.set(key, value);
	}
}

function makeEnv(db: FakeD1, kv: MemoryKV, channelId = CHANNEL_ID): Env {
	return {
		DB: db,
		KV: kv,
		CORPUS_API_URL: CORPUS_URL,
		MDB_API_URL: MDB_URL,
		GLOSSARY_API_URL: GLOSSARY_URL,
		WOTD_CHANNEL_ID: channelId,
	} as unknown as Env;
}

function makeExecutionCtx() {
	const tasks: Promise<unknown>[] = [];
	return {
		waitUntil(p: Promise<unknown>) {
			tasks.push(p);
		},
		passThroughOnException() {},
		settle: () => Promise.allSettled(tasks),
	};
}

function makeContext(env: Env): {
	c: CronContext<AppEnv>;
	settle: () => Promise<unknown>;
} {
	const { settle, ...ctx } = makeExecutionCtx();
	// DISCORD_TOKEN is a secret (not part of the generated `Env` vars type) —
	// its value is irrelevant here since `globalThis.fetch` is stubbed below.
	const c = {
		env,
		executionCtx: ctx,
		rest: createRest("test-token"),
	} as unknown as CronContext<AppEnv>;
	return { c, settle };
}

const freqRow = (token: string, count: number) => ({
	token,
	count,
	is_stopword: 0,
});

const FREQ_ROWS = [
	freqRow("e", 900), // filtered: too short
	freqRow("kamuy", 500),
	freqRow("utar", 400),
	freqRow("sinep", 300),
];

const GLOSSARY_TABLE = [
	{ Aynu: "utar", 日本語: "人々", English: "people", sheetName: "core" },
];

const corpusRow = (
	id: string,
	text: string,
	translation: string,
	document = "doc1",
) => ({
	id,
	text,
	translation,
	dialect: "沙流",
	author: null,
	collection: null,
	document,
	uri: null,
});

const DEFAULT_CORPUS_ROWS = [
	corpusRow("s1", "utar okay.", "people are there."),
];

let corpusRows: unknown[] = DEFAULT_CORPUS_ROWS;
let discordPosts: unknown[] = [];
let discordShouldFail = false;
let mdbLexemeResults: unknown[] = [];
const originalFetch = globalThis.fetch;

function stubFetch() {
	discordPosts = [];
	mdbLexemeResults = [];
	corpusRows = DEFAULT_CORPUS_ROWS;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith(`${CORPUS_URL}/v1/freq/list`)) {
			return new Response(
				JSON.stringify({ api_version: "1", data: FREQ_ROWS }),
			);
		}
		if (url.startsWith(`${CORPUS_URL}/v1/search`)) {
			return new Response(
				JSON.stringify({ api_version: "1", data: corpusRows }),
			);
		}
		if (url.startsWith(`${MDB_URL}/api/lexemes`)) {
			return new Response(
				JSON.stringify({
					query: "utar",
					total: mdbLexemeResults.length,
					returned: mdbLexemeResults.length,
					results: mdbLexemeResults,
				}),
			);
		}
		if (url === GLOSSARY_URL) {
			return new Response(
				JSON.stringify({ table: GLOSSARY_TABLE, sheets: [] }),
			);
		}
		if (url.startsWith("https://discord.com/api")) {
			discordPosts.push(init?.body ? JSON.parse(String(init.body)) : undefined);
			return discordShouldFail
				? new Response("forbidden", { status: 403 })
				: new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof fetch;
}

describe("runWotd", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		discordShouldFail = false;
	});

	test("empty WOTD_CHANNEL_ID: safe no-op, no upstream calls at all", async () => {
		stubFetch();
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV(), ""));

		await runWotd(c, NOW);
		await settle();

		expect(discordPosts).toHaveLength(0);
		expect(db.rows.size).toBe(0);
	});

	test("happy path: picks a candidate, posts once, and writes a posted=1 history row", async () => {
		stubFetch();
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		expect(discordPosts).toHaveLength(1);
		const embed = (discordPosts[0] as { embeds: { title: string }[] })
			.embeds[0];
		expect(embed.title).toContain("Word of the day");

		expect(db.rows.size).toBe(1);
		const row = [...db.rows.values()][0];
		expect(row.posted).toBe(1);
		expect(["kamuy", "utar", "sinep"]).toContain(row.token);
	});

	test("all-ambiguous MDB homographs: still posts with the glossary gloss (no wrong MDB sense)", async () => {
		stubFetch();
		// The deterministic probe for NOW reaches `utar`, the only glossary hit;
		// make its MDB lexemes ambiguous. Rather than skipping the day, WOTD must
		// fall back to the glossary gloss (人々), never an arbitrary MDB sense.
		mdbLexemeResults = [
			{
				id: "utar.n",
				lemma: "utar",
				kana: "",
				pos: "n",
				gloss_en: [],
				gloss_jp: ["人々"],
				bound: false,
				dialects: [],
				variations: [],
				recordings: 0,
				morphemes: [],
			},
			{
				id: "utar.vi",
				lemma: "utar",
				kana: "",
				pos: "vi",
				gloss_en: [],
				gloss_jp: ["仮の別義"],
				bound: false,
				dialects: [],
				variations: [],
				recordings: 0,
				morphemes: [],
			},
		];
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		// Post still happens, using the glossary gloss (not the ambiguous MDB one).
		expect(discordPosts).toHaveLength(1);
		const embed = (
			discordPosts[0] as {
				embeds: { fields: { name: string; value: string }[] }[];
			}
		).embeds[0];
		const meaning = embed.fields.find((f) => f.name.includes("Meaning"))?.value;
		expect(meaning).toContain("人々");
		expect(meaning).not.toContain("仮の別義");

		// History row is written so the day is not retried.
		expect(db.rows.size).toBe(1);
		expect([...db.rows.values()][0].posted).toBe(1);
		expect([...db.rows.values()][0].token).toBe("utar");
	});

	test("an unresolved sense takes its examples from the whole corpus pool", async () => {
		stubFetch();
		// Short sentences from distinct sources lead the ranking, so a slate cut to
		// three before the meaning is checked holds none of the sentences that show
		// 人々 — the day would post with no example at all.
		corpusRows = [
			corpusRow("s1", "utar ne.", "そうである。", "doc1"),
			corpusRow("s2", "utar an.", "そこにある。", "doc2"),
			corpusRow("s3", "utar ka.", "それもだ。", "doc3"),
			corpusRow("s4", "utar opitta arpa.", "人々はみな行った。", "doc4"),
		];
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		const embed = (
			discordPosts[0] as {
				embeds: { fields: { name: string; value: string }[] }[];
			}
		).embeds[0];
		const examples = embed.fields.find((f) =>
			f.name.includes("Example"),
		)?.value;
		expect(examples).toContain("utar opitta arpa.");
		expect(examples).not.toContain("utar ne.");
	});

	test("a re-fired cron trigger on the same JST day is a no-op (idempotent)", async () => {
		stubFetch();
		const db = new FakeD1();
		const kv = new MemoryKV();

		const first = makeContext(makeEnv(db, kv));
		await runWotd(first.c, NOW);
		await first.settle();
		expect(discordPosts).toHaveLength(1);

		const second = makeContext(makeEnv(db, kv));
		await runWotd(second.c, NOW);
		await second.settle();

		// No additional Discord post on the second run.
		expect(discordPosts).toHaveLength(1);
		expect(db.rows.size).toBe(1);
	});

	test("a manual run on a recorded day reposts that word, never a fresh pick", async () => {
		stubFetch();
		const db = new FakeD1();
		const kv = new MemoryKV();

		const first = makeContext(makeEnv(db, kv));
		await runWotd(first.c, NOW);
		await first.settle();
		const token = [...db.rows.values()][0]?.token;

		const again = makeContext(makeEnv(db, kv));
		const outcome = await postWotd(again.c, { now: NOW });
		await again.settle();

		expect(outcome).toEqual({
			status: "resent",
			token: token as string,
			date: TODAY,
		});
		expect(discordPosts).toHaveLength(2);
		// The word is unchanged, and the day still holds one history row: a repost
		// replaces a bad embed, it does not consume another day's word.
		expect(db.rows.size).toBe(1);
		expect([...db.rows.values()][0]?.token).toBe(token as string);
		const [before, after] = discordPosts as {
			embeds: { title: string }[];
		}[];
		expect(after?.embeds[0]?.title).toBe(before?.embeds[0]?.title as string);
	});

	test("a manual run on an unrecorded day posts for the first time", async () => {
		stubFetch();
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		const outcome = await postWotd(c, { now: NOW });
		await settle();

		expect(outcome.status).toBe("posted");
		expect(discordPosts).toHaveLength(1);
		expect(db.rows.size).toBe(1);
	});

	test("date: backfills an earlier day, recording that day and dating the embed", async () => {
		stubFetch();
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		const outcome = await postWotd(c, { now: NOW, date: YESTERDAY });
		await settle();

		expect(outcome).toEqual({
			status: "posted",
			token: "utar",
			date: YESTERDAY,
		});
		// The word belongs to 2026-07-02, so the channel post says so instead of
		// claiming to be today's.
		const title = (discordPosts[0] as { embeds: { title: string }[] }).embeds[0]
			?.title;
		expect(title).toContain(YESTERDAY);
		expect(title).not.toContain("今日");
		// Recorded under the backfilled day; today is still open for the cron.
		expect([...db.rows.keys()]).toEqual([YESTERDAY]);
	});

	test("date: repeating a backfilled day reposts its word, keeping the one row", async () => {
		stubFetch();
		const db = new FakeD1();
		const kv = new MemoryKV();

		const first = makeContext(makeEnv(db, kv));
		await postWotd(first.c, { now: NOW, date: YESTERDAY });
		await first.settle();

		const second = makeContext(makeEnv(db, kv));
		expect(await postWotd(second.c, { now: NOW, date: YESTERDAY })).toEqual({
			status: "resent",
			token: "utar",
			date: YESTERDAY,
		});
		await second.settle();

		expect(discordPosts).toHaveLength(2);
		expect([...db.rows.keys()]).toEqual([YESTERDAY]);
		expect([...db.rows.values()][0]?.token).toBe("utar");
	});

	test("skipRecorded: the daily trigger leaves a day that already went out alone", async () => {
		stubFetch();
		const db = new FakeD1();
		const kv = new MemoryKV();

		const first = makeContext(makeEnv(db, kv));
		await postWotd(first.c, { now: NOW, date: YESTERDAY });
		await first.settle();

		const second = makeContext(makeEnv(db, kv));
		expect(
			await postWotd(second.c, {
				now: NOW,
				date: YESTERDAY,
				skipRecorded: true,
			}),
		).toEqual({ status: "already-posted", date: YESTERDAY });
		await second.settle();

		expect(discordPosts).toHaveLength(1);
	});

	test("date: a backfill never repeats a word that has since gone out", async () => {
		stubFetch();
		const db = new FakeD1();
		const kv = new MemoryKV();

		const today = makeContext(makeEnv(db, kv));
		await runWotd(today.c, NOW);
		await today.settle();
		expect([...db.rows.values()][0]?.token).toBe("utar");

		// `utar` is the fixture's only glossary-backed candidate and it is now in
		// the recency window, so the earlier day finds nothing to post rather than
		// repeating it.
		const earlier = makeContext(makeEnv(db, kv));
		const outcome = await postWotd(earlier.c, { now: NOW, date: YESTERDAY });
		await earlier.settle();

		expect(outcome).toEqual({
			status: "skipped",
			reason: "no glossary-backed candidate at all",
		});
		expect(discordPosts).toHaveLength(1);
		expect([...db.rows.keys()]).toEqual([TODAY]);
	});

	test("upstream freq/list failure: caught, logged, no history row written", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith(`${CORPUS_URL}/v1/freq/list`)) {
				return new Response("boom", { status: 500 });
			}
			throw new Error(`unexpected fetch to ${url}`);
		}) as unknown as typeof fetch;

		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		expect(db.rows.size).toBe(0);
	});

	test("Discord post failure (non-2xx): no history row written, safe to retry", async () => {
		discordShouldFail = true;
		stubFetch(); // resets discordPosts only — discordShouldFail stays true
		const db = new FakeD1();
		const { c, settle } = makeContext(makeEnv(db, new MemoryKV()));

		await runWotd(c, NOW);
		await settle();

		// The embed attempt plus the best-effort failure notice.
		expect(discordPosts).toHaveLength(2);
		const notice = discordPosts[1] as { content?: string };
		expect(notice.content).toContain("⚠️");
		expect(db.rows.size).toBe(0); // never recorded as posted
	});
});
