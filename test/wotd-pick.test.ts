import { describe, expect, test } from "bun:test";
import {
	exactLexemeRows,
	exampleFieldValue,
	filterCandidates,
	filterExamplesByMeaning,
	filterExamplesBySense,
	glossaryExactEntry,
	isCandidateToken,
	jstDateString,
	pickIndex,
	probeForGlossaryHit,
	rankGlosses,
	selectExamples,
	selectWotdSense,
	shiftDateString,
	wotdEmbed,
} from "../src/cron/wotd.js";
import { fnv1a } from "../src/lib/hash.js";
import type { CorpusRow } from "../src/services/corpus.js";
import type { GlossaryEntry } from "../src/services/glossary.js";
import type { MdbLexemeSearchRow } from "../src/services/mdb.js";

describe("fnv1a — FNV-1a 32-bit", () => {
	// Canonical FNV-1a-32 test vectors (http://www.isthe.com/chongo/src/fnv/test_fnv.c).
	test("matches canonical test vectors", () => {
		expect(fnv1a("")).toBe(2166136261);
		expect(fnv1a("a")).toBe(3826002220);
		expect(fnv1a("b")).toBe(3876335077);
		expect(fnv1a("c")).toBe(3859557458);
		expect(fnv1a("foobar")).toBe(3214735720);
	});

	test("is deterministic — same input always yields the same hash", () => {
		expect(fnv1a("2026-07-03")).toBe(fnv1a("2026-07-03"));
	});

	test("different dates hash differently (no obvious collision for adjacent days)", () => {
		expect(fnv1a("2026-07-03")).not.toBe(fnv1a("2026-07-04"));
	});

	test("returns an unsigned 32-bit integer", () => {
		for (const s of ["", "x", "a long string with spaces", "アイヌ"]) {
			const h = fnv1a(s);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThanOrEqual(0xffffffff);
			expect(Number.isInteger(h)).toBe(true);
		}
	});
});

