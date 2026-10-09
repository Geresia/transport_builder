// B20 foundation: campaign time is a read-only label over the management clock.
// The management model already defines a month as 30 days.  A campaign year is exactly
// twelve of those months (360 days), not a competing calendar and never a new clock.
// Nothing in this module advances time, creates events, or reads wall time.

export const CAMPAIGN_DAY_MINUTES = 24 * 60;
export const CAMPAIGN_MONTH_DAYS = 30;
export const CAMPAIGN_MONTH_MINUTES = CAMPAIGN_MONTH_DAYS * CAMPAIGN_DAY_MINUTES;
export const CAMPAIGN_MONTHS_PER_QUARTER = 3;
export const CAMPAIGN_MONTHS_PER_YEAR = 12;
export const CAMPAIGN_DAYS_PER_YEAR = CAMPAIGN_MONTH_DAYS * CAMPAIGN_MONTHS_PER_YEAR;

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

// A target month is player-stated planning information. null means it was not stated;
// a non-negative integer is a real month index, including 0. Other values are invalid.
export function normalizeCampaignTargetMonth(value) {
  if (value === null || value === undefined) return null;
  if (!isNonNegativeInteger(value)) throw new Error("campaign target month must be a non-negative integer or null");
  return value;
}

// Same tri-state convention as targetMonth: omitted is unknown, [] is not accepted here
// because a duration is one scalar fact. A stated zero is an immediate milestone, not unknown.
export function normalizeCampaignDurationMonths(value) {
  if (value === null || value === undefined) return null;
  if (!isNonNegativeInteger(value)) throw new Error("campaign duration months must be a non-negative integer or null");
  return value;
}

// Converts the existing management clock minute into stable, display-oriented campaign labels.
// Indices are zero-based for references; numbers are one-based for the player-facing timeline.
export function campaignTimeAtMinute(minute) {
  if (!Number.isFinite(minute) || minute < 0) return null;
  const wholeMinute = Math.floor(minute);
  const dayIndex = Math.floor(wholeMinute / CAMPAIGN_DAY_MINUTES);
  const monthIndex = Math.floor(wholeMinute / CAMPAIGN_MONTH_MINUTES);
  const yearIndex = Math.floor(monthIndex / CAMPAIGN_MONTHS_PER_YEAR);
  const monthInYearIndex = monthIndex % CAMPAIGN_MONTHS_PER_YEAR;
  const quarterIndex = Math.floor(monthInYearIndex / CAMPAIGN_MONTHS_PER_QUARTER);
  return {
    minute: wholeMinute,
    dayIndex,
    dayNumber: dayIndex + 1,
    monthIndex,
    monthNumber: monthIndex + 1,
    yearIndex,
    yearNumber: yearIndex + 1,
    monthInYearIndex,
    monthInYearNumber: monthInYearIndex + 1,
    quarterIndex,
    quarterNumber: quarterIndex + 1,
  };
}

// A fact about a stated target and the existing clock, not a lifecycle transition.
// `due` deliberately does not mark anything complete; the player or scenario must do that.
export function campaignTargetStatus(targetMonth, minute) {
  const normalized = normalizeCampaignTargetMonth(targetMonth);
  const now = campaignTimeAtMinute(minute);
  if (normalized === null) return { targetMonth: null, status: "unstated", currentMonth: now?.monthIndex ?? null };
  if (now === null) return { targetMonth: normalized, status: "clock-unknown", currentMonth: null };
  return {
    targetMonth: normalized,
    currentMonth: now.monthIndex,
    status: now.monthIndex < normalized ? "future" : now.monthIndex === normalized ? "due" : "past-due",
  };
}
