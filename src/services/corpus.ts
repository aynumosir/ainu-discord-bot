import { getJson, getJsonWithMeta } from "./http.js";

export type CorpusLang = "ain" | "jpn" | "any";

export interface CorpusRow {
	id: string;
	text: string;
	translation: string | null;
	dialect: string | null;
	author: string | null;
	collection: string | null;
	document: string | null;
	uri: string | null;
}

export interface KwicLine {
	sentence_id: string;
	left_text: string;
	node_text: string;
	right_text: string;
	text: string;
	translation: string | null;
	dialect: string | null;
	author: string | null;
	collection: string | null;
	document: string | null;
	uri: string | null;
}

export interface KwicResult {
	lines: KwicLine[];
	meta: { total: number };
}

export interface FreqRow {
	token: string;
	count: number;
	is_stopword: number;
}

function qs(params: Record<string, string | number | undefined>): string {
	const u = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") u.set(k, String(v));
	}
	return u.toString();
}

/** `GET /v1/search` — full-text corpus search (FTS5 trigram substring). */
export async function searchCorpus(
	env: Env,
	opts: { q: string; lang?: CorpusLang; dialect?: string; limit?: number },
): Promise<CorpusRow[]> {
	const query = qs({
		q: opts.q,
		lang: opts.lang,
		dialect: opts.dialect,
		limit: opts.limit,
	});
	return getJson<CorpusRow[]>(env, "CORPUS", `/v1/search?${query}`);
}

/**
 * `GET /v1/kwic` — annotated KWIC concordance. `match=fold` (accent-insensitive)
 * is always sent, matching the plan's fixed contract for `/corpus mode:kwic`.
 */
export async function kwic(
	env: Env,
	opts: { q: string; ctx?: number; limit?: number },
): Promise<KwicResult> {
	const query = qs({
		q: opts.q,
		ctx: opts.ctx,
		limit: opts.limit,
		match: "fold",
	});
	const { data, meta } = await getJsonWithMeta<
		KwicLine[],
		{ total: number; offset: number; limit: number }
	>(env, "CORPUS", `/v1/kwic?${query}`);
	return { lines: data, meta: { total: meta?.total ?? data.length } };
}

/**
 * The sentences that use `token` as a whole word, as `CorpusRow`s, via
 * `/v1/kwic` — one per sentence, in corpus order. `/v1/search` is the wrong
 * source for this: it matches substrings (`pet` finds `Yeepeta'usnaypo`) and
 * reads the `corpus_fts` copy, whose translations lag the `sentences` table
 * (`terke`: 0 of 40 rows translated there, 199 of 200 here). The token layer
 * matches whole folded tokens and joins `sentences` directly.
 */
export async function tokenSentences(
	env: Env,
	opts: { q: string; limit?: number },
): Promise<CorpusRow[]> {
	// ctx=0 drops the neighbour token arrays; the sentence text is a field.
	const { lines } = await kwic(env, { q: opts.q, ctx: 0, limit: opts.limit });
	const rows = new Map<string, CorpusRow>();
	for (const line of lines) {
		// A sentence using the token twice yields two lines.
		if (rows.has(line.sentence_id)) continue;
		rows.set(line.sentence_id, {
			id: line.sentence_id,
			text: line.text,
			translation: line.translation,
			dialect: line.dialect,
			author: line.author,
			collection: line.collection,
			document: line.document,
			uri: line.uri,
		});
	}
	return [...rows.values()];
}

export interface DialectNode {
	path: string;
	name: string;
	count: number;
	areas?: DialectNode[];
	dialects?: DialectNode[];
}

export interface DialectChoice {
	name: string;
	count: number;
}

/**
 * `GET /v1/dialects` — hierarchical region → area → dialect tree with
 * sentence counts. Cached per isolate: the tree changes only on corpus
 * reloads, and autocomplete must answer within Discord's 3s budget.
 */
let dialectCache: { at: number; choices: DialectChoice[] } | undefined;
const DIALECT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Flattens the tree to leaf dialect names with counts, most-attested first. */
export function flattenDialects(tree: readonly DialectNode[]): DialectChoice[] {
	const out: DialectChoice[] = [];
	const walk = (node: DialectNode) => {
		const children = [...(node.areas ?? []), ...(node.dialects ?? [])];
		if (children.length === 0) {
			if (node.name !== "(unknown)") {
				out.push({ name: node.name, count: node.count });
			}
			return;
		}
		for (const child of children) walk(child);
	};
	for (const region of tree) walk(region);
	return out.sort((a, b) => b.count - a.count);
}

export async function listDialects(env: Env): Promise<DialectChoice[]> {
	if (dialectCache && Date.now() - dialectCache.at < DIALECT_CACHE_TTL_MS) {
		return dialectCache.choices;
	}
	const tree = await getJson<DialectNode[]>(env, "CORPUS", "/v1/dialects");
	const choices = flattenDialects(tree);
	dialectCache = { at: Date.now(), choices };
	return choices;
}

/**
 * `GET /v1/freq/list` — most-frequent already-normalized tokens, used by the
 * WOTD cron to source daily-word candidates. Contract verified against
 * `ainu-corpora-api/openapi.yaml` + a live `curl` (2026-07-03):
 * `{ token, count, is_stopword }[]` in `data`.
 */
export async function freqList(
	env: Env,
	opts: { limit?: number; includeStopwords?: boolean; minCount?: number },
): Promise<FreqRow[]> {
	const query = qs({
		limit: opts.limit,
		includeStopwords:
			opts.includeStopwords === undefined
				? undefined
				: String(opts.includeStopwords),
		minCount: opts.minCount,
	});
	return getJson<FreqRow[]>(env, "CORPUS", `/v1/freq/list?${query}`);
}
