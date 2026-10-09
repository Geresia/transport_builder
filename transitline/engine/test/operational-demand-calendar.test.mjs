import test from "node:test";
import assert from "node:assert/strict";
import { currentDayLabel, currentDayTypeAndPeriod, currentDemandFactor, demandDayTypeForOperatingDay } from "../src/demand-engine.mjs";
import { OPERATIONAL_CALENDAR_SCHEMA } from "../src/operational-calendar.mjs";

const demandCalendar = Object.freeze({
  dayTypes: [
    { id: "weekday", name: "Weekday", weight: 5 },
    { id: "saturday", name: "Saturday", weight: 1 },
    { id: "holiday", name: "Holiday", weight: 1 },
  ],
  periods: [{ id: "day", startMinute: 0, endMinute: 1440 }],
  factors: { weekday: { day: 2 }, saturday: { day: 1.5 }, holiday: { day: 0.5 } },
});

const calendar = (days) => ({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: days });
const state = (day, operationalCalendar = null) => ({ simMinutes: day * 1440 + 600, calendar: demandCalendar, operationalCalendar });

test("without an explicit operating-day entry, demand keeps the pack's own weighted weekday/saturday/holiday cycle", () => {
  const saturday = demandDayTypeForOperatingDay(state(5), 5);
  const holiday = demandDayTypeForOperatingDay(state(6), 6);
  assert.deepEqual(saturday, { dayType: demandCalendar.dayTypes[1], source: "demand-calendar-cycle", operationalDayType: null, reason: null });
  assert.deepEqual(holiday, { dayType: demandCalendar.dayTypes[2], source: "demand-calendar-cycle", operationalDayType: null, reason: null });
  assert.equal(currentDemandFactor(state(6)), 0.5);
});

test("a named operating holiday selects the pack's exact holiday demand profile, including its factor", () => {
  const s = state(1, calendar({ 1: "holiday" }));
  assert.equal(demandDayTypeForOperatingDay(s).dayType.id, "holiday");
  assert.equal(demandDayTypeForOperatingDay(s).source, "operational-calendar-exact");
  assert.equal(currentDemandFactor(s), 0.5);
  const current = currentDayTypeAndPeriod(s);
  assert.equal(current.operationalDayType, "holiday");
  assert.equal(current.dayTypeReason, null);
});

test("an explicit operating weekday can override the pack's normal Sunday/holiday demand profile", () => {
  const s = state(6, calendar({ 6: "weekday" }));
  assert.equal(currentDayTypeAndPeriod(s).dayType.id, "weekday");
  assert.equal(currentDemandFactor(s), 2);
});

test("generic operating weekend never guesses a saturday or holiday demand profile when the pack has neither named weekend", () => {
  const s = state(1, calendar({ 1: "weekend" }));
  const value = demandDayTypeForOperatingDay(s);
  assert.equal(value.dayType.id, "weekday", "the untouched pack sequence remains the fallback");
  assert.deepEqual({ source: value.source, operationalDayType: value.operationalDayType, reason: value.reason }, {
    source: "demand-calendar-fallback", operationalDayType: "weekend", reason: "operational-day-type-has-no-exact-demand-profile",
  });
  assert.match(currentDayLabel(s), /operating weekend \(operational-day-type-has-no-exact-demand-profile\)/);
});

test("a future pack may explicitly provide weekend demand, and inputs stay unchanged", () => {
  const ownCalendar = structuredClone(demandCalendar);
  ownCalendar.dayTypes.push({ id: "weekend", name: "Weekend", weight: 1 });
  ownCalendar.factors.weekend = { day: 1.25 };
  const s = Object.freeze({ simMinutes: 1440 + 600, calendar: Object.freeze(ownCalendar), operationalCalendar: Object.freeze(calendar({ 1: "weekend" })) });
  const before = structuredClone(s);
  assert.equal(currentDayTypeAndPeriod(s).dayType.id, "weekend");
  assert.equal(currentDemandFactor(s), 1.25);
  assert.deepEqual(s, before);
});

test("a pack without a demand calendar stays an undifferentiated day and never invents a holiday demand factor", () => {
  const s = { simMinutes: 1440, calendar: null, operationalCalendar: calendar({ 1: "holiday" }) };
  assert.deepEqual(demandDayTypeForOperatingDay(s), { dayType: null, source: "no-demand-calendar", operationalDayType: null, reason: "demand-calendar-not-provided" });
  assert.equal(currentDemandFactor(s), 1);
  assert.equal(currentDayLabel(s), null);
});
