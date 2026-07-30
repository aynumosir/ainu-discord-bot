import { Command, Option } from "discord-hono";
import { SCRIPT_LABELS, SCRIPTS } from "./services/script.js";

const scriptChoices = SCRIPTS.map((value) => ({
	name: SCRIPT_LABELS[value],
	value,
}));

// Single source of truth for both dispatch (src/index.ts) and registration
// (scripts/register.ts). Only ever lists commands that are actually wired up.
export const commands = [
	new Command(
		"convert",
		"Convert Ainu text between Latin, Katakana, and Cyrillic.",
	).options(
		new Option("text", "Text to convert").required(),
		new Option("to", "Target script — omit to see all three at once").choices(
			...scriptChoices,
		),
		new Option("from", "Source script — auto-detected if omitted").choices(
			...scriptChoices,
		),
	),
	// MESSAGE context-menu command: empty description, dispatched by name like any other.
	new Command("Convert script").type(3),
	new Command("corpus", "Search the aligned Ainu↔Japanese corpus").options(
		new Option("query", "Search text (Ainu or Japanese)", "String").required(),
		new Option(
			"lang",
			"Language to search in (default: any)",
			"String",
		).choices(
			{ name: "Ainu", value: "ain" },
			{ name: "日本語", value: "jpn" },
			{ name: "any", value: "any" },
		),
		new Option("mode", "Result display (default: sentences)", "String").choices(
			{ name: "sentences", value: "sentences" },
			{ name: "kwic", value: "kwic" },
		),
		new Option(
			"dialect",
			"Filter by dialect (substring match)",
			"String",
		).autocomplete(),
		new Option("limit", "Max results, 1-10 (default: 5)", "Integer")
			.min_value(1)
			.max_value(10),
	),
	new Command("analyze", "Decompose Ainu word(s) into morphemes").options(
		new Option(
			"text",
			"Word(s) to analyze, up to 8 (Ainu)",
			"String",
		).required(),
		new Option("mode", "Decomposition view (default: flat)", "String").choices(
			{ name: "flat", value: "flat" },
			{ name: "first", value: "first" },
			{ name: "nested", value: "nested" },
		),
	),
	new Command(
		"glossary",
		"Search the itak.aynu.org Ainu ⇄ Japanese/English/Chinese glossary",
	).options(
		new Option("query", "Word or phrase to search for", "String")
			.autocomplete()
			.required(),
		new Option("limit", "Max results, 1-10 (default 5)", "Integer")
			.min_value(1)
			.max_value(10),
	),
	new Command(
		"lookup",
		"Look up an Ainu word: glossary, morphemes, corpus examples & scripts",
	).options(
		new Option("word", "Word to look up (any script)", "String").required(),
	),
	new Command("quiz", "Practice Ainu vocab & sentences.").options(
		new Option("mode", "Question type — omit for a mix of both").choices(
			{ name: "Vocab", value: "vocab" },
			{ name: "Sentence", value: "sentence" },
			{ name: "Mixed", value: "mixed" },
			{ name: "Word of the day", value: "wotd" },
		),
		new Option(
			"stats",
			"Show your quiz stats instead of a new question",
			"Boolean",
		),
	),
	new Command(
		"ask",
		"Ask a grounded question — answered only from cited glossary/corpus/mdb sources",
	).options(
		new Option("question", "Your question (max 300 characters)", "String")
			.required()
			.max_length(300),
	),
	// Manage Server only (permission bit 0x20) — a moderation tool for retrying
	// a failed daily post, hidden from regular members.
	new Command(
		"wotd",
		"Post the word of the day now — today, or a past day the cron run missed",
	)
		.options(
			new Option(
				"date",
				"Day to post for (YYYY-MM-DD, JST) — defaults to today",
				"String",
			).autocomplete(),
		)
		.default_member_permissions("32"),
];
