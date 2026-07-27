import type { CommandContext } from "discord-hono";
import { postWotd, type WotdOutcome } from "../cron/wotd.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";

function outcomeMessage(outcome: WotdOutcome): string {
	switch (outcome.status) {
		case "posted":
			return `✅ 今日のアイヌ語「${outcome.token}」を投稿しました。 / Posted today's word: **${outcome.token}**`;
		case "already-posted":
			return `📅 ${outcome.date} の分はすでに投稿済みです。 / Already posted for ${outcome.date}.`;
		case "skipped":
			return `⚠️ 投稿できるものがありませんでした。 / Nothing to post — ${outcome.reason}.`;
	}
}

/**
 * `/wotd` — runs the word-of-the-day pipeline immediately, for retrying a
 * failed cron run without waiting a day. Idempotent: a day that already has a
 * posted history row reports "already posted" instead of posting twice. The
 * post itself goes to the WOTD channel; the reply here is ephemeral.
 */
export async function wotdHandler(
	c: CommandContext<AppEnv>,
): Promise<Response> {
	return c.flags("EPHEMERAL").resDefer(async (c) => {
		try {
			await c.followup(outcomeMessage(await postWotd(c)));
		} catch (err) {
			await c.followup(`⚠️ ${userMessage(err)}`);
		}
	});
}
