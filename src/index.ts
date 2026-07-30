import { DiscordHono } from "discord-hono";
import { runWotd } from "./cron/wotd.js";
import { analyzeHandler } from "./handlers/analyze.js";
import { askHandler } from "./handlers/ask.js";
import { convert, convertScriptContextMenu } from "./handlers/convert.js";
import { corpusDialectAutocomplete, corpusHandler } from "./handlers/corpus.js";
import { glossaryAutocomplete, glossaryHandler } from "./handlers/glossary.js";
import { lookupHandler } from "./handlers/lookup.js";
import { quiz, quizAnswer, quizNext } from "./handlers/quiz.js";
import { wotdDateAutocomplete, wotdHandler } from "./handlers/wotd.js";
import { type AppEnv, safeHandler } from "./lib/errors.js";
import { runArchive } from "./services/archive.js";

const app = new DiscordHono<AppEnv>();

app.command("convert", safeHandler(convert));
app.command("Convert script", safeHandler(convertScriptContextMenu));
app.autocomplete(
	"corpus",
	corpusDialectAutocomplete,
	safeHandler(corpusHandler),
);
app.command("analyze", safeHandler(analyzeHandler));
app.autocomplete(
	"glossary",
	glossaryAutocomplete,
	safeHandler(glossaryHandler),
);
app.command("lookup", safeHandler(lookupHandler));
app.command("quiz", safeHandler(quiz));
// quizAnswer/quizNext are components (not commands) — already wrapped with
// their own error handler in handlers/quiz.ts, since errors.ts's safeHandler
// is typed for CommandContext only.
app.component("quiz", quizAnswer);
app.component("quiz-next", quizNext);
app.command("ask", safeHandler(askHandler));
app.autocomplete("wotd", wotdDateAutocomplete, safeHandler(wotdHandler));

// Explicit cron keys — must match wrangler.jsonc's triggers.crons exactly,
// one handler per trigger. (Previously a single `app.cron("", runWotd)`
// catch-all matched every trigger; that would have silently routed the new
// archive trigger into the WOTD handler too, so this PR switched to explicit
// keys before adding the second cron.)
app.cron("0 22 * * *", runWotd);
app.cron("*/10 * * * *", runArchive);

export default app;
