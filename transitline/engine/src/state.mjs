import { DeterministicRng } from "./rng.mjs";

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

// Subway Builder: 240 passengers per car, 5-15 cars. Ours is scaled down to
// match this engine's deliberately small passenger volume (see
// demand-engine.mjs), so a full 5-car train seats 60 rather than 1,200.
export const CAR_CAPACITY = 12;
export const DEFAULT_CARS = 5;
export const MIN_CARS = 1;
export const MAX_CARS = 15;
export const trainCapacity = (line) => line.carsPerTrain * CAR_CAPACITY;

export const hourOfDay = (state) => Math.floor(state.simMinutes / 60) % 24;
export const bandAt = (state) => BANDS.find((b) => b.id === BAND_BY_HOUR[hourOfDay(state)]);

export const lineLetter = (lineId) => String.fromCharCode(65 + ((lineId - 1) % 26));

// Dark text on light line colors so the badge letter stays readable.
export function badgeTextColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#0c1114" : "#ffffff";
}

export function createState(pack, options = {}) {
  const demandNodes = new Map();
  const stations = new Map();
  for (const p of pack.demand.points) {
    const demandNode = {
      id: p.id,
      name: p.name ?? p.id,
      location: p.location,
      residents: p.residents ?? 0,
      jobs: p.jobs ?? 0,
      kind: p.kind ?? "mixed",
    };
    demandNodes.set(p.id, demandNode);
    if (options.materializeDemandStations !== false) stations.set(p.id, {
      ...demandNode,
      named: p.name !== undefined,
      source: "legacy-demand-adapter",
      status: "available",
    });
  }

  // matrix packs carry flows, not residents/jobs. Stations still need a size
  // to draw, so use each point's total trip volume, normalised to the range
  // gravity packs occupy. Display only — routing and demand never read it.
  if (pack.demand.model === "matrix") {
    const volume = new Map();
    for (const f of pack.demand.flows ?? []) {
      volume.set(f.from, (volume.get(f.from) ?? 0) + f.trips);
      volume.set(f.to, (volume.get(f.to) ?? 0) + f.trips);
    }
    const max = Math.max(1, ...volume.values());
    for (const s of stations.values()) s.residents = ((volume.get(s.id) ?? 0) / max) * 30000;
  }

  return {
    demandNodes,
    accessLinks: [],
    // B15 allocation links are player-approved access decisions.  They must
    // stay separate from plan geometry's automatic accessLinks so a policy can
    // be applied or rolled back without rewriting construction facts.
    stationDemandAllocationLinks: [],
    stationDemandAllocationVersion: 0,
    accessVersion: 0,
    stations,
    platforms: [],
    trackSegments: [],
    attractors: pack.demand.attractors ?? [],
    calendar: pack.demand.calendar ?? null,
    lines: [], // { id, name, color, stationIds, frequency: {bandId: trainsPerHour}, lastDispatch }
    trains: [], // { lineId, segIndex, t, dir }
    passengers: [], // see passengers.mjs for shape
    nextLineId: 1,
    nextTrainId: 1,
    nextPassengerId: 1,
    rng: new DeterministicRng(options.seed ?? 0x6d2b79f5),
    simMinutes: 6 * 60, // service day starts 06:00, matching calendar periods
    speed: 1, // 0 = paused
    networkDirty: true, // routing graph must be rebuilt
    stats: {
      delivered: 0,
      abandoned: 0,
      spawned: 0,
      modeShare: { transit: 0, driving: 0, walking: 0 },
      spawnedByHour: Array(24).fill(0),
      deliveredByHour: Array(24).fill(0),
      deliveredByLine: {},
      trainKmByLine: {},
    },
    railwayDisruptions: {
      events: [],
      nextSequence: 1,
      lastEvaluatedHour: 6,
      rngState: ((options.seed ?? 0x6d2b79f5) ^ 0x4b1d5eed) >>> 0,
    },
    railCapacityApplications: [],
    railwayControlOrders: { orders: [], nextSequence: 1 },
    railReplacementOperations: { operations: [], trips: [], nextSequence: 1, nextTripSequence: 1, nextVirtualLineId: -1 },
  };
}

export function nextLineColor(state) {
  return LINE_COLORS[state.lines.length % LINE_COLORS.length];
}

export function addLine(state, stationIds, opts = {}) {
  if (!Array.isArray(stationIds) || stationIds.length < 2) throw new Error("A service line requires at least two stations");
  for (const stationId of stationIds) if (!state.stations.has(stationId)) throw new Error(`Unknown station ${stationId}`);
  for (let i = 1; i < stationIds.length; i++) if (stationIds[i] === stationIds[i - 1]) throw new Error("A service line cannot repeat consecutive stations");
  const id = state.nextLineId++;
  const line = {
    id,
    name: opts.name ?? `Line ${id}`,
    color: opts.color ?? nextLineColor(state),
    stationIds,
    carsPerTrain: opts.carsPerTrain ?? DEFAULT_CARS,
    frequency: { high: 6, medium: 4, low: 2, veryLow: 1, ...opts.frequency },
    lastDispatch: -Infinity,
    suspended: opts.suspended ?? false,
    key: opts.key ?? null, // stable identity of a plan drawn on the map; null -> derived from its geometry
    external: opts.external ?? false, // seeded from the real network: not a player plan
    planOnly: opts.planOnly ?? false, // scenario drawing: visible through the plan overlay, never dispatched
    planningOptions: opts.planningOptions ? structuredClone(opts.planningOptions) : null,
  };
  state.lines.push(line);
  state.networkDirty = true;
  return line;
}

