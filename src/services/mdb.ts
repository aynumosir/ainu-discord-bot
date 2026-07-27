import { getJson } from "./http.js";

export type DecomposeMode = "nested" | "flat" | "first";

/** A resolved morpheme/lexeme summary embedded in a decomposition node. */
export interface MdbMorpheme {
	id: string;
	lemma: string;
	allomorphs: string[];
	category: string;
	morph_type: string;
	glosses_en: string[];
	glosses_jp: string[];
	bound: boolean;
	verified: boolean;
	frequency: number;
}

/**
 * One node of the DP-fallback composition tree (`NodeView` in mdb's
 * `api-views.ts`). `nested` mode returns a single root node with `children`
 * populated recursively; `flat`/`first` return arrays of leaf-like nodes
 * (never populate `children`, only `first` sets `decomposable`).
 */
export interface MdbDecompositionNode {
	surface: string;
	kind: string;
	side?: "prefix" | "suffix";
	isLeaf: boolean;
	arity: number | null;
	morpheme: MdbMorpheme | null;
	decomposable?: boolean;
	children?: MdbDecompositionNode[];
}

/** Canonical analysis view (`analysisView()` in mdb's `+server.ts`). */
export interface MdbAnalysis {
	id: string;
	surface: string;
	target_kind: "lexeme" | "morpheme" | "query";
	target_id: string | null;
	parts: string[];
	surface_parts: string[];
	source: "curated" | "wiktionary" | "kayano" | "llm" | "dp";
	confidence: number;
	has_head: boolean;
	bracketing: (string | string[])[];
	note: string;
}

/** `fallback_used: false` — a curated/harvested analysis exists for this form. */
export interface MdbDecomposeCanonical {
	form: string;
	fallback_used: false;
	analysis: MdbAnalysis;
}

/**
 * `fallback_used: true` — no canonical analysis; live DP segmentation ran
 * instead over the same engine the mdb explorer UI uses. `decomposition` is
 * the `mode` projection: a single node (`nested`) or a leaf array (`flat`/`first`).
 */
export interface MdbDecomposeFallback {
	form: string;
	fallback_used: true;
	mode: DecomposeMode;
	source: string;
	unseen: boolean;
	arity: number | null;
	tokens: string[];
	unresolved: string[];
	warnings: string[];
	decomposition: MdbDecompositionNode | MdbDecompositionNode[];
}

export type MdbDecomposeResult = MdbDecomposeCanonical | MdbDecomposeFallback;

export interface MdbFormFeatureBundle {
	domain: "nominal" | "verbal";
	relation: string;
	number_locus?: string;
	derivation?: string;
	extras?: Record<string, string>;
}

/** One row of `/api/forms` (`formView()` in mdb's `api-views.ts`). */
export interface MdbFormRow {
	id: string;
	lemma_id: string;
	lexeme_id: string;
	surface: string;
	analysis: string;
	feature_bundle: MdbFormFeatureBundle;
	source: "rule" | "attested" | "exception" | string;
	confidence: number;
	rule_id: string;
	attested_ref: string;
}

export interface MdbFormsResult {
	query: string;
	total: number;
	returned: number;
	results: MdbFormRow[];
}

/** A variant surface form of a lexeme, with the dialects it is attested in. */
export interface MdbLexemeVariation {
	surface: string;
	dialects: string[];
}

/** One row of `/api/lexemes` (`rowView()` in mdb's lexeme API). */
export interface MdbLexemeSearchRow {
	id: string;
	lemma: string;
	kana: string;
	pos: string;
	gloss_en: string[];
	gloss_jp: string[];
	bound: boolean;
	dialects: string[];
	variations: MdbLexemeVariation[];
	recordings: number;
	morphemes: string[];
}

export interface MdbLexemeSearchResult {
	query: string;
	total: number;
	returned: number;
	results: MdbLexemeSearchRow[];
}

function qs(params: Record<string, string | number | undefined>): string {
	const u = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") u.set(k, String(v));
	}
	return u.toString();
}

/**
 * `GET /api/decompose` — the canonical analysis when one exists for `form`
 * (curated > wiktionary > kayano > llm > dp, by precedence), else a live
 * DP-segmentation fallback (`fallback_used: true`). Never 404s — a nonsense
 * input still returns a best-effort segmentation; only a missing `form` or
 * an invalid `mode` yields a 400, surfaced as an `ApiError` by `getJson`.
 */
export async function decompose(
	env: Env,
	form: string,
	mode: DecomposeMode = "flat",
): Promise<MdbDecomposeResult> {
	const query = qs({ form, mode });
	return getJson<MdbDecomposeResult>(env, "MDB", `/api/decompose?${query}`);
}

/**
 * `GET /api/forms` — lookup-only search over precomputed generated forms
 * (possessed nouns, plural/derived verbs), each tagged `source` ∈
 * rule|attested|exception with a trust-ordered `confidence`.
 */
export async function forms(
	env: Env,
	q: string,
	limit = 3,
): Promise<MdbFormsResult> {
	const query = qs({ q, limit });
	return getJson<MdbFormsResult>(env, "MDB", `/api/forms?${query}`);
}

/**
 * `GET /api/lexemes` — search the canonical lexeme layer. WOTD uses this to
 * prefer sense-split MDB meanings over glossary-only rows, so homographs like
 * `nina` don't collapse into a place-name/fish/firewood mix.
 */
export async function searchLexemes(
	env: Env,
	q: string,
	limit = 20,
): Promise<MdbLexemeSearchResult> {
	const query = qs({ q, limit });
	return getJson<MdbLexemeSearchResult>(env, "MDB", `/api/lexemes?${query}`);
}
