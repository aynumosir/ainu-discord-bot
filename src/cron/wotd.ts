/**
 * Word-of-the-day cron: `app.cron("0 22 * * *", runWotd)` in src/index.ts,
 * triggered `0 22 * * *` (07:00 JST) per wrangler.jsonc, dispatched by
 * explicit cron key. (A second trigger — the message archive crawler — was
 * added alongside this one; a bare `app.cron("", handler)` catch-all would
 * have silently matched both, so both are now registered by their exact
 * cron string.) The whole pick/filter/probe algorithm is decomposed into
 * pure functions (unit-tested in test/wotd-pick.test.ts) around a thin I/O
 * shell (`postWotd`, shared with the `/wotd` manual-trigger command in
 * src/handlers/wotd.ts) that:
 *
 *  1. no-ops if `WOTD_CHANNEL_ID` is unset (safe until a post channel is chosen)
 *  2. no-ops when the daily trigger finds today (JST) already carrying a
 *     `posted=1` row in `wotd_history`, so a re-fired cron cannot double-post.
 *     A manual `/wotd` instead reposts that day's recorded word, and `date:`
 *     aims the whole pipeline at an earlier day the cron missed.
 *  3. sources candidates from `/v1/freq/list`, filters them, deterministically
 *     picks one by `fnv1a(date)`, probing forward for a glossary hit
 *  4. enriches with a glossary gloss, up to 3 whole-word corpus examples from
 *     distinct sources, and all 3 supported scripts. A meaning and the sentences
 *     under it must belong to the same sense: the examples pick the MDB lexeme
 *     whose glosses they attest, and where they cannot pick one, only a sentence
 *     that shows the glossary meaning itself is kept. A candidate left with no
 *     sentence yields the day to one that reads whole.
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
	type WaitUntilCtx,
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
// The lexeme search matches lemma, kana, variations and both gloss pools by
// substring, ordered by recording count, so a short token is buried under the
// longer words that contain it: `tap`'s own five senses sit at ranks 56–156 of
// 199 hits, and a 20-row window saw none of them — the homograph machinery
// below then ran on an empty candidate set and reported no ambiguity at all.
// 200 is the API's per-request ceiling; a window that is still truncated means
// the senses are unknown, not absent (see `selectWotdSense`).
const MDB_LEXEME_LOOKUP_LIMIT = 200;
// Past this a Japanese gloss is an explanation, not a label: 神 stays, but
// 神のように立派な belongs in the note.
const LABEL_MAX_CHARS = 5;
const LABEL_SEPARATOR = " / ";
const GLOSS_SEPARATOR = " · ";
const NOTE_MAX = 180;
// Gloss ranking ladder — see rankGlosses.
const SCORE_ATTESTED = 4;
const SCORE_AGREES = 2;
const SCORE_CHECKABLE = 1;

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

/**
 * Which sense of the day's token the post may speak for. `resolved` carries the
 * one MDB lexeme the examples support, so its glosses can headline the embed and
 * rival senses can be filtered out of the slate. Everything else is
 * `unresolved`: `ambiguous` — several senses, none of which the examples pick
 * out; `truncated` — the lexeme window was cut short, so senses may exist that
 * were never seen; `absent` — MDB carries no such lexeme, leaving the glossary
 * row's single sense unchecked against any other layer. An unresolved sense
 * never headlines an MDB gloss, and its examples must corroborate the glossary
 * row (`filterExamplesByMeaning`) — the state that has to stay distinct from
 * `resolved`, since it was an unresolved `tap` read as resolved that put
 * 「こう」 sentences under 今し方.
 */
export type WotdSense =
	| { kind: "resolved"; lexeme: MdbLexemeSearchRow }
	| { kind: "unresolved"; reason: "ambiguous" | "truncated" | "absent" };

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

/** English words of 3+ letters — the Latin-script counterpart of `GLOSS_TERM_RUNS`. */
const LATIN_WORD = /[A-Za-z]{3,}/g;

