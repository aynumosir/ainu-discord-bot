import { describe, expect, test } from "bun:test";
import {
	exactLexemeRows,
	exampleFieldValue,
	filterCandidates,
	filterExamplesBySense,
	glossaryExactEntry,
	isCandidateToken,
	jstDateString,
	pickIndex,
	probeForGlossaryHit,
	selectExamples,
	selectWotdLexeme,
	shiftDateString,
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
		const selected = selectWotdLexeme("nina", rows, [
			example("semas nina poka suke poka", "粗末な薪でも料理でも"),
		]);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("nina.vi");
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
		const selected = selectWotdLexeme("nina", rows, [
			example("kem nina", "筋子をこねつぶす"),
		]);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("nina.vt");
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
		const selected = selectWotdLexeme("’itak", rows, [
			example("’itak", "話す"),
		]);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("itak.vi");
	});

	test("ambiguous bare homograph is skipped when context cannot choose a sense", () => {
		const selected = selectWotdLexeme(
			"nina",
			[
				lexeme({
					id: "nina.vi",
					lemma: "nina¹",
					pos: "vi",
					gloss_jp: ["薪を採る"],
				}),
				lexeme({ id: "nina.n", lemma: "nina", pos: "n", gloss_jp: ["ヒラメ"] }),
			],
			[example("nina ne.", "それである。")],
		);
		expect(selected).toEqual({ lexeme: undefined, ambiguous: true });
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

	test("is a no-op without a selected lexeme or without rivals", () => {
		const examples = [ex("kem nina", "筋子をこねつぶす")];
		expect(
			filterExamplesBySense(examples, undefined, [firewood, mash], "nina"),
		).toEqual(examples);
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
		const selected = selectWotdLexeme("nina", [fire, mash], examples);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("nina.vt");
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
		const selected = selectWotdLexeme("nina", [fire, flat], examples);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("nina.vi");
	});

	test("a 2-char hiragana gloss run (する) no longer matches every translation", () => {
		const doer = lex({ id: "a", lemma: "kar¹", gloss_jp: ["～する"] });
		const maker = lex({ id: "b", lemma: "kar²", gloss_jp: ["～を作る"] });
		const examples = [row({ text: "cise kar", translation: "家を作る" })];
		const selected = selectWotdLexeme("kar", [doer, maker], examples);
		expect(selected.ambiguous).toBe(false);
		expect(selected.lexeme?.id).toBe("b");
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