describe("jstDateString / shiftDateString", () => {
	test("formats as YYYY-MM-DD in JST (UTC+9)", () => {
		// 2026-07-03T15:00:00Z = 2026-07-04T00:00:00+09:00
		expect(jstDateString(new Date("2026-07-03T15:00:00Z"))).toBe("2026-07-04");
		// 2026-07-03T14:59:00Z = 2026-07-03T23:59:00+09:00 (still the 3rd)
		expect(jstDateString(new Date("2026-07-03T14:59:00Z"))).toBe("2026-07-03");
	});

	test("shiftDateString moves forward and backward across month/year boundaries", () => {
		expect(shiftDateString("2026-07-03", -180)).toBe("2026-01-04");
		expect(shiftDateString("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftDateString("2026-07-03", 0)).toBe("2026-07-03");
		expect(shiftDateString("2026-07-03", 1)).toBe("2026-07-04");
	});
});

describe("isCandidateToken", () => {
	test("accepts plain lowercase Ainu tokens", () => {
		expect(isCandidateToken("kamuy")).toBe(true);
		expect(isCandidateToken("utar")).toBe(true);
	});

	test("accepts the apostrophe (glottal stop), e.g. ne'ampe", () => {
		expect(isCandidateToken("ne'ampe")).toBe(true);
	});

	test("accepts accented Latin letters (dialect orthographies), e.g. néno", () => {
		expect(isCandidateToken("néno")).toBe(true);
	});

	test("rejects tokens shorter than 2 chars", () => {
		expect(isCandidateToken("e")).toBe(false);
		expect(isCandidateToken("")).toBe(false);
	});

	test("rejects tokens containing an affix `=` marker", () => {
		expect(isCandidateToken("ku=oyra")).toBe(false);
	});

	test("rejects tokens containing digits", () => {
		expect(isCandidateToken("word2")).toBe(false);
		expect(isCandidateToken("2026")).toBe(false);
	});

	test("rejects tokens with other punctuation", () => {
		expect(isCandidateToken("foo-bar")).toBe(false);
		expect(isCandidateToken("foo.bar")).toBe(false);
		expect(isCandidateToken("foo,bar")).toBe(false);
	});
});

describe("filterCandidates", () => {
	test("drops ineligible tokens (short/=/digits/punctuation) and dedupes", () => {
		const rows = [
			{ token: "kamuy" },
			{ token: "e" }, // too short
			{ token: "ku=oyra" }, // affix marker
			{ token: "word2" }, // digit
			{ token: "kamuy" }, // duplicate
			{ token: "utar" },
		];
		expect(filterCandidates(rows, new Set())).toEqual(["kamuy", "utar"]);
	});

	test("excludes tokens posted within the recent window", () => {
		const rows = [{ token: "kamuy" }, { token: "utar" }, { token: "sinep" }];
		expect(filterCandidates(rows, new Set(["utar"]))).toEqual([
			"kamuy",
			"sinep",
		]);
	});

	test("preserves the input order of the surviving tokens", () => {
		const rows = [{ token: "c" }, { token: "aa" }, { token: "bb" }];
		expect(filterCandidates(rows, new Set())).toEqual(["aa", "bb"]);
	});

	test("returns [] when every row is filtered out", () => {
		const rows = [{ token: "e" }, { token: "1" }, { token: "a=b" }];
		expect(filterCandidates(rows, new Set())).toEqual([]);
	});
});

describe("pickIndex", () => {
	test("is deterministic for a fixed date and candidate count", () => {
		expect(pickIndex("2026-07-03", 37)).toBe(pickIndex("2026-07-03", 37));
	});

	test("always lands within [0, candidateCount)", () => {
		for (let n = 1; n <= 50; n++) {
			const idx = pickIndex("2026-07-03", n);
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThan(n);
		}
	});

	test("matches fnv1a(date) % candidateCount directly", () => {
		expect(pickIndex("2026-07-03", 400)).toBe(fnv1a("2026-07-03") % 400);
	});

	test("throws for a non-positive candidate count", () => {
		expect(() => pickIndex("2026-07-03", 0)).toThrow();
	});
});

describe("probeForGlossaryHit", () => {
	const candidates = ["aa", "bb", "cc", "dd", "ee"];

	test("returns the start candidate immediately when it already has a hit", () => {
		const result = probeForGlossaryHit(candidates, 0, (t) => t === "aa");
		expect(result).toEqual({ token: "aa", index: 0, hasGloss: true });
	});

	test("probes forward to the first token with a hit", () => {
		const result = probeForGlossaryHit(candidates, 1, (t) => t === "dd");
		expect(result).toEqual({ token: "dd", index: 3, hasGloss: true });
	});

	test("wraps around the end of the candidate list", () => {
		// start at "dd" (index 3); only "bb" (index 1) has a hit — must wrap.
		const result = probeForGlossaryHit(candidates, 3, (t) => t === "bb");
		expect(result).toEqual({ token: "bb", index: 1, hasGloss: true });
	});

	test("falls back to the original hash pick when no hit is found within maxProbe", () => {
		const result = probeForGlossaryHit(candidates, 2, () => false);
		expect(result).toEqual({ token: "cc", index: 2, hasGloss: false });
	});

	test("never probes further than maxProbe attempts", () => {
		const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
		let calls = 0;
		const result = probeForGlossaryHit(
			many,
			0,
			(t) => {
				calls++;
				return t === "t50"; // outside the default 20-probe window from index 0
			},
			20,
		);
		expect(result.hasGloss).toBe(false);
		expect(calls).toBe(20);
	});

	test("never probes more times than the candidate list is long", () => {
		let calls = 0;
		probeForGlossaryHit(candidates, 0, () => {
			calls++;
			return false;
		});
		expect(calls).toBe(candidates.length);
	});
});

describe("glossaryExactEntry", () => {
	const table: GlossaryEntry[] = [
		{ Aynu: "sínep", 日本語: "一つ", English: "one", sheetName: "numbers" },
		{ Aynu: "sinep tuye", 日本語: "一つ切る", sheetName: "numbers" },
		{ 日本語: "アイヌ語なし", sheetName: "misc" },
	];

	test("finds an exact (accent/case-insensitive) Aynu match", () => {
		expect(glossaryExactEntry(table, "sinep")?.日本語).toBe("一つ");
		expect(glossaryExactEntry(table, "SINEP")?.日本語).toBe("一つ");
	});

	test("does not match a mere prefix/substring as 'exact'", () => {
		// searchGlossary would surface "sinep tuye" as a *prefix* match for the
		// query "sinep tuy" (missing the final "e") — glossaryExactEntry must
		// still reject it, since the folded strings aren't equal.
		expect(glossaryExactEntry(table, "sinep tuy")).toBeUndefined();
	});

	test("returns undefined when there is no glossary entry at all", () => {
		expect(glossaryExactEntry(table, "nonexistentword")).toBeUndefined();
	});
});

/** A lexeme search whose window held every matching row. */
const wholeLookup = (rows: readonly MdbLexemeSearchRow[]) => ({
	results: rows,
	total: rows.length,
});

describe("MDB lexeme selection for WOTD", () => {
	const lexeme = (
		partial: Partial<MdbLexemeSearchRow> &
			Pick<MdbLexemeSearchRow, "id" | "lemma">,
	): MdbLexemeSearchRow => ({
		kana: "",
		pos: "n",
		gloss_en: [],
		gloss_jp: [],
		bound: false,
		dialects: [],
		variations: [],
		recordings: 0,
		morphemes: [],
		...partial,
	});

	const example = (text: string, translation: string): CorpusRow => ({
		id: "s1",
		text,
		translation,
		dialect: "沙流",
		author: null,
		collection: null,
		document: null,
		uri: null,
	});

	test("exact lexeme rows treat accented/numbered nina variants as one token key", () => {
		const rows = [
			lexeme({ id: "nina.vi", lemma: "nina¹" }),
			lexeme({ id: "nina.vt", lemma: "nina²" }),
			lexeme({ id: "ninasamampe.n", lemma: "ninasamampe" }),
		];
		expect(exactLexemeRows(rows, "nína").map((r) => r.id)).toEqual([
			"nina.vi",
			"nina.vt",
		]);
	});

	test("a variation surface matches the token key", () => {
		const rows = [
			lexeme({
				id: "uenewsar.vi",
				lemma: "uenewsar",
				variations: [{ surface: "uwenewsar", dialects: [] }],
			}),
		];
		expect(exactLexemeRows(rows, "uwenewsar").map((r) => r.id)).toEqual([
			"uenewsar.vi",
		]);
	});

	test("nina firewood example selects the firewood verb, not place/fish senses", () => {
		const rows = [
			lexeme({
				id: "nina.vi",
				lemma: "nina¹",
				pos: "vi",
				gloss_jp: ["薪を採る；日常生活においてはおもに女性の仕事である"],
				gloss_en: ["gather firewood"],
			}),
			lexeme({
				id: "nina.vt",
				lemma: "nina²",
				pos: "vt",
				gloss_jp: ["～をこねつぶす"],
			}),
			lexeme({
				id: "nina.n",
				lemma: "nina",
				pos: "n",
				gloss_jp: ["ヒラメ"],
			}),
			lexeme({
				id: "nina.propn",
				lemma: "Nina",
				pos: "propn",
				gloss_jp: ["荷菜"],
			}),
		];
		const sense = selectWotdSense("nina", wholeLookup(rows), [
			example("semas nina poka suke poka", "粗末な薪でも料理でも"),
		]);
		expect(sense).toEqual({ kind: "resolved", lexeme: rows[0] });
	});

	test("nina mash-context example selects the mash verb (hiragana gloss こねつぶす)", () => {
		const rows = [
			lexeme({
				id: "nina.vi",
				lemma: "nina¹",
				pos: "vi",
				gloss_jp: ["薪を採る"],
			}),
			lexeme({
				id: "nina.vt",
				lemma: "nina²",
				pos: "vt",
				gloss_jp: ["～をこねつぶす"],
			}),
			lexeme({ id: "nina.n", lemma: "nina", pos: "n", gloss_jp: ["ヒラメ"] }),
			lexeme({
				id: "nina.propn",
				lemma: "Nina",
				pos: "propn",
				gloss_jp: ["荷菜"],
			}),
		];
		const sense = selectWotdSense("nina", wholeLookup(rows), [
			example("kem nina", "筋子をこねつぶす"),
		]);
		expect(sense).toEqual({ kind: "resolved", lexeme: rows[1] });
	});

	test("lemma with a caseless first char (apostrophe) is NOT a proper name", () => {
		// A lemma like ’itak / 'itak starts with a caseless apostrophe; the old
		// toUpperCase() check wrongly treated it as a proper name and dropped it.
		const rows = [
			lexeme({
				id: "itak.vi",
				lemma: "’itak",
				pos: "vi",
				gloss_jp: ["話す"],
			}),
		];
		const sense = selectWotdSense("’itak", wholeLookup(rows), [
			example("’itak", "話す"),
		]);
		expect(sense).toEqual({ kind: "resolved", lexeme: rows[0] });
	});

	test("ambiguous bare homograph is skipped when context cannot choose a sense", () => {
		const sense = selectWotdSense(
			"nina",
			wholeLookup([
				lexeme({
					id: "nina.vi",
					lemma: "nina¹",
					pos: "vi",
					gloss_jp: ["薪を採る"],
				}),
				lexeme({ id: "nina.n", lemma: "nina", pos: "n", gloss_jp: ["ヒラメ"] }),
			]),
			[example("nina ne.", "それである。")],
		);
		expect(sense).toEqual({ kind: "unresolved", reason: "ambiguous" });
	});

	test("no exact row in a whole window means MDB does not carry the token", () => {
		const sense = selectWotdSense(
			"tap",
			wholeLookup([lexeme({ id: "tapan.adn", lemma: "tapan" })]),
			[example("tap ne na.", "こうなんだよ。")],
		);
		expect(sense).toEqual({ kind: "unresolved", reason: "absent" });
	});

	// `tap` sits at ranks 56–156 of the 199 rows matching the substring, so the
	// senses that decide the day's meaning were never in the window at all.
	test("no exact row in a truncated window means the senses are unknown", () => {
		const sense = selectWotdSense(
			"tap",
			{ results: [lexeme({ id: "tapan.adn", lemma: "tapan" })], total: 199 },
			[example("tap ne na.", "こうなんだよ。")],
		);
		expect(sense).toEqual({ kind: "unresolved", reason: "truncated" });
	});

	test("a truncated window cannot resolve even the exact row it did return", () => {
		const sense = selectWotdSense(
			"ku",
			{
				results: [lexeme({ id: "ku.n", lemma: "ku", gloss_jp: ["弓"] })],
				total: 1541,
			},
			[example("ku ani", "弓で")],
		);
		expect(sense).toEqual({ kind: "unresolved", reason: "truncated" });
	});

	test("a parenthesised aside is no evidence that a sense is attested", () => {
		// tap.n glosses 「(人や動物の)肩」; the 人 of that aside matched
		// 「親戚の人たちに子が多くても」 and headlined the day's word as 肩.
		const rows = [
			lexeme({
				id: "tap.n",
				lemma: "tap",
				gloss_jp: ["(人や動物の)肩", "これ"],
			}),
			lexeme({
				id: "tap.adv",
				lemma: "tap",
				pos: "adv",
				gloss_jp: ["いましがた､ たった今"],
			}),
		];
		const sense = selectWotdSense("tap", wholeLookup(rows), [
			example(
				"irwak utari tap irwak utari pókoinne pa yakka,",
				"親戚の人たちに子が多くても、",
			),
		]);
		expect(sense).toEqual({ kind: "unresolved", reason: "ambiguous" });
	});
});

describe("filterExamplesByMeaning", () => {
	const example = (text: string, translation: string): CorpusRow => ({
		id: text,
		text,
		translation,
		dialect: "沙流",
		author: null,
		collection: null,
		document: null,
		uri: null,
	});

	// The three sentences posted under tap 今し方 all used the 「こう」 sense.
	test("drops sentences that do not show the glossary meaning", () => {
		const examples = [
			example("aoká ka tap nispa eepakki a=ne wa,", "私たちもこのように"),
			example("néno an pe tap ne na.", "そういうものがこうなんだよ"),
		];
		expect(
			filterExamplesByMeaning(examples, ["今し方、たった今", "right now"]),
		).toEqual([]);
	});

	test("keeps a sentence whose translation carries a term of the meaning", () => {
		const kept = example("tanto tap ek.", "今日たった今来た。");
		expect(
			filterExamplesByMeaning(
				[kept, example("tap ne na.", "こうなんだよ。")],
				["今し方、たった今", "right now"],
			),
		).toEqual([kept]);
	});

	test("matches an English-only meaning against the translation, not the Ainu text", () => {
		// "nukar" would otherwise attest a gloss reading "to nurture".
		const meanings = ["", "a whetstone"];
		const ainuOnly = example("nukar wa", "見た");
		const attested = example("tap nukar", "looked at the whetstone");
		expect(filterExamplesByMeaning([ainuOnly, attested], meanings)).toEqual([
			attested,
		]);
	});

	test("a meaning with nothing to check keeps no example", () => {
		expect(
			filterExamplesByMeaning([example("tap ne", "こうだ")], ["", "  "]),
		).toEqual([]);
	});
});

describe("selectExamples", () => {
	const row = (
		partial: Partial<CorpusRow> & Pick<CorpusRow, "text">,
	): CorpusRow => ({
		id: "id",
		translation: "訳",
		dialect: null,
		author: null,
		collection: null,
		document: null,
		uri: null,
		...partial,
	});

	test("keeps only rows containing the token as a whole word", () => {
		const rows = [
			row({ text: "Yeepeta'usnaypo." }),
			row({ text: "pet or ta san" }),
			row({ text: "petpo ka ta" }),
		];
		expect(selectExamples(rows, "pet").map((r) => r.text)).toEqual([
			"pet or ta san",
		]);
	});

	test("matches the token accent-, case- and apostrophe-insensitively", () => {
		const rows = [row({ text: "hoski 'oman nanna" })];
		expect(selectExamples(rows, "hoski")).toHaveLength(1);
		expect(selectExamples(rows, "HOSKI")).toHaveLength(1);
		expect(selectExamples(rows, "’oman")).toHaveLength(1);
		expect(selectExamples(rows, "oman")).toHaveLength(1);
		expect(selectExamples([row({ text: "sínep ne" })], "sinep")).toHaveLength(
			1,
		);
	});

	test("matches NFD-decomposed corpus text (combining accents are not word breaks)", () => {
		// í as i + U+0301 — the splitter must not break sínep at the accent.
		expect(
			selectExamples([row({ text: "si\u0301nep ne" })], "sinep"),
		).toHaveLength(1);
	});

	test("an all-punctuation token never matches (empty fold guard)", () => {
		expect(selectExamples([row({ text: "hoski." })], "''")).toEqual([]);
	});

	test("drops rows repeating an already-picked sentence text", () => {
		const rows = [
			row({ text: "pet or ta", document: "A" }),
			row({ text: "pet or ta", document: "B" }),
			row({ text: "Pét or ta", document: "C" }),
		];
		expect(selectExamples(rows, "pet")).toHaveLength(1);
	});

	test("ignores rows with a null or blank translation", () => {
		const rows = [
			row({ text: "pet aa", translation: null }),
			row({ text: "pet bbbb", translation: "  " }),
			row({ text: "pet cccccc" }),
		];
		expect(selectExamples(rows, "pet").map((r) => r.text)).toEqual([
			"pet cccccc",
		]);
	});

	test("prefers shorter sentences, up to the maximum", () => {
		const rows = [
			row({ text: "pet aaaa aaaa aaaa", dialect: "a" }),
			row({ text: "pet bb", dialect: "b" }),
			row({ text: "pet cccc cccc", dialect: "c" }),
			row({ text: "pet d", dialect: "d" }),
		];
		expect(selectExamples(rows, "pet", 3).map((r) => r.text)).toEqual([
			"pet d",
			"pet bb",
			"pet cccc cccc",
		]);
	});

	test("ranks native-speaker attestations before modern composed texts", () => {
		const rows = [
			row({ text: "pet a", id: "ainu-times/019/2#1", dialect: "a" }),
			row({ text: "pet bb", id: "zaidan-textbooks/x#1", dialect: "b" }),
			row({ text: "pet cccc cccc cccc", id: "aa-irc/013#3", dialect: "c" }),
			row({ text: "pet dddd dddd", id: "nabesawa/001#5", dialect: "d" }),
		];
		expect(selectExamples(rows, "pet", 3).map((r) => r.id)).toEqual([
			"nabesawa/001#5",
			"aa-irc/013#3",
			"ainu-times/019/2#1",
		]);
	});

	test("spreads picks across distinct dialect+document sources first", () => {
		const rows = [
			row({ text: "pet a", dialect: "小田洲", document: "人食いババ" }),
			row({ text: "pet bb", dialect: "小田洲", document: "人食いババ" }),
			row({ text: "pet cccc", dialect: "沙流", document: "uwepeker 8" }),
			row({ text: "pet dddddd", dialect: "千歳", document: "kamuy yukar" }),
		];
		expect(selectExamples(rows, "pet", 3).map((r) => r.dialect)).toEqual([
			"小田洲",
			"沙流",
			"千歳",
		]);
	});

	test("falls back to repeated sources when distinct ones run out", () => {
		const rows = [
			row({ text: "pet a", dialect: "小田洲", document: "x" }),
			row({ text: "pet bb", dialect: "小田洲", document: "x" }),
		];
		expect(selectExamples(rows, "pet", 3)).toHaveLength(2);
	});

	test("returns [] when nothing usable matches", () => {
		expect(selectExamples([], "pet")).toEqual([]);
		expect(selectExamples([row({ text: "petpo" })], "pet")).toEqual([]);
	});
});

describe("exampleFieldValue", () => {
	const row = (text: string, translation = "訳"): CorpusRow => ({
		id: text,
		text,
		translation,
		dialect: "沙流",
		author: null,
		collection: null,
		document: "doc",
		uri: null,
	});

	test("skips an oversized example and still packs a later one that fits", () => {
		const rows = [
			row("a".repeat(100)),
			row("b".repeat(1010)),
			row("c".repeat(100)),
		];
		const value = exampleFieldValue(rows);
		expect(value.length).toBeLessThanOrEqual(1024);
		expect(value).toContain("a".repeat(100));
		expect(value).toContain("c".repeat(100));
		expect(value).not.toContain("b".repeat(1010));
	});

	test("an oversized first example is skipped so a fitting later one leads", () => {
		const rows = [row("b".repeat(1020)), row("c".repeat(100))];
		const value = exampleFieldValue(rows);
		expect(value.length).toBeLessThanOrEqual(1024);
		expect(value).toContain("c".repeat(100));
		expect(value).not.toContain("b".repeat(1020));
	});

	test("truncates a single oversized example without splitting a surrogate pair", () => {
		const astral = "𩺊".repeat(600);
		const value = exampleFieldValue([row(astral)]);
		expect(value.length).toBeLessThanOrEqual(1024);
		expect(value.endsWith("…")).toBe(true);
		expect(/[\uD800-\uDBFF]…$/.test(value)).toBe(false);
	});

	test("shows the collection when the document is missing", () => {
		const value = exampleFieldValue([
			{ ...row("pet or"), document: null, collection: "uwepeker 8" },
		]);
		expect(value).toContain("沙流 · uwepeker 8");
	});

	test("returns a dash for no examples", () => {
		expect(exampleFieldValue([])).toBe("—");
	});
});

describe("filterExamplesBySense", () => {
	const lex = (
		partial: Partial<MdbLexemeSearchRow> &
			Pick<MdbLexemeSearchRow, "id" | "lemma">,
	): MdbLexemeSearchRow => ({
		kana: "",
		pos: "n",
		gloss_en: [],
		gloss_jp: [],
		bound: false,
		dialects: [],
		variations: [],
		recordings: 0,
		morphemes: [],
		...partial,
	});

	const ex = (text: string, translation: string): CorpusRow => ({
		id: text,
		text,
		translation,
		dialect: null,
		author: null,
		collection: null,
		document: null,
		uri: null,
	});

	const firewood = lex({
		id: "nina.vi",
		lemma: "nina¹",
		pos: "vi",
		gloss_jp: ["薪を採る"],
	});
	const mash = lex({
		id: "nina.vt",
		lemma: "nina²",
		pos: "vt",
		gloss_jp: ["～をこねつぶす"],
	});

	test("drops an example that matches only a rival homograph sense", () => {
		const examples = [
			ex("nina an", "薪を採りに行く"),
			ex("kem nina", "筋子をこねつぶす"),
		];
		const kept = filterExamplesBySense(
			examples,
			firewood,
			[firewood, mash],
			"nina",
		);
		expect(kept.map((e) => e.text)).toEqual(["nina an"]);
	});

	test("keeps examples with no decidable sense context", () => {
		const examples = [ex("nina an", "薪を採る"), ex("nina ne", "それだ")];
		const kept = filterExamplesBySense(
			examples,
			firewood,
			[firewood, mash],
			"nina",
		);
		expect(kept).toHaveLength(2);
	});

	test("returns [] when every example belongs to a rival sense", () => {
		const examples = [
			ex("kem nina", "筋子をこねつぶす"),
			ex("nina wa", "それをこねつぶす"),
		];
		expect(
			filterExamplesBySense(examples, firewood, [firewood, mash], "nina"),
		).toEqual([]);
	});

	test("is a no-op for a sense with no rivals", () => {
		const examples = [ex("kem nina", "筋子をこねつぶす")];
		expect(
			filterExamplesBySense(examples, firewood, [firewood], "nina"),
		).toEqual(examples);
	});
});

describe("review follow-up regressions", () => {
	const row = (
		partial: Partial<CorpusRow> & Pick<CorpusRow, "text">,
	): CorpusRow => ({
		id: partial.text,
		translation: "訳",
		dialect: null,
		author: null,
		collection: null,
		document: null,
		uri: null,
		...partial,
	});

	const lex = (
		partial: Partial<MdbLexemeSearchRow> &
			Pick<MdbLexemeSearchRow, "id" | "lemma">,
	): MdbLexemeSearchRow => ({
		kana: "",
		pos: "n",
		gloss_en: [],
		gloss_jp: [],
		bound: false,
		dialects: [],
		variations: [],
		recordings: 0,
		morphemes: [],
		...partial,
	});

	test("a duplicated sentence keeps the copy from a not-yet-represented source", () => {
		const rows = [
			row({ text: "pet aa", document: "A" }),
			row({ text: "pet bbb", document: "A" }),
			row({ text: "pet bbb", document: "B", id: "b-copy" }),
		];
		const picked = selectExamples(rows, "pet", 2);
		expect(picked.map((r) => r.document)).toEqual(["A", "B"]);
	});

	test("dialect-only and document-only sources with the same name stay distinct", () => {
		const rows = [
			row({ text: "pet aa", dialect: "幌別" }),
			row({ text: "pet bbb", document: "幌別" }),
		];
		expect(selectExamples(rows, "pet", 2)).toHaveLength(2);
	});

	test("metadata-less rows share one diversity slot but still fill via fallback", () => {
		const rows = [
			row({ text: "pet aa", id: "1" }),
			row({ text: "pet bbb", id: "2" }),
			row({ text: "pet cccc", id: "3" }),
		];
		expect(selectExamples(rows, "pet", 3)).toHaveLength(3);
	});

	test("pool-then-primary: two senses matched by different examples resolve via the primary", () => {
		const fire = lex({
			id: "nina.vi",
			lemma: "nina¹",
			pos: "vi",
			gloss_jp: ["薪を採る"],
		});
		const mash = lex({
			id: "nina.vt",
			lemma: "nina²",
			pos: "vt",
			gloss_jp: ["～をこねつぶす"],
		});
		const examples = [
			row({ text: "kem nina", translation: "筋子をこねつぶす" }),
			row({ text: "semas nina poka", translation: "粗末な薪でも" }),
		];
		const sense = selectWotdSense("nina", wholeLookup([fire, mash]), examples);
		expect(sense).toEqual({ kind: "resolved", lexeme: mash });
	});

	test("a sense matching no example at all cannot win against a pool-attested one", () => {
		const fire = lex({
			id: "nina.vi",
			lemma: "nina¹",
			pos: "vi",
			gloss_jp: ["薪を採る"],
		});
		const flat = lex({
			id: "nina.n",
			lemma: "nina",
			gloss_jp: ["ヒラメ"],
		});
		const examples = [
			row({ text: "nina ne", translation: "それだ" }),
			row({ text: "nina kusu paye", translation: "薪を採りに行った" }),
		];
		const sense = selectWotdSense("nina", wholeLookup([fire, flat]), examples);
		expect(sense).toEqual({ kind: "resolved", lexeme: fire });
	});

	test("a 2-char hiragana gloss run (する) no longer matches every translation", () => {
		const doer = lex({ id: "a", lemma: "kar¹", gloss_jp: ["～する"] });
		const maker = lex({ id: "b", lemma: "kar²", gloss_jp: ["～を作る"] });
		const examples = [row({ text: "cise kar", translation: "家を作る" })];
		const sense = selectWotdSense("kar", wholeLookup([doer, maker]), examples);
		expect(sense).toEqual({ kind: "resolved", lexeme: maker });
	});

	test("a proper-name homograph is not a rival in filterExamplesBySense", () => {
		const fire = lex({
			id: "nina.vi",
			lemma: "nina¹",
			pos: "vi",
			gloss_jp: ["薪を採る"],
		});
		const place = lex({
			id: "nina.propn",
			lemma: "Nina",
			pos: "propn",
			gloss_jp: ["荷菜"],
		});
		const examples = [row({ text: "nina un kur", translation: "荷菜の人" })];
		expect(
			filterExamplesBySense(examples, fire, [fire, place], "nina"),
		).toEqual(examples);
	});
});

describe("WOTD meaning field", () => {
	const lex = (
		partial: Partial<MdbLexemeSearchRow> &
			Pick<MdbLexemeSearchRow, "id" | "lemma">,
	): MdbLexemeSearchRow => ({
		kana: "",
		pos: "n",
		gloss_en: [],
		gloss_jp: [],
		bound: false,
		dialects: [],
		variations: [],
		recordings: 0,
		morphemes: [],
		...partial,
	});

	const row = (text: string, translation: string): CorpusRow => ({
		id: "oda/1",
		text,
		translation,
		dialect: "小田洲",
		author: null,
		collection: null,
		document: null,
		uri: null,
	});

	const meaningOf = (
		entry: GlossaryEntry | undefined,
		examples: readonly CorpusRow[],
		lexeme?: MdbLexemeSearchRow,
	): string | undefined => {
		const { fields } = wotdEmbed("sine", entry, examples, lexeme).toJSON() as {
			fields: { name: string; value: string }[];
		};
		return fields.find((f) => f.name.includes("Meaning"))?.value;
	};

	// mdb's gloss pool for `sine`, in API order — ある is a dictionary's rendering
	// of `sine an to`「ある日」and happens to sit first.
	const sine = lex({
		id: "sine",
		lemma: "sine",
		pos: "num",
		gloss_jp: ["ある", "ひとつの，１", "一", "一つの"],
	});
	const sineEntry: GlossaryEntry = {
		Aynu: "sine",
		日本語: "一",
		English: "one",
		sheetName: "number",
	};

	test("sine is one label, 一つの / one, with the rest demoted to the note", () => {
		const meaning = meaningOf(
			sineEntry,
			[
				row(
					"sine cise 'ani ike taa, 'ohta 'ahun manu.",
					"一軒家があって、そこに入ったとさ。",
				),
			],
			sine,
		);
		expect(meaning).toBe("一つの / one\n-# ひとつの · ある");
	});

	test("the label holds when no example attests any gloss", () => {
		expect(meaningOf(sineEntry, [], sine)).toBe(
			"一つの / one\n-# ひとつの · ある",
		);
	});

	test("a kana tail joins the label, another kanji does not", () => {
		const cikap = lex({
			id: "cikap.n",
			lemma: "cikap",
			gloss_jp: ["鳥", "鳥，鶏", "ニワトリ", "鳥鶏"],
			gloss_en: ["a bird"],
		});
		// 鳥鶏 is two words the harvest glued together — 一つの is one word inflected.
		expect(meaningOf(undefined, [], cikap)).toStartWith("鳥 / bird");
	});

	test("harvest residue and misfiled English never reach the label", () => {
		const kamuy = lex({
			id: "kamuy.n",
			lemma: "kamuy",
			gloss_jp: ["神", "a god.", ".} ｟テープ｠", "熊(＝", "熊"],
			gloss_en: ["a god", "a bear"],
		});
		const entry: GlossaryEntry = {
			Aynu: "kamuy",
			日本語: "神",
			English: "god",
			sheetName: "world",
		};
		expect(meaningOf(entry, [], kamuy)).toBe("神 / god\n-# 熊 · bear");
	});

	test("the synonyms and the usage note behind a label go to the note", () => {
		const wakka = lex({
			id: "wakka.n",
			lemma: "wakka",
			gloss_jp: [
				"水(冷水も熱い湯も､ ただし飲用でないもの､ 場合によっては清涼飲料も含む)",
				"水",
			],
			gloss_en: ["water"],
		});
		const entry: GlossaryEntry = {
			Aynu: "wakka",
			日本語: "水",
			English: "water",
			sheetName: "nature",
		};
		expect(meaningOf(entry, [], wakka)).toBe(
			"水 / water\n-# 水(冷水も熱い湯も､ ただし飲用でないもの､ 場合によっては清涼飲料も含む)",
		);
	});

	test("the shorter of the two English wordings wins", () => {
		const hekaci = lex({
			id: "hekaci.n",
			lemma: "hekaci",
			gloss_jp: ["男の子"],
			gloss_en: ["a youth; a young boy"],
		});
		const entry: GlossaryEntry = {
			Aynu: "hekaci",
			日本語: "男の子",
			English: "boy",
			sheetName: "people",
		};
		expect(meaningOf(entry, [], hekaci)).toStartWith("男の子 / boy");
	});

	test("a sense the glossary does not cover stays in Japanese alone", () => {
		const mash = lex({
			id: "nina.vt",
			lemma: "nina²",
			pos: "vt",
			gloss_jp: ["～をこねつぶす"],
		});
		const firewood: GlossaryEntry = {
			Aynu: "nina",
			日本語: "薪を採る",
			English: "gather firewood",
			sheetName: "general_verb",
		};
		// "gather firewood" belongs to the sense the examples ruled out — pairing it
		// with こねつぶす would state something the layers never claimed.
		expect(
			meaningOf(firewood, [row("kem nina", "筋子をこねつぶす")], mash),
		).toBe("～をこねつぶす\n-# 薪を採る · gather firewood");
	});

	test("English is not paired across senses even when both sides have one gloss", () => {
		// MDB's kur² opens with 人 in Japanese and (a) shadow in English.
		const kur = lex({
			id: "kur.n",
			lemma: "kur²",
			gloss_jp: ["人", "影"],
			gloss_en: ["(a) shadow"],
		});
		const person: GlossaryEntry = {
			Aynu: "kur",
			日本語: "人",
			English: "person",
			sheetName: "people",
		};
		expect(meaningOf(person, [], kur)).toStartWith("人 / person");
	});

	test("without an mdb lexeme the glossary row is the meaning", () => {
		expect(meaningOf(sineEntry, [])).toBe("一 / one");
	});

	test("rankGlosses: example attestation outranks glossary agreement", () => {
		const glosses = ["ヒラメ", "薪を採る"];
		expect(rankGlosses(glosses, "薪を採りに行った", "ヒラメ")[0]).toBe(
			"薪を採る",
		);
	});

	test("rankGlosses: the headword wins over the dictionary paragraph beside it", () => {
		const wakka = [
			"水(冷水も熱い湯も､ ただし飲用でないもの､ 場合によっては清涼飲料も含む)",
			"水",
		];
		expect(rankGlosses(wakka, "wakka ku\n水を飲む", "水")[0]).toBe("水");
	});

	test("rankGlosses: unsupported glosses keep mdb's order — brevity is not evidence", () => {
		const cise = ["a house; a (bee)hive", "a wife"];
		expect(rankGlosses(cise, "", "")[0]).toBe("a house; a (bee)hive");
	});

	test("rankGlosses: a gloss with nothing checkable in it sinks to the end", () => {
		expect(rankGlosses(["ある", "ひとつの，１"], "", "")).toEqual([
			"ひとつの，１",
			"ある",
		]);
	});
});