// A parenthesised run tells the reader where or how a word is used —
// 「(人や動物の)肩」 names the possessor of a shoulder, 「(強めの助詞)」 a part of
// speech, "(formerly made of wood)" a material. Its characters describe the
// entry, so they are no evidence that a sentence uses the sense: the 人 of
// 「(人や動物の)肩」 matched 「親戚の人たちに子が多くても」 and headlined tap as 肩.
const PARENTHETICAL = /[(（][^()（）]*[)）]/g;

/** A gloss with its parenthesised asides removed, for matching against a text. */
function glossCore(gloss: string): string {
	return gloss.replace(PARENTHETICAL, " ");
}

/**
 * The meaning-bearing substrings of a gloss. A single Han character carries
 * meaning (corpus translations often say just 薪); hiragana needs >= 3 chars —
 * 2-char runs like する or して are grammatical filler matching almost any
 * translation.
 */
function glossTerms(gloss: string): string[] {
	const terms: string[] = [];
	for (const re of GLOSS_TERM_RUNS) {
		const min = re.source.includes("Han")
			? 1
			: re.source.includes("Hiragana")
				? 3
				: 2;
		for (const term of glossCore(gloss).match(re) ?? []) {
			if (term.length >= min) terms.push(term);
		}
	}
	return terms;
}

function latinWords(text: string): string[] {
	return text.toLowerCase().match(LATIN_WORD) ?? [];
}

/** `latinWords` of a gloss — its asides excluded, as in `glossTerms`. */
function glossWords(gloss: string): string[] {
	return latinWords(glossCore(gloss));
}

function textAttestsGloss(gloss: string, text: string): boolean {
	return glossTerms(gloss).some((term) => text.includes(term));
}

/** Whether a gloss offers anything that can be checked against another text. */
function hasCheckableTerm(gloss: string): boolean {
	return glossTerms(gloss).length > 0 || glossWords(gloss).length > 0;
}

/**
 * Whether two meaning strings from different layers — an MDB gloss and a
 * glossary row — name the same thing, via a shared CJK term or English word.
 */
function meaningsAgree(a: string, b: string): boolean {
	if (a.trim() === "" || b.trim() === "") return false;
	if (textAttestsGloss(a, b) || textAttestsGloss(b, a)) return true;
	const words = new Set(glossWords(b));
	return glossWords(a).some((word) => words.has(word));
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
// Braces and ｟…｠ (a tape-recording marker in 田村's entries) are harvest
// residue: MDB's pools carry mid-entry cuts such as `.} ｟テープ｠` and `熊(＝`.
const GLOSS_RESIDUE = /[{}｛｝｟｠]/u;

function balancedParens(gloss: string): boolean {
	return (
		(gloss.match(/[(（]/g) ?? []).length ===
		(gloss.match(/[)）]/g) ?? []).length
	);
}

/** Drops the harvest residue and the misfiled glosses of the other language. */
function glossPool(glosses: readonly string[], japanese: boolean): string[] {
	const inLanguage = glosses.filter(
		(gloss) => CJK_CHAR.test(gloss) === japanese && gloss.trim() !== "",
	);
	const clean = inLanguage.filter(
		(gloss) => !GLOSS_RESIDUE.test(gloss) && balancedParens(gloss),
	);
	// A lexeme whose every gloss looks like residue still needs a meaning.
	return clean.length > 0 ? clean : inLanguage;
}

function exampleContextText(examples: readonly CorpusRow[]): string {
	return examples.map((ex) => `${ex.text}\n${ex.translation ?? ""}`).join("\n");
}

function lexemeMatchesExampleContext(
	row: MdbLexemeSearchRow,
	examples: readonly CorpusRow[],
): boolean {
	const text = exampleContextText(examples);
	if (!text.trim()) return false;
	return [...row.gloss_jp, ...row.gloss_en].some((gloss) =>
		textAttestsGloss(gloss, text),
	);
}

/**
 * The one MDB sense the day's examples support, or why none could be had. A
 * bare homograph the examples cannot tell apart stays unresolved, and so does
 * every token whose lookup window was cut short: `lookup.total` counting more
 * rows than came back means a sense may sit outside the window, and a sense
 * that was never seen can neither be chosen nor filtered against. Only a window
 * that held every matching row can resolve one. Truncation is rare at the
 * search API's 200-row ceiling — 3 of 40 sampled candidates, all of them two-
 * or three-letter tokens contained in a thousand longer words.
 */
export function selectWotdSense(
	token: string,
	lookup: { results: readonly MdbLexemeSearchRow[]; total: number },
	examples: readonly CorpusRow[],
): WotdSense {
	const rows = lookup.results;
	if (lookup.total > rows.length) {
		return { kind: "unresolved", reason: "truncated" };
	}
	const exact = exactLexemeRows(rows, token).filter((row) => !row.bound);
	if (exact.length === 0) return { kind: "unresolved", reason: "absent" };

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
			? { kind: "resolved", lexeme: proper }
			: { kind: "unresolved", reason: "ambiguous" };
	}

	// Pool all examples first — a sense picked here must be attested somewhere
	// in the slate, so a coincidental hit in one sentence can't decide alone.
	// When several senses match the pool (each via a different sentence), the
	// primary (first-ranked, shown first) example breaks the tie; if it can't,
	// the homograph really is ambiguous.
	const pooled = commonRows.filter((row) =>
		lexemeMatchesExampleContext(row, examples),
	);
	if (pooled.length > 1) {
		return resolvedOrAmbiguous(
			pooled.filter((row) =>
				lexemeMatchesExampleContext(row, examples.slice(0, 1)),
			),
		);
	}
	return resolvedOrAmbiguous(pooled.length === 1 ? pooled : commonRows);
}

