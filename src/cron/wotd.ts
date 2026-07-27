/**
 * Word-of-the-day cron: `app.cron("0 22 * * *", runWotd)` in src/index.ts,
 * triggered `0 22 * * *` (07:00 JST) per wrangler.jsonc, dispatched by
 * explicit cron key. (A second trigger — the message archive crawler — was
 * added alongside this one; a bare `app.cron("", handler)` catch-all would
 * have silently matched both, so both are now registered by their exact
 * cron string.) The whole pick/filter/probe algorithm is decomposed into
 * pure functions (unit-tested in test/wotd-pick.test.ts) around a thin I/O
 * shell (`runWotd`) that:
 *
 *  1. no-ops if `WOTD_CHANNEL_ID` is unset (safe until a post channel is chosen)
 *  2. no-ops if today (JST) already has a `posted=1` row in `wotd_history`
 *  3. sources candidates from `/v1/freq/list`, filters them, deterministically
 *     picks one by `fnv1a(date)`, probing forward for a glossary hit
 *  4. enriches with a glossary gloss, up to 3 whole-word corpus examples from
 *     distinct sources, and all 3 supported scripts
 *  5. posts an embed via the cron context's REST helper, then upserts the
 *     history row — only on a confirmed-successful post, so a failure never
 *     leaves a false "posted" row behind (the next day's run would still
 *     skip ahead, but a *retried* run for the same date is safe either way).
 */
import type { CronContext } from "discord-hono";
import { $channels$_$messages } from "discord-hono";
import { baseEmbed } from "../lib/embeds.js";
import type { AppEnv } from "../lib/errors.js";
import { normalizeAynu, textContainsToken, wotdKey } from "../lib/fold.js";
import { fnv1a } from "../lib/hash.js";
import { truncate } from "../lib/truncate.js";
import { type CorpusRow, freqList, searchCorpus } from "../services/corpus.js";
import {
	type GlossaryEntry,
	type GlossaryTable,
	getGlossary,
	searchGlossary,
} from "../services/glossary.js";
import { type MdbLexemeSearchRow, searchLexemes } from "../services/mdb.js";
import { allScripts, SCRIPT_LABELS, SCRIPTS } from "../services/script.js";

const CANDIDATE_LIMIT = 400;
const CANDIDATE_MIN_COUNT = 5;
const RECENT_WINDOW_DAYS = 180;
const MAX_PROBE = 20;
const EXAMPLE_FETCH_LIMIT = 40;
const EXAMPLE_MAX = 3;
const EXAMPLE_FIELD_MAX = 1024;
const GLOSSARY_LOOKUP_LIMIT = 5;
const MDB_LEXEME_LOOKUP_LIMIT = 20;

// ---------------------------------------------------------------- pure ----

