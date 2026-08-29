// Regenerates demand.json for the matrix-model example pack.
//   node generate.mjs
// Fully synthetic. Exercises the paths example-radial does not: model "matrix",
// explicit flows, and the calendar (day types x time-of-day factors).
import { writeFileSync } from "node:fs";

const names = ["Westgate", "Foundry", "Old Town", "Central", "Riverside", "Eastfield"];
const points = names.map((name, i) => ({
  id: `s${i + 1}`,
  name,
  location: [Number((-0.05 + i * 0.02).toFixed(5)), 0],
  kind: i === 3 ? "commercial" : "mixed",
}));

// A commuter corridor: everything drains toward Central (s4) in the morning.
const flows = [];
for (const p of points) {
  if (p.id === "s4") continue;
  const dist = Math.abs(points.indexOf(p) - 3);
  const base = Math.round(2600 / dist);
  flows.push({ from: p.id, to: "s4", trips: base, dayType: "weekday", period: "am_peak" });
  flows.push({ from: "s4", to: p.id, trips: base, dayType: "weekday", period: "pm_peak" });
  flows.push({ from: p.id, to: "s4", trips: Math.round(base * 0.35), dayType: "saturday", period: "midday" });
}

const demand = {
  formatVersion: 1,
  model: "matrix",
  calendar: {
    dayTypes: [
      { id: "weekday", name: "평일", weight: 5 },
      { id: "saturday", name: "토요일", weight: 1 },
      { id: "holiday", name: "일요일·공휴일", weight: 1 },
    ],
    periods: [
      { id: "early", name: "Early", startMinute: 240, endMinute: 420 },
      { id: "am_peak", name: "Morning peak", startMinute: 420, endMinute: 560 },
      { id: "midday", name: "Midday", startMinute: 560, endMinute: 1020 },
      { id: "pm_peak", name: "Evening peak", startMinute: 1020, endMinute: 1200 },
      { id: "evening", name: "Evening", startMinute: 1200, endMinute: 1500 },
    ],
    // Placeholder coefficients. Real packs calibrate these — see docs/data-sources-kr.md:
    // the licence-clean Korean feed gives hour-of-day only, so the day-of-week
    // dimension is modelled here rather than sourced.
    factors: {
      weekday: { early: 0.3, am_peak: 2.6, midday: 0.8, pm_peak: 2.3, evening: 0.7 },
      saturday: { early: 0.2, am_peak: 0.9, midday: 1.2, pm_peak: 1.1, evening: 0.8 },
      holiday: { early: 0.1, am_peak: 0.6, midday: 1.1, pm_peak: 0.9, evening: 0.6 },
    },
  },
  points,
  flows,
};

writeFileSync(new URL("./demand.json", import.meta.url), JSON.stringify(demand, null, 2) + "\n");
console.log(`wrote ${points.length} points, ${flows.length} flows`);
