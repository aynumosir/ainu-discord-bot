import type { AutocompleteContext, CommandContext } from "discord-hono";
import { Autocomplete } from "discord-hono";
import {
	historySince,
	jstDateString,
	postWotd,
	shiftDateString,
	type WotdHistoryRow,
	type WotdOutcome,
} from "../cron/wotd.js";
import type { AppEnv } from "../lib/errors.js";
import { userMessage } from "../lib/errors.js";

/** Discord caps an autocomplete response at 25 choices, one per offered day. */
const DATE_CHOICE_DAYS = 25;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(raw: string): boolean {
	if (!DATE_PATTERN.test(raw)) return false;
	const parsed = Date.parse(`${raw}T00:00:00Z`);
	// 2026-02-30 parses, rolling forward into March — the round-trip catches it.
	return (
		!Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === raw
	);
}

/**
 * The JST day a `date` option refers to, or the reason it cannot be used.
 * Future days are refused: posting one early would leave the cron finding a
 * `posted=1` row and skipping that day when it arrives.
 */
export function resolveWotdDate(
	input: string | undefined,
	now: Date = new Date(),
): { date: string } | { error: string } {
	const today = jstDateString(now);
	const raw = input?.trim();
	if (!raw) return { date: today };
	if (!isCalendarDate(raw)) {
		return {
			error: `日付はYYYY-MM-DD形式で指定してください（例：${today}）。 / Give the date as YYYY-MM-DD, e.g. ${today}.`,
		};
	}
	if (raw > today) {
		return {
			error: `${raw}はまだ来ていないため投稿できません。 / ${raw} is in the future.`,
		};
	}
	return { date: raw };
}

function dayLabel(date: string, today: string): { ja: string; en: string } {
	if (date === today) return { ja: "今日", en: "today" };
	if (date === shiftDateString(today, -1))
		return { ja: "昨日", en: "yesterday" };
	return { ja: date, en: date };
}

/**
 * The last `DATE_CHOICE_DAYS` days, newest first, each showing the word already
 * recorded for it — so a moderator can see which days are still missing and
 * pick one without typing a date. `query` filters by substring on the date.
 */
export function wotdDateChoices(
	today: string,
	history: readonly WotdHistoryRow[],
	query: string,
): { name: string; value: string }[] {
	const posted = new Map(
		history.filter((r) => r.posted === 1).map((r) => [r.date, r.token]),
	);
	const q = query.trim();
	const choices: { name: string; value: string }[] = [];
	for (let back = 0; back < DATE_CHOICE_DAYS; back++) {
		const date = shiftDateString(today, -back);
		if (q !== "" && !date.includes(q)) continue;
		const { ja } = dayLabel(date, today);
		const parts = [...(ja === date ? [] : [ja]), posted.get(date) ?? "未投稿"];
		choices.push({ name: `${date}（${parts.join("・")}）`, value: date });
	}
	return choices;
}

function outcomeMessage(outcome: WotdOutcome, today: string): string {
	switch (outcome.status) {
		case "posted": {
			const { ja, en } = dayLabel(outcome.date, today);
			return `✅ ${ja}のアイヌ語「${outcome.token}」を投稿しました。 / Posted the word for ${en}: **${outcome.token}**`;
		}
		case "resent": {
			const { ja, en } = dayLabel(outcome.date, today);
			return `🔁 ${ja}のアイヌ語「${outcome.token}」を投稿し直しました。 / Reposted the word for ${en}: **${outcome.token}**`;
		}
		// Only the daily trigger leaves a recorded day alone; a manual run reposts it.
		case "already-posted":
			return `📅 ${outcome.date}の分はすでに投稿済みです。 / Already posted for ${outcome.date}.`;
		case "skipped":
			return `⚠️ 投稿できるものがありませんでした。 / Nothing to post — ${outcome.reason}.`;
	}
}

type WotdCommandOptions = { date?: string };

/**
 * `/wotd date?` — runs the word-of-the-day pipeline immediately for one JST day,
 * for retrying a failed cron run without waiting a day. `date` defaults to today
 * and accepts any past day, which is how a run the cron missed still gets its own
 * word instead of consuming today's. A day that already went out is posted again
 * with its recorded word, rebuilt from the current sources — the way a corrected
 * embed reaches the channel, and the reason the command never refuses. The post
 * itself goes to the WOTD channel; the reply here is ephemeral.
 */
export async function wotdHandler(
	c: CommandContext<AppEnv>,
): Promise<Response> {
	const { date } = c.var as unknown as WotdCommandOptions;
	const resolved = resolveWotdDate(date);
	if ("error" in resolved) {
		return c.flags("EPHEMERAL").res(`⚠️ ${resolved.error}`);
	}
	return c.flags("EPHEMERAL").resDefer(async (c) => {
		try {
			await c.followup(
				outcomeMessage(
					await postWotd(c, { date: resolved.date }),
					jstDateString(),
				),
			);
		} catch (err) {
			await c.followup(`⚠️ ${userMessage(err)}`);
		}
	});
}

/**
 * Autocomplete for the `date` option — recent days with the word recorded for
 * each. Empty-list-on-any-failure, since autocomplete must never error back to
 * Discord.
 */
export async function wotdDateAutocomplete(c: AutocompleteContext<AppEnv>) {
	try {
		if (c.focused?.name !== "date") {
			return c.resAutocomplete(new Autocomplete("").choices());
		}
		const today = jstDateString();
		const history = await historySince(
			c.env.DB,
			shiftDateString(today, -(DATE_CHOICE_DAYS - 1)),
		);
		return c.resAutocomplete(
			new Autocomplete("").choices(
				...wotdDateChoices(today, history, String(c.focused?.value ?? "")),
			),
		);
	} catch {
		return c.resAutocomplete(new Autocomplete("").choices());
	}
}