export function addPhysicalStation(state, station) {
  if (!station?.id || !Array.isArray(station.location) || station.location.length !== 2) throw new Error("A physical station requires an id and location");
  if (state.stations.has(station.id)) throw new Error(`Station ${station.id} already exists`);
  const value = { residents: 0, jobs: 0, kind: "station", named: true, status: "available", ...structuredClone(station) };
  state.stations.set(value.id, value);
  return value;
}

export function addPlatform(state, platform) {
  if (!state.stations.has(platform.stationId)) throw new Error(`Unknown platform station ${platform.stationId}`);
  if (state.platforms.some((item) => item.id === platform.id)) throw new Error(`Platform ${platform.id} already exists`);
  const value = { status: "available", ...structuredClone(platform) };
  state.platforms.push(value);
  return value;
}

export function addTrackSegment(state, segment) {
  if (!state.stations.has(segment.fromStationId) || !state.stations.has(segment.toStationId)) throw new Error("Track endpoints must be physical stations");
  if (state.trackSegments.some((item) => item.id === segment.id)) throw new Error(`Track segment ${segment.id} already exists`);
  const value = { status: "available", ...structuredClone(segment) };
  state.trackSegments.push(value);
  return value;
}

export function addStationAccessLink(state, link) {
  if (!state.demandNodes.has(link.demandNodeId)) throw new Error(`Unknown demand node ${link.demandNodeId}`);
  if (!state.stations.has(link.stationId)) throw new Error(`Unknown access station ${link.stationId}`);
  if (!(link.walkMinutes > 0)) throw new Error("Walk time must be positive");
  const key = `${link.demandNodeId}|${link.stationId}`;
  const index = state.accessLinks.findIndex((item) => `${item.demandNodeId}|${item.stationId}` === key);
  const value = structuredClone(link);
  if (index >= 0) state.accessLinks[index] = value;
  else state.accessLinks.push(value);
  state.accessVersion = (state.accessVersion ?? 0) + 1;
  return value;
}

// Kept separate from addStationAccessLink: B15 policy links intentionally
// shadow a node's automatic geometry links while an allocation is current.
// The access model owns validity filtering because a stale restored policy is
// still useful to report even when one of its operational stations vanished.
export function replaceStationDemandAllocationLinks(state, links) {
  if (!Array.isArray(links)) throw new Error("Allocation links must be an array");
  state.stationDemandAllocationLinks = structuredClone(links);
  state.stationDemandAllocationVersion = (state.stationDemandAllocationVersion ?? 0) + 1;
  return structuredClone(state.stationDemandAllocationLinks);
}

export function setLineSuspended(state, lineId, suspended) {
  const line = state.lines.find((l) => l.id === lineId);
  if (!line || line.suspended === Boolean(suspended)) return false;
  line.suspended = Boolean(suspended);
  if (line.suspended) state.trains = state.trains.filter((t) => t.lineId !== lineId);
  state.networkDirty = true;
  return true;
}

export function setBandFrequency(state, lineId, bandId, perHour) {
  const line = state.lines.find((l) => l.id === lineId);
  if (line) line.frequency[bandId] = Math.max(0, Math.min(20, perHour));
}

export function setCarsPerTrain(state, lineId, cars) {
  const line = state.lines.find((l) => l.id === lineId);
  if (line) line.carsPerTrain = Math.max(MIN_CARS, Math.min(MAX_CARS, cars));
}

export function renameLine(state, lineId, name) {
  const line = state.lines.find((l) => l.id === lineId);
  if (line && name.trim()) line.name = name.trim();
}

// Passengers riding or planning to ride a removed line drop back to waiting
// with no route; the next network rebuild re-routes them from where they are.
export function deleteLine(state, lineId) {
  const removed = state.lines.find((l) => l.id === lineId);
  const removedTrains = new Map(state.trains.filter((t) => t.lineId === lineId).map((t) => [t.id, t]));
  state.lines = state.lines.filter((l) => l.id !== lineId);
  state.trains = state.trains.filter((t) => t.lineId !== lineId);
  for (const p of state.passengers) {
    if (p.route?.some((h) => h.lineId === lineId)) {
      const train = removedTrains.get(p.trainId);
      if (removed && train) {
        const next = Math.max(0, Math.min(removed.stationIds.length - 1, train.segIndex + train.dir));
        p.currentStationId = removed.stationIds[train.t >= 0.5 ? next : train.segIndex];
      }
      p.state = "waiting";
      p.trainId = null;
      p.hopIndex = 0;
      p.route = null;
      p.waitingSince = state.simMinutes;
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
    p.trainId = null;
    p.hopIndex = 0;
    p.route = null;
    p.currentStationId = p.originId;
    p.waitingSince = state.simMinutes;
  }
}