/** Resolved on exactly one candidate sense, ambiguous on any other count. */
function resolvedOrAmbiguous(rows: readonly MdbLexemeSearchRow[]): WotdSense {
	const sole = rows.length === 1 ? rows[0] : undefined;
	return sole
		? { kind: "resolved", lexeme: sole }
		: { kind: "unresolved", reason: "ambiguous" };
}

/**
 * Drops examples that context-match a rival homograph sense while not matching
 * the selected one, so a post never shows a sentence under the wrong meaning.
 * Examples with no decidable context are kept.
 */
export function filterExamplesBySense(
	examples: readonly CorpusRow[],
	lexeme: MdbLexemeSearchRow,
	rows: readonly MdbLexemeSearchRow[],
	token: string,
): CorpusRow[] {
	// Mirror selectWotdSense's candidate rules: proper-name homographs are
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

/**
 * The examples that corroborate the meaning the post will print — a term of the
 * glossary row occurring in the sentence or its translation. This is the gate
 * for an unresolved sense, where `filterExamplesBySense` has no sense to name
 * rivals against: with nothing vouching for the pairing, only a sentence that
 * shows the meaning itself may stand under it.
 *
 * It runs over everything the corpus returned rather than over a slate already
 * cut to three, so the diversity and length ranking of `selectExamples` chooses
 * among corroborating sentences instead of being narrowed by them: gating the
 * slate left `tane` one example of three and `katkemat` one, where gating the
 * pool leaves both with three.
 *
 * Requiring the meaning to be visible is strict: 「水」 will not corroborate a
 * translation that says 湯, and that day's word goes to another candidate. It is
 * the one rule that would have caught `tap`, whose 今し方 was corroborated by
 * none of the three 「こう」/「このように」 sentences shown under it.
 */
export function filterExamplesByMeaning(
	examples: readonly CorpusRow[],
	meanings: readonly string[],
): CorpusRow[] {
	const usable = meanings.filter((meaning) => meaning.trim() !== "");
	if (usable.length === 0) return [];
	return examples.filter((ex) =>
		usable.some((meaning) => meaningOccursIn(meaning, ex)),
	);
}

/** The meanings a glossary row states, in the two languages the embed prints. */
function entryMeanings(entry: GlossaryEntry): string[] {
	return [entry.日本語 ?? "", entry.English ?? ""];
}

/** Whether a sentence or its translation shows `meaning`. */
function meaningOccursIn(meaning: string, ex: CorpusRow): boolean {
	const translation = ex.translation ?? "";
	if (textAttestsGloss(meaning, `${ex.text}\n${translation}`)) return true;
	// Where the meaning offers no CJK term to look for, its English words are
	// matched against the translation alone — the Ainu text is Latin script too,
	// and `nu` would "attest" any gloss containing "nu".
	if (glossTerms(meaning).length > 0) return false;
	const words = new Set(latinWords(translation));
	return glossWords(meaning).some((word) => words.has(word));
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

/**
 * MDB carries one lexeme's glosses as a pool harvested from several
 * dictionaries, in no meaningful order — `sine` lists ある before 一, so taking
 * the first one headlined the numeral "one" as ある. Rank by what the post
 * itself corroborates: a gloss the day's examples attest, then a gloss the
 * glossary row agrees with, then a gloss that at least offers a term to check.
 * `sine` ends 一 · ひとつの，１ · ある — the ある of `sine an to`「或る日」carries
 * nothing checkable and reads as 有る/在る out of position, so it goes last.
 * Two glosses with the same support go shortest first, since the pool mixes
 * bare headwords with whole dictionary paragraphs (`wakka` carries both 水 and
 * 水(冷水も熱い湯も､ ただし飲用でないもの…)) and the headword leads better.
 * Unsupported glosses keep source order: brevity says nothing about which sense
 * is primary, and `cise` would headline as "a wife" over "a house; a (bee)hive".
 */
export function rankGlosses(
	glosses: readonly string[],
	contextText: string,
	curated: string,
): string[] {
	const attested = contextText.trim() !== "";
	const score = (gloss: string) =>
		(attested && textAttestsGloss(gloss, contextText) ? SCORE_ATTESTED : 0) +
		(meaningsAgree(gloss, curated) ? SCORE_AGREES : 0) +
		(hasCheckableTerm(gloss) ? SCORE_CHECKABLE : 0);
	return glosses
		.map((gloss, index) => ({ gloss, index, score: score(gloss) }))
		.sort(
			(a, b) =>
				b.score - a.score ||
				(a.score >= SCORE_AGREES ? a.gloss.length - b.gloss.length : 0) ||
				a.index - b.index,
		)
		.map((scored) => scored.gloss);
}

/**
 * A gloss reduced to what a label needs, plus what it gave up. Dictionaries
 * write a headword, its synonyms and its usage note in one string
 * (`金持ち，物持ち，裕福な人…`, `水(冷水も熱い湯も…)`), each with its own
 * punctuation; `label` is the headword alone, `rest` the synonyms and `asides`
 * the parenthesised explanations, which the note carries. A bare number is
 * dropped — 「ひとつの，１」 restates its own headword as a digit.
 */
interface Gloss {
	label: string;
	rest: string[];
	asides: string[];
}

// A parenthesis holding 4+ characters explains the term; a shorter one belongs
// to it — "(bee)hive" and 「(＝」 must not be cut the way 「（建物としての）家」 is.
const ASIDE = /[(（]([^()（）]{4,})[)）]/g;
// The separators dictionaries use between synonyms inside one gloss, halfwidth
// forms included — 田村's entries punctuate with ､ (U+FF64), not 、. The ASCII
// comma is deliberately absent: English glosses ("a well off, rich man") are
// single labels, and Japanese ones use ，/、.
const SYNONYM_SEPARATORS = /[、，；;・､･]/;
const ARTICLE = /\b(?:a|an|the) +/gi;
const TRAILING_MARKS = /^[\s.,。､、｡]+|[\s.,。､、｡]+$/g;

function glossOf(raw: string, japanese: boolean): Gloss | undefined {
	const asides: string[] = [];
	// The aside leaves a separator behind, never a splice: 「鳥(鳥類の総称)鶏」
	// holds two synonyms and must not close up into 鳥鶏.
	const text = raw.replace(ASIDE, () => {
		// The note quotes the gloss whole: 「建物としての」 on its own says nothing,
		// 「（建物としての）家」 says what it was there to say.
		asides.push(raw.trim());
		return japanese ? "、" : " ";
	});
	const parts = (japanese ? text.split(SYNONYM_SEPARATORS) : [text])
		.map((part) => (japanese ? part : part.replace(ARTICLE, "")))
		.map((part) => part.replace(TRAILING_MARKS, "").trim())
		.filter((part) => part !== "" && !/^[\p{N}]+$/u.test(part));
	const [label, ...rest] = parts;
	if (label === undefined) return undefined;
	return { label, rest, asides };
}

/**
 * One label per sense, most supported first. Glosses whose labels restate one
 * another are one sense (`神` and `神のように立派な`, `一` and `一つの`). Within a
 * sense the fullest form wins, but only where the extra characters are kana —
 * an adnominal tail (一 → 一つの) belongs to the same word, whereas another
 * kanji is a second word glued on by the harvest (鳥 stays 鳥, not 鳥鶏).
 */
function senseLabels(glosses: readonly Gloss[]): string[] {
	const senses: string[][] = [];
	for (const { label } of glosses) {
		const sense = senses.find((members) =>
			members.some((m) => m.includes(label) || label.includes(m)),
		);
		if (sense) sense.push(label);
		else senses.push([label]);
	}
	return senses.map((members) => {
		const base = members.reduce((a, b) => (b.length < a.length ? b : a));
		const inflected = members.filter(
			(m) =>
				m.length <= LABEL_MAX_CHARS &&
				m.includes(base) &&
				/^\p{Script=Hiragana}*$/u.test(m.replace(base, "")),
		);
		return inflected.reduce((a, b) => (b.length > a.length ? b : a), base);
	});
}

/**
 * The English for a Japanese label. MDB's two gloss arrays are not parallel —
 * `kur²` opens with 人 in Japanese and "(a) shadow" in English — so nothing may
 * be paired by position. The glossary row is aligned by construction, so it
 * anchors the pair: English is shown only for the sense that row describes,
 * taking whichever wording is shorter. A sense the row does not cover (the
 * `nina` a hearth example picked, say) is left in Japanese alone rather than
 * printed beside another sense's English.
 */
function englishFor(
	jpLabel: string | undefined,
	enLabels: readonly string[],
	curatedJp: string,
	curatedEn: string,
): string | undefined {
	const anchored = jpLabel !== undefined && meaningsAgree(jpLabel, curatedJp);
	const candidates = anchored
		? [curatedEn, ...enLabels.filter((en) => meaningsAgree(en, curatedEn))]
		: // With no curated English there is nothing to anchor to, but a lexeme
			// with exactly one English gloss has only one sense to get wrong.
			curatedEn === "" && enLabels.length === 1
			? enLabels
			: [];
	return candidates
		.filter((c) => c !== "")
		.reduce<string | undefined>(
			(best, c) => (best === undefined || c.length < best.length ? c : best),
			undefined,
		);
}

/** The nuance the labels left out: the other synonyms and the usage notes. */
function meaningNote(
	glosses: readonly Gloss[],
	shown: readonly string[],
): string {
	const extras = glosses
		// A gloss with an aside is quoted whole, so its own label would repeat.
		.flatMap(({ label, rest, asides }) =>
			asides.length > 0 ? [...rest, ...asides] : [label, ...rest],
		)
		// A label already on display, or any fragment of one, adds nothing.
		.filter((extra) => !shown.some((s) => s.includes(extra)));
	const unique = extras.filter(
		(extra, i) =>
			extras.indexOf(extra) === i &&
			!extras.some((other) => other !== extra && other.includes(extra)),
	);
	if (unique.length === 0) return "";
	return `\n-# ${truncate(unique.join(GLOSS_SEPARATOR), NOTE_MAX)}`;
}

/** One `日本語 / English` label, with everything it left out in a note under it. */
function meaningField(
	jpGlosses: readonly Gloss[],
	enGlosses: readonly Gloss[],
	curatedJp: string,
	curatedEn: string,
): string | undefined {
	const jp = senseLabels(jpGlosses)[0];
	const en = englishFor(jp, senseLabels(enGlosses), curatedJp, curatedEn);
	const label = [jp, en].filter(Boolean).join(LABEL_SEPARATOR);
	if (label === "") return undefined;
	return (
		label + meaningNote([...jpGlosses, ...enGlosses], [jp ?? "", en ?? ""])
	);
}

function glossesOf(pooled: readonly string[], japanese: boolean): Gloss[] {
	return pooled
		.map((gloss) => glossOf(gloss, japanese))
		.filter((gloss): gloss is Gloss => gloss !== undefined);
}

function curatedGlosses(text: string, japanese: boolean): Gloss[] {
	return glossesOf(glossPool([text], japanese), japanese);
}

/** The meaning a glossary row alone can carry — no MDB sense to draw on. */
function glossaryMeaning(entry: GlossaryEntry | undefined): string | undefined {
	if (!entry) return undefined;
	const jp = entry.日本語 ?? "";
	const en = entry.English ?? "";
	return meaningField(
		curatedGlosses(jp, true),
		curatedGlosses(en, false),
		jp,
		en,
	);
}

function lexemeMeaning(
	lexeme: MdbLexemeSearchRow | undefined,
	entry: GlossaryEntry | undefined,
	examples: readonly CorpusRow[],
): string | undefined {
	if (!lexeme) return undefined;
	const context = exampleContextText(examples);
	const curatedJp = entry?.日本語 ?? "";
	const curatedEn = entry?.English ?? "";
	// The curated row joins the Japanese pool so that a curated 一 and MDB's
	// 一つの land in one sense — the label is then the fullest form of that one
	// word, not whichever layer happened to be consulted.
	const jp = [
		...glossesOf(
			rankGlosses(glossPool(lexeme.gloss_jp, true), context, curatedJp),
			true,
		),
		...curatedGlosses(curatedJp, true),
	];
	const en = [
		...glossesOf(glossPool(lexeme.gloss_en, false), false),
		...curatedGlosses(curatedEn, false),
	];
	return meaningField(jp, en, curatedJp, curatedEn);
}

/** Pure embed builder — the only non-pure step left is `.toJSON()` at the call site (none here). */
export function wotdEmbed(
	token: string,
	entry: GlossaryEntry | undefined,
	examples: readonly CorpusRow[],
	lexeme?: MdbLexemeSearchRow,
	/** The day the word belongs to, when that is not the day of posting. */
	pastDate?: string,
) {
	const meaning =
		lexemeMeaning(lexeme, entry, examples) ??
		glossaryMeaning(entry) ??
		(entry ? "—" : "（辞書未登録 / not yet in the glossary）");
	return baseEmbed("corpus.aynu.org · itak.aynu.org")
		.title(
			pastDate
				? `📅 ${pastDate}のアイヌ語 / Word of the day, ${pastDate}: ${token}`
				: `📅 今日のアイヌ語 / Word of the day: ${token}`,
		)
		.fields(
			{ name: "意味 / Meaning", value: meaning },
			{ name: "表記 / Scripts", value: scriptsFieldValue(token) },
			{ name: "例文 / Example", value: exampleFieldValue(examples) },
		);
}

// ---------------------------------------------------------------- I/O ----

async function alreadyPosted(db: D1Database, date: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT posted FROM wotd_history WHERE date = ?")
		.bind(date)
		.first<{ posted: number }>();
	return row?.posted === 1;
}

async function postedToken(
	db: D1Database,
	date: string,
): Promise<string | undefined> {
	const row = await db
		.prepare("SELECT token FROM wotd_history WHERE date = ?")
		.bind(date)
		.first<{ token: string }>();
	return row?.token;
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

/** One recorded day, newest first — what `/wotd date:` offers as choices. */
export interface WotdHistoryRow {
	date: string;
	token: string;
	posted: number;
}

export async function historySince(
	db: D1Database,
	since: string,
): Promise<WotdHistoryRow[]> {
	const { results } = await db
		.prepare(
			"SELECT date, token, posted FROM wotd_history WHERE date >= ? ORDER BY date DESC",
		)
		.bind(since)
		.all<WotdHistoryRow>();
	return results;
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

export type WotdOutcome =
	| { status: "posted"; token: string; date: string }
	| { status: "resent"; token: string; date: string }
	| { status: "already-posted"; date: string }
	| { status: "skipped"; reason: string };

export interface WotdOptions {
	/** The clock that decides which JST day is "today"; tests inject a fixed instant. */
	now?: Date;
	/**
	 * The JST day to post for, `YYYY-MM-DD`; defaults to today. Any past day
	 * works: the pick is a pure function of the date, so a day the cron missed
	 * yields the word it would have posted then, and posting it records that
	 * day rather than consuming today's word.
	 */
	date?: string;
	/**
	 * Leave a day that already went out untouched — the daily trigger's contract,
	 * so a re-fired cron never doubles a post. `/wotd` does not set it: a manual
	 * run is deliberate, and reposting a day costs nothing but the message.
	 */
	skipRecorded?: boolean;
}

/**
 * The context slice the WOTD pipeline needs — satisfied by both `CronContext`
 * (the daily trigger) and `CommandContext` (the `/wotd` manual trigger), which
 * share discord-hono's `Context` base.
 */
export interface WotdContext {
	env: Env;
	executionCtx: WaitUntilCtx;
	rest: CronContext<AppEnv>["rest"];
}

/**
 * Everything the embed needs for one token — corpus examples, the MDB sense the
 * examples support, the glossary row — or `undefined` when the glossary has no
 * row for the token. A resolved sense headlines its MDB glosses and keeps every
 * example a rival sense does not claim; an unresolved one prints the glossary
 * row alone and keeps only the examples that corroborate it, which may be none.
 */
async function enrichToken(
	c: WotdContext,
	table: GlossaryTable,
	token: string,
): Promise<{ selection: WotdSelection; sense: WotdSense } | undefined> {
	const entry = glossaryExactEntry(table, token);
	if (!entry) return undefined;

	const exampleRows = await searchCorpus(c.env, {
		q: token,
		lang: "ain",
		limit: EXAMPLE_FETCH_LIMIT,
	});
	const examples = selectExamples(exampleRows, token);
	const lookup = await searchLexemes(c.env, token, MDB_LEXEME_LOOKUP_LIMIT);
	const sense = selectWotdSense(token, lookup, examples);
	return {
		selection: {
			token,
			entry,
			examples:
				sense.kind === "resolved"
					? filterExamplesBySense(examples, sense.lexeme, lookup.results, token)
					: // The corroborating sentences are chosen from everything the corpus
						// returned, so `selectExamples` still ranks by source and length
						// among them; `examples` above only had to decide the sense.
						selectExamples(
							filterExamplesByMeaning(exampleRows, entryMeanings(entry)),
							token,
						),
			lexeme: sense.kind === "resolved" ? sense.lexeme : undefined,
		},
		sense,
	};
}

async function publish(
	c: WotdContext,
	channelId: string,
	selection: WotdSelection,
	pastDate?: string,
): Promise<void> {
	const res = await c.rest("POST", $channels$_$messages, [channelId], {
		embeds: [
			wotdEmbed(
				selection.token,
				selection.entry,
				selection.examples,
				selection.lexeme,
				pastDate,
			).toJSON(),
		],
	});
	if (!res.ok) {
		throw new Error(`Discord post failed: HTTP ${res.status}`);
	}
}

/**
 * Runs the whole pick/enrich/post pipeline once for one JST day and reports
 * what happened. Upstream/Discord failures throw — the caller decides how to
 * surface them. The history row is only written after a confirmed-successful
 * post, so a failed run always retries safely next time.
 *
 * `options.date` defaults to today in JST; `/wotd date:` names an earlier day
 * to backfill, and tests fix both the clock and the day so the deterministic
 * hash pick is reproducible. A day that already holds a word posts that word
 * again rather than picking a new one, unless `options.skipRecorded` says to
 * leave it alone.
 */
export async function postWotd(
	c: WotdContext,
	options: WotdOptions = {},
): Promise<WotdOutcome> {
	const channelId = c.env.WOTD_CHANNEL_ID;
	if (!channelId) {
		return { status: "skipped", reason: "WOTD_CHANNEL_ID is empty" };
	}

	const db = c.env.DB;
	const today = jstDateString(options.now);
	const date = options.date ?? today;
	// A post for an earlier day says which day it is, so the channel never reads
	// a backfilled word as today's.
	const pastDate = date === today ? undefined : date;

	if (options.skipRecorded && (await alreadyPosted(db, date))) {
		return { status: "already-posted", date };
	}

	// A day that already has a word keeps it: the recorded token is rebuilt from
	// the current sources and posted again, so a second run replaces a wrong embed
	// without spending another day's word. Only an unrecorded day picks.
	const posted = await postedToken(db, date);
	if (posted !== undefined) {
		const table = await getGlossary(c.env, c.executionCtx);
		const enriched = await enrichToken(c, table, posted);
		if (!enriched) {
			return {
				status: "skipped",
				reason: `${posted} has no glossary row to rebuild from`,
			};
		}
		await publish(c, channelId, enriched.selection, pastDate);
		return { status: "resent", token: posted, date };
	}

	const rows = await freqList(c.env, {
		limit: CANDIDATE_LIMIT,
		includeStopwords: false,
		minCount: CANDIDATE_MIN_COUNT,
	});
	// Rows after `date` count as recent too, so backfilling a missed day never
	// repeats a word that has since gone out.
	const excluded = await recentTokens(
		db,
		shiftDateString(date, -RECENT_WINDOW_DAYS),
	);
	const candidates = filterCandidates(rows, excluded);
	if (candidates.length === 0) {
		return {
			status: "skipped",
			reason: "no eligible candidates after filtering",
		};
	}

	const table = await getGlossary(c.env, c.executionCtx);
	const startIndex = pickIndex(date, candidates.length);
	let selected: WotdSelection | undefined;
	// A candidate whose meaning survives with no sentence to show it still makes a
	// post, so it is kept in reserve while the probe looks for one that reads
	// whole: an MDB sense first, then any candidate at all. Preferring an example
	// is what keeps the meaning-corroboration gate from thinning the posts —
	// a word the gate strips bare yields the day to one it does not.
	let senseWithoutExample: WotdSelection | undefined;
	let lastResort: WotdSelection | undefined;
	const probes = Math.min(MAX_PROBE, candidates.length);
	for (let step = 0; step < probes; step++) {
		const index = (startIndex + step) % candidates.length;
		// biome-ignore lint/style/noNonNullAssertion: index is derived from candidates.length > 0.
		const token = candidates[index]!;
		const enriched = await enrichToken(c, table, token);
		if (!enriched) continue;
		const { selection, sense } = enriched;
		if (selection.examples.length > 0) {
			selected = selection;
			break;
		}
		if (sense.kind === "resolved") {
			senseWithoutExample ??= selection;
			continue;
		}
		console.warn(
			`[wotd] ${token}: sense unresolved (${sense.reason}) and no example corroborates its glossary meaning — probing next`,
		);
		lastResort ??= selection;
	}
	selected ??= senseWithoutExample ?? lastResort;
	if (!selected) {
		return { status: "skipped", reason: "no glossary-backed candidate at all" };
	}
	if (selected.examples.length === 0) {
		console.warn(
			`[wotd] ${selected.token}: posting without an example — no sentence stands under its meaning`,
		);
	}

	await publish(c, channelId, selected, pastDate);
	await upsertPosted(db, date, selected.token);
	return { status: "posted", token: selected.token, date };
}

/**
 * The daily cron handler. Any thrown error (upstream API down, Discord post
 * failed, …) is caught and logged — never rethrown — since there's no
 * interaction to reply to.
 */
export async function runWotd(
	c: CronContext<AppEnv>,
	now: Date = new Date(),
): Promise<void> {
	try {
		const outcome = await postWotd(c, { now, skipRecorded: true });
		switch (outcome.status) {
			case "posted":
				console.log(`[wotd] posted ${outcome.token}`);
				break;
			case "already-posted":
				console.log(`[wotd] ${outcome.date} already posted — no-op`);
				break;
			case "skipped":
				console.warn(`[wotd] ${outcome.reason} — skipping`);
				break;
		}
	} catch (err) {
		console.error(
			"[wotd] run failed — no history row written, will retry",
			err,
		);
		// Surface the failure in the WOTD channel itself — an unnoticed missing
		// post is worse than one error line. Best-effort: if Discord itself is
		// what failed, this may fail too, and the console line above remains.
		// A throw implies the channel check inside postWotd already passed, so
		// WOTD_CHANNEL_ID is set here.
		try {
			const message = err instanceof Error ? err.message : String(err);
			await c.rest("POST", $channels$_$messages, [c.env.WOTD_CHANNEL_ID], {
				content: `⚠️ 今日のアイヌ語の投稿に失敗しました。次回の実行で再試行します。 / Word-of-the-day failed and will retry on the next run.\n-# ${truncate(message, 200)}`,
			});
		} catch (reportErr) {
			console.error("[wotd] failure report also failed", reportErr);
		}
	}
}
