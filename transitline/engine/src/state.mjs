// The mutable game state. Stations come straight from the pack; everything
// else (lines, trains, passengers) is built up by play.

export const LINE_COLORS = ["#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#9b5de5", "#ffd60a"];

// Service-frequency bands, after Subway Builder's Route Details panel. The
// hour->band table is the engine's own default timetable — it schedules trains
// only and does not shape passenger demand (that is the pack's calendar).
export const BANDS = [
  { id: "high", label: "High Demand", hours: "7-10, 16-19h", color: "#e63946" },
  { id: "medium", label: "Medium Demand", hours: "10-16, 19-20h", color: "#f4a261" },
  { id: "low", label: "Low Demand", hours: "5-7, 20-23h", color: "#2a9d8f" },
  { id: "veryLow", label: "Very Low Demand", hours: "23-5h", color: "#6b7d85" },
];

const BAND_BY_HOUR = Array.from({ length: 24 }, (_, h) => {
  if ((h >= 7 && h < 10) || (h >= 16 && h < 19)) return "high";
  if ((h >= 10 && h < 16) || h === 19) return "medium";
  if ((h >= 5 && h < 7) || (h >= 20 && h < 23)) return "low";
  return "veryLow";
});

export const hourOfDay = (state) => Math.floor(state.simMinutes / 60) % 24;
export const bandAt = (state) => BANDS.find((b) => b.id === BAND_BY_HOUR[hourOfDay(state)]);

export const lineLetter = (lineId) => String.fromCharCode(65 + ((lineId - 1) % 26));

// Dark text on light line colors so the badge letter stays readable.
export function badgeTextColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#0c1114" : "#ffffff";
}

export function createState(pack) {
  const stations = new Map();
  for (const p of pack.demand.points) {
    stations.set(p.id, {
      id: p.id,
      name: p.name ?? p.id,
      location: p.location,
      residents: p.residents ?? 0,
      jobs: p.jobs ?? 0,
      kind: p.kind ?? "mixed",
    });
  }

  return {
    stations,
    attractors: pack.demand.attractors ?? [],
    calendar: pack.demand.calendar ?? null,
    lines: [], // { id, name, color, stationIds, frequency: {bandId: trainsPerHour}, lastDispatch }
    trains: [], // { lineId, segIndex, t, dir }
    passengers: [], // see passengers.mjs for shape
    nextLineId: 1,
    nextPassengerId: 1,
    simMinutes: 6 * 60, // service day starts 06:00, matching calendar periods
    speed: 1, // 0 = paused
    networkDirty: true, // routing graph must be rebuilt
    stats: {
      delivered: 0,
      abandoned: 0,
      spawned: 0,
      spawnedByHour: Array(24).fill(0),
      deliveredByHour: Array(24).fill(0),
    },
  };
}

export function nextLineColor(state) {
  return LINE_COLORS[state.lines.length % LINE_COLORS.length];
}

export function addLine(state, stationIds, opts = {}) {
  const id = state.nextLineId++;
  const line = {
    id,
    name: opts.name ?? `Line ${id}`,
    color: opts.color ?? nextLineColor(state),
    stationIds,
    frequency: { high: 6, medium: 4, low: 2, veryLow: 1 },
    lastDispatch: -Infinity,
  };
  state.lines.push(line);
  state.networkDirty = true;
  return line;
}

export function setBandFrequency(state, lineId, bandId, perHour) {
  const line = state.lines.find((l) => l.id === lineId);
  if (line) line.frequency[bandId] = Math.max(0, Math.min(20, perHour));
}

export function renameLine(state, lineId, name) {
  const line = state.lines.find((l) => l.id === lineId);
  if (line && name.trim()) line.name = name.trim();
}

// Passengers riding or planning to ride a removed line drop back to waiting
// with no route; the next network rebuild re-routes them from where they are.
export function deleteLine(state, lineId) {
  state.lines = state.lines.filter((l) => l.id !== lineId);
  state.trains = state.trains.filter((t) => t.lineId !== lineId);
  for (const p of state.passengers) {
    if (p.route?.some((h) => h.lineId === lineId)) {
      p.state = "waiting";
      p.trainLineId = null;
      p.hopIndex = 0;
      p.route = null;
    }
  }
  state.networkDirty = true;
}

export function clearLines(state) {
  state.lines.length = 0;
  state.trains.length = 0;
  state.networkDirty = true;
  for (const p of state.passengers) {
    p.state = "waiting";
    p.hopIndex = 0;
    p.route = null;
  }
}
