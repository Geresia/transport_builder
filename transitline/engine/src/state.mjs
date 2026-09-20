// The mutable game state. Stations come straight from the pack; everything
// else (lines, trains, passengers) is built up by play.

export const LINE_COLORS = ["#e63946", "#457b9d", "#2a9d8f", "#f4a261", "#9b5de5", "#ffd60a"];

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
    lines: [], // { id, name, color, stationIds: string[], trainCount }
    trains: [], // { lineId, segIndex, t, dir }
    passengers: [], // see passengers.mjs for shape
    nextLineId: 1,
    nextPassengerId: 1,
    simMinutes: 6 * 60, // service day starts 06:00, matching calendar periods
    networkDirty: true, // routing graph must be rebuilt
    stats: { delivered: 0, abandoned: 0 },
  };
}

const MAX_TRAINS_PER_LINE = 4;

export function nextLineColor(state) {
  return LINE_COLORS[state.lines.length % LINE_COLORS.length];
}

// Trains are spread evenly across station-index positions (not true distance)
// so a higher frequency visibly shortens waits without needing real headway
// scheduling — a stand-in for Subway Builder's route-frequency dial.
function spawnTrainsForLine(state, line, count) {
  const span = Math.max(line.stationIds.length - 1, 1);
  for (let i = 0; i < count; i++) {
    const segIndex = Math.min(span - 1, Math.floor((i * span) / count));
    state.trains.push({ lineId: line.id, segIndex, t: 0, dir: 1 });
  }
}

export function addLine(state, stationIds, opts = {}) {
  const id = state.nextLineId++;
  const line = {
    id,
    name: opts.name ?? `Line ${id}`,
    color: opts.color ?? nextLineColor(state),
    stationIds,
    trainCount: 0,
  };
  state.lines.push(line);
  setLineFrequency(state, id, opts.trainCount ?? 1);
  state.networkDirty = true;
  return line;
}

export function setLineFrequency(state, lineId, count) {
  const line = state.lines.find((l) => l.id === lineId);
  if (!line) return;
  const clamped = Math.max(1, Math.min(MAX_TRAINS_PER_LINE, count));
  state.trains = state.trains.filter((t) => t.lineId !== lineId);
  line.trainCount = clamped;
  spawnTrainsForLine(state, line, clamped);
}

export function renameLine(state, lineId, name) {
  const line = state.lines.find((l) => l.id === lineId);
  if (line && name.trim()) line.name = name.trim();
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