/** Today's date in JST (`Asia/Tokyo`, no DST) as `YYYY-MM-DD`. */
export function jstDateString(now: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

/** `dateStr` (`YYYY-MM-DD`) shifted by `days` (may be negative) — calendar-only, UTC-anchored. */
export function shiftDateString(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

const VALID_TOKEN = /^[\p{L}']+$/u;

/**
 * A token is WOTD-eligible when it's at least 2 chars, carries no affix `=`
 * marker, no digits, and no punctuation other than the apostrophe (used for
 * the Ainu glottal stop, e.g. `ne'ampe`).
 */
export function isCandidateToken(token: string): boolean {
	if (token.length < 2) return false;
	if (token.includes("=")) return false;
	if (/[0-9]/.test(token)) return false;
	if (!VALID_TOKEN.test(token)) return false;
	return true;
}

/**
 * Filters `/v1/freq/list` rows down to eligible, deduplicated, order-preserving
 * candidate tokens, dropping any token posted within the last
 * `RECENT_WINDOW_DAYS` (via `excludeTokens`, a single D1 query result).
 */
export function filterCandidates(
	rows: readonly { token: string }[],
	excludeTokens: ReadonlySet<string>,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const { token } of rows) {
		if (!isCandidateToken(token)) continue;
		if (excludeTokens.has(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

/** Deterministic daily index into `candidates` — same date always picks the same slot. */
export function pickIndex(dateStr: string, candidateCount: number): number {
	if (candidateCount <= 0) {
		throw new Error("pickIndex: candidateCount must be > 0");
	}
	return fnv1a(dateStr) % candidateCount;
}

export interface ProbeResult {
	token: string;
	index: number;
	hasGloss: boolean;
}

/**
 * Starting at `startIndex`, probes forward (wrapping) through `candidates`
 * for the first token with a glossary hit, giving up after `maxProbe`
 * attempts (or the full candidate list, whichever is smaller). Falls back to
 * the original hash pick — with `hasGloss: false` — when none is found.
 * `hasGlossaryHit` is injected so this stays pure/fixture-testable.
 */
export function probeForGlossaryHit(
	candidates: readonly string[],
	startIndex: number,
	hasGlossaryHit: (token: string) => boolean,
	maxProbe: number = MAX_PROBE,
): ProbeResult {
	const n = candidates.length;
	const probes = Math.min(maxProbe, n);
	for (let step = 0; step < probes; step++) {
		const index = (startIndex + step) % n;
		const token = candidates[index];
		if (token !== undefined && hasGlossaryHit(token)) {
			return { token, index, hasGloss: true };
		}
	}
	const index = startIndex % n;
	// biome-ignore lint/style/noNonNullAssertion: index is derived from n = candidates.length > 0 (pickIndex throws otherwise)
	return { token: candidates[index]!, index, hasGloss: false };
}

/**
 * Sentence-id prefixes (the collection slug before the first `/`) of corpus
 * collections whose Ainu text is composed by modern writers — learner
 * magazines, textbooks, institutional statements, SNS, translations — rather
 * than recorded or written by native speakers. These rank after native
 * attestations when picking examples. Unknown prefixes default to native.
 */
const MODERN_SOURCE_PREFIXES: ReadonlySet<string> = new Set([
	"ainu-times",
	"akor-itak",
	"bible",
	"bunpaku-2026",
	"express-cd",
	"express-new",
	"express-special",
	"hokudai-respect",
	"ota-mondai",
	"pilsudski",
	"prague",
	"upopoy-dict",
	"upopoy-exhibits",
	"upopoy-staffs",
	"x-social",
	"zaidan-benron",
	"zaidan-radio",
	"zaidan-textbooks",
]);

/** 0 = native-speaker attestation, 1 = modern composed text. */
export function exampleSourceTier(row: CorpusRow): number {
	const slash = row.id.indexOf("/");
	const slug = slash === -1 ? row.id : row.id.slice(0, slash);
	return MODERN_SOURCE_PREFIXES.has(slug) ? 1 : 0;
}

/**
 * A row's source identity for diversity: dialect + document, falling back to
 * collection. The separator stays in the key so a dialect-only "X" and a
 * document-only "X" remain distinct sources; rows with no metadata at all
 * share one key (capped at one diversity slot — the fallback pass in
 * selectExamples still fills remaining slots from them).
 */
function exampleSourceKey(row: CorpusRow): string {
	return [row.dialect ?? "", row.document ?? row.collection ?? ""].join("\t");
}

/**
 * Up to `max` example rows for `token`: only rows whose text contains `token`
 * as a whole word (the corpus search endpoint matches substrings, so `pet`
 * would otherwise surface `Yeepeta'usnaypo`) and that carry a non-empty
 * translation. Native-speaker attestations rank before modern composed texts
 * (`exampleSourceTier`), shorter sentences before longer within a tier, and
 * rows from a dialect+document already represented are deferred until every
 * distinct source has one example, so a single narrator's tales don't fill
 * the slate.
 */
export function selectExamples(
	rows: readonly CorpusRow[],
	token: string,
	max: number = EXAMPLE_MAX,
): CorpusRow[] {
	const usable = rows
		.filter((row) => row.translation != null && row.translation.trim() !== "")
		.filter((row) => tokenAppearsInExample(row, token))
		.sort(
			(a, b) =>
				exampleSourceTier(a) - exampleSourceTier(b) ||
				a.text.length - b.text.length,
		);
	const picked: CorpusRow[] = [];
	const seenSources = new Set<string>();
	// Text-level dedup happens inside the pick loops (never before them): the
	// same formulaic sentence can appear in several documents, and the copy
	// from a not-yet-represented source is the one worth keeping.
	const seenTexts = new Set<string>();
	for (const row of usable) {
		if (picked.length >= max) break;
		const key = exampleSourceKey(row);
		const folded = normalizeAynu(row.text);
		if (seenSources.has(key) || seenTexts.has(folded)) continue;
		seenSources.add(key);
		seenTexts.add(folded);
		picked.push(row);
	}
	for (const row of usable) {
		if (picked.length >= max) break;
		const folded = normalizeAynu(row.text);
		if (seenTexts.has(folded)) continue;
		seenTexts.add(folded);
		picked.push(row);
	}
	return picked;
}

/** The glossary row whose `Aynu` field exactly matches `token` (accent/case-insensitive), if any. */
export function glossaryExactEntry(
	table: GlossaryTable,
	token: string,
): GlossaryEntry | undefined {
	const target = normalizeAynu(token);
	return searchGlossary(table, token, GLOSSARY_LOOKUP_LIMIT).find(
		(entry) => entry.Aynu !== undefined && normalizeAynu(entry.Aynu) === target,
	);
}

export interface WotdLexemeSelection {
	lexeme: MdbLexemeSearchRow | undefined;
	ambiguous: boolean;
}

interface WotdSelection {
	token: string;
	entry: GlossaryEntry | undefined;
	examples: CorpusRow[];
	lexeme: MdbLexemeSearchRow | undefined;
}

/** Exact canonical lexeme rows for a corpus token, preserving homograph splits. */
export function exactLexemeRows(
	rows: readonly MdbLexemeSearchRow[],
	token: string,
): MdbLexemeSearchRow[] {
	const target = wotdKey(token);
	return rows.filter((row) => {
		const forms = [row.lemma, ...row.variations.map((v) => v.surface)];
		return forms.some((form) => wotdKey(form) === target);
	});
}

function isProperNameLexeme(row: MdbLexemeSearchRow): boolean {
	// `lemma[0] === lemma[0].toUpperCase()` was true for ANY caseless first
	// char (apostrophe ’, digit, kana) — wrongly excluding those lemmas as
	// proper names. Require an actual uppercase-letter initial instead.
	return row.pos === "propn" || /^\p{Lu}/u.test(row.lemma);
}

function tokenAppearsInExample(
	row: CorpusRow | undefined,
	token: string,
): boolean {
	if (!row) return false;
	return textContainsToken(row.text, token);
}

// Match Han, Katakana and Hiragana runs *separately* (never merged), so a
// single-Han term like 薪 stays isolated instead of being swallowed into a
// mixed Han+hiragana run such as 薪を採る. Hiragana runs are included so
// glosses like こねつぶす (the nina "mash/knead" sense) can context-match at
// all — the old Han/Katakana-only regex silently killed that sense.
const GLOSS_TERM_RUNS: readonly RegExp[] = [
	/\p{Script=Han}+/gu,
	/[\p{Script=Katakana}ー]+/gu,
	/\p{Script=Hiragana}+/gu,
];

function lexemeMatchesExampleContext(
	row: MdbLexemeSearchRow,
	examples: readonly CorpusRow[],
): boolean {
	const text = examples
		.map((ex) => `${ex.text}\n${ex.translation ?? ""}`)
		.join("\n");
	if (!text.trim()) return false;
	for (const gloss of [...row.gloss_jp, ...row.gloss_en]) {
		for (const re of GLOSS_TERM_RUNS) {
			for (const term of gloss.match(re) ?? []) {
				// A single Han character carries meaning (corpus translations often
				// say just 薪); hiragana needs >= 3 chars — 2-char runs like する
				// or して are grammatical filler matching almost any translation.
				const min = re.source.includes("Han")
					? 1
					: re.source.includes("Hiragana")
						? 3
						: 2;
				if (term.length < min) continue;
				if (text.includes(term)) return true;
			}
		}
	}
	return false;
}

/**
 * Pick one MDB lexeme for the WOTD token. Ambiguous bare homographs are skipped
 * unless the example/query context can safely choose a non-proper-name sense.
 */
export function selectWotdLexeme(
	token: string,
	rows: readonly MdbLexemeSearchRow[],
	examples: readonly CorpusRow[],
): WotdLexemeSelection {
	const exact = exactLexemeRows(rows, token).filter((row) => !row.bound);
	if (exact.length === 0) return { lexeme: undefined, ambiguous: false };

	// Corpus frequency tokens are lowercase common words in practice. Do not let
	// a proper-name row (e.g. Nina 荷菜) satisfy a lowercase WOTD unless the token
	// and example explicitly use that capitalized form.
	const commonRows = exact.filter((row) => !isProperNameLexeme(row));
	const properRows = exact.filter((row) => isProperNameLexeme(row));
	if (commonRows.length === 0) {
		const proper = properRows.find(
			(row) =>
				row.lemma === token &&
				examples.some((ex) => tokenAppearsInExample(ex, row.lemma)),
		);
		return proper
			? { lexeme: proper, ambiguous: false }
			: { lexeme: undefined, ambiguous: true };
	}

	// Pool all examples first — a sense picked here must be attested somewhere
	// in the slate, so a coincidental hit in one sentence can't decide alone.
	// When several senses match the pool (each via a different sentence), the
	// primary (first-ranked, shown first) example breaks the tie; if it can't,
	// the homograph really is ambiguous.
	const pooled = commonRows.filter((row) =>
		lexemeMatchesExampleContext(row, examples),
	);
	if (pooled.length === 1) {
		return { lexeme: pooled[0], ambiguous: false };
	}
	if (pooled.length > 1) {
		const byPrimary = pooled.filter((row) =>
			lexemeMatchesExampleContext(row, examples.slice(0, 1)),
		);
		if (byPrimary.length === 1) {
			return { lexeme: byPrimary[0], ambiguous: false };
		}
		return { lexeme: undefined, ambiguous: true };
	}
	if (commonRows.length === 1) {
		return { lexeme: commonRows[0], ambiguous: false };
	}

	return { lexeme: undefined, ambiguous: true };
}

/**
 * Drops examples that context-match a rival homograph sense while not matching
 * the selected one, so a post never shows a sentence under the wrong meaning.
 * Examples with no decidable context are kept.
 */
export function filterExamplesBySense(
	examples: readonly CorpusRow[],
	lexeme: MdbLexemeSearchRow | undefined,
	rows: readonly MdbLexemeSearchRow[],
	token: string,
): CorpusRow[] {
	if (!lexeme) return [...examples];
	// Mirror selectWotdLexeme's candidate rules: proper-name homographs are
	// excluded there, so they must not act as rivals here either.
	const rivals = exactLexemeRows(rows, token).filter(
		(row) => !row.bound && row.id !== lexeme.id && !isProperNameLexeme(row),
	);
	if (rivals.length === 0) return [...examples];
	// When every example belongs to a rival sense, an empty result is correct —
	// the embed renders "—" instead of a sentence under the wrong meaning.
	return examples.filter(
		(ex) =>
			lexemeMatchesExampleContext(lexeme, [ex]) ||
			!rivals.some((rival) => lexemeMatchesExampleContext(rival, [ex])),
	);
}

function scriptsFieldValue(token: string): string {
	const { scripts } = allScripts(token);
	return SCRIPTS.map((s) => `${SCRIPT_LABELS[s]}: ${scripts[s]}`).join("\n");
}

function formatExample(row: CorpusRow): string {
	// The footer mirrors exampleSourceKey's fallback: a collection-only row
	// still shows what distinguishes it from the other examples.
	const source = [row.dialect, row.document ?? row.collection]
		.filter(Boolean)
		.join(" · ");
	return `${row.text}\n${row.translation}\n-# ${source || "—"}`;
}

/** Joins as many examples as fit Discord's 1024-char field limit, at least one. */
export function exampleFieldValue(rows: readonly CorpusRow[]): string {
	if (rows.length === 0) return "—";
	const parts: string[] = [];
	for (const row of rows) {
		const formatted = formatExample(row);
		const next = [...parts, formatted].join("\n\n");
		// Skip an oversized example — even a first one — and keep scanning: a
		// later, shorter example may still fit whole.
		if (next.length > EXAMPLE_FIELD_MAX) continue;
		parts.push(formatted);
	}
	if (parts.length > 0) return parts.join("\n\n");
	// Every example alone exceeds the limit — truncate the first.
	// biome-ignore lint/style/noNonNullAssertion: rows.length > 0 is checked above.
	return truncate(formatExample(rows[0]!), EXAMPLE_FIELD_MAX);
}

/** Pure embed builder — the only non-pure step left is `.toJSON()` at the call site (none here). */
function lexemeMeaning(
	lexeme: MdbLexemeSearchRow | undefined,
): string | undefined {
	if (!lexeme) return undefined;
	return (
		[lexeme.gloss_jp[0], lexeme.gloss_en[0]].filter(Boolean).join(" · ") ||
		undefined
	);
}

export function wotdEmbed(
	token: string,
	entry: GlossaryEntry | undefined,
	examples: readonly CorpusRow[],
	lexeme?: MdbLexemeSearchRow,
) {
	const meaning =
		lexemeMeaning(lexeme) ??
		(entry
			? [entry.日本語, entry.English].filter(Boolean).join(" · ") || "—"
			: "（辞書未登録 / not yet in the glossary）");
	return baseEmbed("corpus.aynu.org · itak.aynu.org")
		.title(`📅 今日のアイヌ語 / Word of the day: ${token}`)
		.fields(
			{ name: "意味 / Meaning", value: meaning },
			{ name: "表記 / Scripts", value: scriptsFieldValue(token) },
			{ name: "例文 / Example", value: exampleFieldValue(examples) },
		);
}

// ---------------------------------------------------------------- I/O ----

async function alreadyPostedToday(
	db: D1Database,
	date: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT posted FROM wotd_history WHERE date = ?")
		.bind(date)
		.first<{ posted: number }>();
	return row?.posted === 1;
}

async function recentTokens(
	db: D1Database,
	since: string,
): Promise<Set<string>> {
	const { results } = await db
		.prepare("SELECT token FROM wotd_history WHERE date >= ?")
		.bind(since)
		.all<{ token: string }>();
	return new Set(results.map((r) => r.token));
}

async function upsertPosted(
	db: D1Database,
	date: string,
	token: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO wotd_history (date, token, posted) VALUES (?, ?, 1)
			 ON CONFLICT(date) DO UPDATE SET token = excluded.token, posted = excluded.posted`,
		)
		.bind(date, token)
		.run();
}

/**
 * The cron handler itself. Any thrown error (upstream API down, Discord post
 * failed, …) is caught and logged — never rethrown — since there's no
 * interaction to reply to; the history row is only written after a confirmed
 * successful post, so a failed run always retries safely next time.
 *
 * `now` defaults to the real clock; tests inject a fixed `Date` so the JST
 * date (and therefore the deterministic hash pick) is reproducible.
 */
export async function runWotd(
	c: CronContext<AppEnv>,
	now: Date = new Date(),
): Promise<void> {
	const channelId = c.env.WOTD_CHANNEL_ID;
	if (!channelId) {
		console.warn("[wotd] WOTD_CHANNEL_ID is empty — skipping (safe no-op)");
		return;
	}

	const db = c.env.DB;
	const today = jstDateString(now);

	try {
		if (await alreadyPostedToday(db, today)) {
			console.log(`[wotd] ${today} already posted — no-op`);
			return;
		}

		const rows = await freqList(c.env, {
			limit: CANDIDATE_LIMIT,
			includeStopwords: false,
			minCount: CANDIDATE_MIN_COUNT,
		});
		const excluded = await recentTokens(
			db,
			shiftDateString(today, -RECENT_WINDOW_DAYS),
		);
		const candidates = filterCandidates(rows, excluded);
		if (candidates.length === 0) {
			console.error("[wotd] no eligible candidates after filtering — skipping");
			return;
		}

		const table = await getGlossary(c.env, c.executionCtx);
		const startIndex = pickIndex(today, candidates.length);
		let selected: WotdSelection | undefined;
		// First glossary-backed candidate whose MDB lexemes were ambiguous —
		// used as a fallback (glossary gloss only) so an all-ambiguous day still
		// posts instead of being silently skipped.
		let ambiguousFallback: WotdSelection | undefined;
		const probes = Math.min(MAX_PROBE, candidates.length);
		for (let step = 0; step < probes; step++) {
			const index = (startIndex + step) % candidates.length;
			// biome-ignore lint/style/noNonNullAssertion: index is derived from candidates.length > 0.
			const token = candidates[index]!;
			const entry = glossaryExactEntry(table, token);
			if (!entry) continue;

			const exampleRows = await searchCorpus(c.env, {
				q: token,
				lang: "ain",
				limit: EXAMPLE_FETCH_LIMIT,
			});
			const examples = selectExamples(exampleRows, token);
			const lexemeRows = await searchLexemes(
				c.env,
				token,
				MDB_LEXEME_LOOKUP_LIMIT,
			);
			const { lexeme, ambiguous } = selectWotdLexeme(
				token,
				lexemeRows.results,
				examples,
			);
			if (ambiguous) {
				console.warn(
					`[wotd] ${token} has ambiguous MDB lexemes — probing next`,
				);
				if (!ambiguousFallback) {
					// Remember the first ambiguous candidate: glossary gloss only.
					ambiguousFallback = { token, entry, examples, lexeme: undefined };
				}
				continue;
			}
			selected = {
				token,
				entry,
				examples: filterExamplesBySense(
					examples,
					lexeme,
					lexemeRows.results,
					token,
				),
				lexeme,
			};
			break;
		}
		if (!selected) {
			if (ambiguousFallback) {
				console.warn(
					`[wotd] ${ambiguousFallback.token}: MDB enrichment skipped due to homograph ambiguity — posting glossary gloss only`,
				);
				selected = ambiguousFallback;
			} else {
				console.warn("[wotd] no glossary-backed candidate at all — skipping");
				return;
			}
		}

		const res = await c.rest("POST", $channels$_$messages, [channelId], {
			embeds: [
				wotdEmbed(
					selected.token,
					selected.entry,
					selected.examples,
					selected.lexeme,
				).toJSON(),
			],
		});
		if (!res.ok) {
			throw new Error(`Discord post failed: HTTP ${res.status}`);
		}

		await upsertPosted(db, today, selected.token);
	} catch (err) {
		console.error(
			"[wotd] run failed — no history row written, will retry",
			err,
		);
		// Surface the failure in the WOTD channel itself — an unnoticed missing
		// post is worse than one error line. Best-effort: if Discord itself is
		// what failed, this may fail too, and the console line above remains.
		try {
			const message = err instanceof Error ? err.message : String(err);
			await c.rest("POST", $channels$_$messages, [channelId], {
				content: `⚠️ 今日のアイヌ語の投稿に失敗しました。次回の実行で再試行します。 / Word-of-the-day failed and will retry on the next run.\n-# ${truncate(message, 200)}`,
			});
		} catch (reportErr) {
			console.error("[wotd] failure report also failed", reportErr);
		}
	}
}
