import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN_DAY_MINUTES,
  CAMPAIGN_MONTH_MINUTES,
  CAMPAIGN_DAYS_PER_YEAR,
  campaignTargetStatus,
  campaignTimeAtMinute,
  normalizeCampaignDurationMonths,
  normalizeCampaignTargetMonth,
} from "../src/campaign-time.mjs";

test("campaign time is a read-only label over the existing 30-day management month", () => {
  assert.equal(CAMPAIGN_MONTH_MINUTES, 30 * CAMPAIGN_DAY_MINUTES);
  assert.equal(CAMPAIGN_DAYS_PER_YEAR, 360);
  assert.deepEqual(campaignTimeAtMinute(0), {
    minute: 0, dayIndex: 0, dayNumber: 1, monthIndex: 0, monthNumber: 1,
    yearIndex: 0, yearNumber: 1, monthInYearIndex: 0, monthInYearNumber: 1,
    quarterIndex: 0, quarterNumber: 1,
  });
  assert.deepEqual(campaignTimeAtMinute(12 * CAMPAIGN_MONTH_MINUTES), {
    minute: 12 * CAMPAIGN_MONTH_MINUTES, dayIndex: 360, dayNumber: 361,
    monthIndex: 12, monthNumber: 13, yearIndex: 1, yearNumber: 2,
    monthInYearIndex: 0, monthInYearNumber: 1, quarterIndex: 0, quarterNumber: 1,
  });
});

test("campaign labels are deterministic and do not pretend an invalid clock is a date", () => {
  const atBoundary = campaignTimeAtMinute(3 * CAMPAIGN_MONTH_MINUTES);
  assert.equal(atBoundary.quarterNumber, 2);
  assert.equal(campaignTimeAtMinute(-1), null);
  assert.equal(campaignTimeAtMinute(Number.NaN), null);
  assert.equal(campaignTimeAtMinute(Number.POSITIVE_INFINITY), null);
  assert.deepEqual(campaignTimeAtMinute(12345.9), campaignTimeAtMinute(12345.1));
});

test("target and duration preserve unstated null separately from a stated zero", () => {
  assert.equal(normalizeCampaignTargetMonth(null), null);
  assert.equal(normalizeCampaignTargetMonth(0), 0);
  assert.equal(normalizeCampaignDurationMonths(undefined), null);
  assert.equal(normalizeCampaignDurationMonths(0), 0);
  for (const value of [-1, 1.5, "1", [], false, Number.NaN]) {
    assert.throws(() => normalizeCampaignTargetMonth(value));
    assert.throws(() => normalizeCampaignDurationMonths(value));
  }
});

test("a due date is a fact and never an automatic campaign state transition", () => {
  assert.deepEqual(campaignTargetStatus(null, 0), { targetMonth: null, status: "unstated", currentMonth: 0 });
  assert.deepEqual(campaignTargetStatus(2, 0), { targetMonth: 2, currentMonth: 0, status: "future" });
  assert.deepEqual(campaignTargetStatus(2, 2 * CAMPAIGN_MONTH_MINUTES), { targetMonth: 2, currentMonth: 2, status: "due" });
  assert.deepEqual(campaignTargetStatus(2, 3 * CAMPAIGN_MONTH_MINUTES), { targetMonth: 2, currentMonth: 3, status: "past-due" });
  assert.deepEqual(campaignTargetStatus(2, null), { targetMonth: 2, status: "clock-unknown", currentMonth: null });
});
