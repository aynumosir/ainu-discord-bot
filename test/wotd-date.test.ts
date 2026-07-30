import { describe, expect, test } from "bun:test";
import type { WotdHistoryRow } from "../src/cron/wotd.js";
import { resolveWotdDate, wotdDateChoices } from "../src/handlers/wotd.js";

const NOW = new Date("2026-07-03T10:00:00Z"); // 2026-07-03 JST
const TODAY = "2026-07-03";

describe("resolveWotdDate", () => {
	test("omitted or blank means today in JST", () => {
		expect(resolveWotdDate(undefined, NOW)).toEqual({ date: TODAY });
		expect(resolveWotdDate("   ", NOW)).toEqual({ date: TODAY });
	});

	test("today and any earlier day are accepted, surrounding spaces trimmed", () => {
		expect(resolveWotdDate(TODAY, NOW)).toEqual({ date: TODAY });
		expect(resolveWotdDate(" 2026-07-02 ", NOW)).toEqual({
			date: "2026-07-02",
		});
		expect(resolveWotdDate("2025-01-01", NOW)).toEqual({ date: "2025-01-01" });
	});

	test("a future day is refused, so the cron still posts it on the day", () => {
		const result = resolveWotdDate("2026-07-04", NOW);
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("2026-07-04");
	});

	test("anything that is not a real YYYY-MM-DD day is refused", () => {
		for (const input of [
			"yesterday",
			"07-02",
			"2026-7-2",
			"2026/07/02",
			"2026-13-01",
			"2026-02-30", // parses by rolling into March, still not a real day
		]) {
			expect(resolveWotdDate(input, NOW)).toHaveProperty("error");
		}
	});
});

const row = (date: string, token: string, posted = 1): WotdHistoryRow => ({
	date,
	token,
	posted,
});

describe("wotdDateChoices", () => {
	const history = [
		row(TODAY, "kamuy"),
		row("2026-07-01", "sinep"),
		row("2026-06-30", "utar", 0),
	];

	test("offers 25 days newest first, naming the word recorded for each", () => {
		const choices = wotdDateChoices(TODAY, history, "");

		expect(choices).toHaveLength(25);
		expect(choices[0]).toEqual({
			name: `${TODAY}（今日・kamuy）`,
			value: TODAY,
		});
		expect(choices[1]).toEqual({
			name: "2026-07-02（昨日・未投稿）",
			value: "2026-07-02",
		});
		expect(choices[2]).toEqual({
			name: "2026-07-01（sinep）",
			value: "2026-07-01",
		});
		// posted=0 is a day whose post never landed — still open, so 未投稿.
		expect(choices[3]).toEqual({
			name: "2026-06-30（未投稿）",
			value: "2026-06-30",
		});
		expect(choices.at(-1)?.value).toBe("2026-06-09");
	});

	test("a partial date narrows the list", () => {
		const june = wotdDateChoices(TODAY, history, "2026-06").map((c) => c.value);
		expect(june).toHaveLength(22); // 2026-06-30 back to the 25-day edge
		expect(june[0]).toBe("2026-06-30");
		expect(june.at(-1)).toBe("2026-06-09");

		expect(wotdDateChoices(TODAY, history, "07-01")).toEqual([
			{ name: "2026-07-01（sinep）", value: "2026-07-01" },
		]);
		expect(wotdDateChoices(TODAY, history, "1999")).toEqual([]);
	});
});
