import { afterEach, describe, expect, test } from "bun:test";
import { formatKwicLines } from "../src/handlers/corpus.js";
import { type KwicLine, tokenSentences } from "../src/services/corpus.js";

// Fixture mirrors a trimmed live response from
// `curl "https://corpus.aynu.org/v1/kwic?q=kamuy&ctx=6&limit=2&match=fold"`
// (verified 2026-07-03), keeping only the fields the bot's `KwicLine` types.
// Both lines come from one sentence, as the token layer yields for a sentence
// that uses the word twice.
const fixture: KwicLine[] = [
	{
		sentence_id: "aa-asai/001#15",
		left_text: "a 'orowa taa 'inkara koh 'atuy kaawa sineh poro ",
		node_text: "kamuy",
		right_text: " yan manu.    sine poro kamuy yani ike, アノ hekac",
		text: "a 'orowa taa 'inkara koh 'atuy kaawa sineh poro kamuy yan manu.    sine poro kamuy yani ike, アノ hekaci taa",
		translation:
			"行ってあたりを見ると、海原から一匹の大きなアザラシが上がって来たとさ。",
		dialect: "小田洲",
		author: "浅井 タケ",
		collection: null,
		document: null,
		uri: "http://www.aa.tufs.ac.jp/~mmine/kiki_gen/murasaki/at01aj.html",
	},
	{
		sentence_id: "aa-asai/001#15",
		left_text: "yan manu.    sine poro ",
		node_text: "kamuy",
		right_text: " yani ike, アノ hekaci taa",
		text: "a 'orowa taa 'inkara koh 'atuy kaawa sineh poro kamuy yan manu.    sine poro kamuy yani ike, アノ hekaci taa",
		translation: null,
		dialect: null,
		author: null,
		collection: null,
		document: null,
		uri: null,
	},
];

describe("formatKwicLines", () => {
	test("wraps the node token in brackets", () => {
		const block = formatKwicLines(fixture);
		expect(block).toContain("[kamuy]");
	});

	test("left-aligns every line to the same left-column width", () => {
		const block = formatKwicLines(fixture);
		const lines = block.split("\n");
		expect(lines).toHaveLength(2);
		const leftColWidths = lines.map((line) => line.indexOf("["));
		expect(leftColWidths[0]).toBe(leftColWidths[1]);
	});

	test("collapses multi-space/newline runs from the source text (alignment padding aside)", () => {
		const block = formatKwicLines(fixture);
		for (const line of block.split("\n")) {
			const withoutAlignmentPadding = line.replace(/^ +/, "");
			expect(withoutAlignmentPadding).not.toMatch(/ {2,}/);
		}
	});

	test("truncates an overlong left context with a leading ellipsis instead of overflowing", () => {
		const long: KwicLine = {
			...fixture[0],
			left_text: "x".repeat(100),
		};
		const [line] = formatKwicLines([long]).split("\n");
		const leftCol = line.slice(0, line.indexOf("["));
		expect(leftCol.startsWith("…")).toBe(true);
		expect(leftCol.length).toBeLessThanOrEqual(31); // KWIC_LEFT_WIDTH + trailing space before "["
	});

	test("returns an empty string for no lines", () => {
		expect(formatKwicLines([])).toBe("");
	});
});

describe("tokenSentences", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("one row per sentence, with the sentence's own provenance", async () => {
		let requested = "";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested = String(input);
			return new Response(
				JSON.stringify({
					api_version: "1",
					data: fixture,
					meta: { total: 2, offset: 0, limit: 200 },
				}),
			);
		}) as unknown as typeof fetch;
		const env = { CORPUS_API_URL: "https://corpus.aynu.org" } as Env;

		const rows = await tokenSentences(env, { q: "kamuy", limit: 200 });

		const params = new URL(requested).searchParams;
		expect(params.get("ctx")).toBe("0");
		expect(params.get("match")).toBe("fold");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "aa-asai/001#15",
			text: fixture[0]?.text,
			translation: fixture[0]?.translation,
			dialect: "小田洲",
			author: "浅井 タケ",
			collection: null,
			document: null,
		});
	});
});
