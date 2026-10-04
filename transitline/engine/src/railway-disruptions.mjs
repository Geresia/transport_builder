import { syncRailwayControlOrders } from "./railway-service-control.mjs";

export const RAILWAY_DISRUPTION_SCHEMA = "transitline.railway-disruption/1";

export const RAILWAY_DISRUPTION_KINDS = Object.freeze({
  "vehicle-failure": Object.freeze({ scope: "train", closed: true, speedLimitMps: 0, minimumMinutes: 15, maximumMinutes: 75 }),
  "signal-failure": Object.freeze({ scope: "section", closed: true, speedLimitMps: 0, minimumMinutes: 10, maximumMinutes: 60 }),
  "track-obstruction": Object.freeze({ scope: "section", closed: true, speedLimitMps: 0, minimumMinutes: 20, maximumMinutes: 120 }),
  "severe-weather": Object.freeze({ scope: "section", closed: false, speedLimitMps: 10, minimumMinutes: 30, maximumMinutes: 180 }),
  "construction-incident": Object.freeze({ scope: "section", closed: true, speedLimitMps: 0, minimumMinutes: 30, maximumMinutes: 240 }),
});

const SECTION_KIND_WEIGHTS = Object.freeze([
  ["signal-failure", 0.42],
  ["track-obstruction", 0.28],
  ["severe-weather", 0.24],
  ["construction-incident", 0.06],
]);
const SECTION_EVENT_PROBABILITY_PER_HOUR = 0.00003;
const DEFAULT_RNG_STATE = 0x4b1d5eed;

const clone = (value) => structuredClone(value);
const textId = (value) => value === null || value === undefined ? null : String(value);
const ongoing = (event) => event.status === "active" || event.status === "responding";

function nextRandom(store) {
  let t = (store.rngState = ((store.rngState ?? DEFAULT_RNG_STATE) + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function ensureRailwayDisruptionState(state) {
  if (!state.railwayDisruptions || typeof state.railwayDisruptions !== "object") {
    state.railwayDisruptions = {
      events: [],
      nextSequence: 1,
      lastEvaluatedHour: Math.floor((state.simMinutes ?? 0) / 60),
      rngState: DEFAULT_RNG_STATE,
    };
  }
  const store = state.railwayDisruptions;
  store.events ??= [];
  store.nextSequence ??= Math.max(0, ...store.events.map((event) => Number(String(event.id ?? "").split(":").at(-1)) || 0)) + 1;
  store.lastEvaluatedHour ??= Math.floor((state.simMinutes ?? 0) / 60);
  store.rngState = (store.rngState ?? DEFAULT_RNG_STATE) >>> 0;
  return store;
}

function requireLine(state, lineId) {
  const line = state.lines?.find((entry) => textId(entry.id) === textId(lineId));
  if (!line) throw new Error(`Unknown disruption line ${lineId}`);
  return line;
}

function requireSegment(state, trackSegmentId) {
  const segment = state.trackSegments?.find((entry) => textId(entry.id) === textId(trackSegmentId));
  if (!segment) throw new Error(`Unknown disruption track segment ${trackSegmentId}`);
  return segment;
}

function requireTrain(state, trainId) {
  const train = state.trains?.find((entry) => textId(entry.id) === textId(trainId));
  if (!train) throw new Error(`Unknown disruption train ${trainId}`);
  return train;
}

function targetAlreadyActive(store, kind, trackSegmentId, blockId, trainId) {
  return (store?.events ?? []).some((event) => ongoing(event)
    && event.kind === kind
    && event.trackSegmentId === trackSegmentId
    && (event.blockId ?? null) === blockId
    && event.trainId === trainId);
}

export function createRailwayDisruption(state, input = {}) {
  const spec = RAILWAY_DISRUPTION_KINDS[input.kind];
  if (!spec) throw new Error(`Unknown railway disruption kind ${input.kind}`);
  const startedAtMinute = Number(input.startedAtMinute ?? state.simMinutes);
  if (!Number.isFinite(startedAtMinute)) throw new Error("Railway disruption start time must be finite");
  const line = requireLine(state, input.lineId);
  let segment = null;
  let train = null;
  let blockId = null;
  if (spec.scope === "section") {
    segment = requireSegment(state, input.trackSegmentId);
    if (!(line.trackSegmentIds ?? []).map(textId).includes(textId(segment.id))) throw new Error(`Track segment ${segment.id} is not used by line ${line.id}`);
    if (input.blockId !== null && input.blockId !== undefined) {
      if (!Array.isArray(segment.railwayBlocks)) throw new Error(`Track segment ${segment.id} has no confirmed block data`);
      const block = segment.railwayBlocks.find((entry) => textId(entry.blockId) === textId(input.blockId));
      if (!block) throw new Error(`Unknown railway block ${input.blockId} on track segment ${segment.id}`);
      blockId = textId(block.blockId);
    }
  } else {
    train = requireTrain(state, input.trainId);
    if (textId(train.lineId) !== textId(line.id)) throw new Error(`Train ${train.id} does not belong to line ${line.id}`);
  }
  const existingStore = state.railwayDisruptions;
  const trackSegmentId = textId(segment?.id ?? input.trackSegmentId);
  const trainId = textId(train?.id ?? input.trainId);
  if (targetAlreadyActive(existingStore, input.kind, trackSegmentId, blockId, trainId)) throw new Error("The same railway disruption is already active on this target");
  const durationMinutes = Number(input.durationMinutes ?? spec.minimumMinutes);
  if (!(Number.isFinite(durationMinutes) && durationMinutes > 0)) throw new Error("Railway disruption duration must be positive");
  const speedLimitMps = input.speedLimitMps === undefined ? spec.speedLimitMps : Number(input.speedLimitMps);
  if (!(Number.isFinite(speedLimitMps) && speedLimitMps >= 0)) throw new Error("Railway disruption speed limit must be a non-negative number");
  const closed = input.closed === undefined ? spec.closed : Boolean(input.closed);
  if (closed && speedLimitMps !== 0) throw new Error("A closed railway disruption must have a zero speed limit");
  if (!closed && speedLimitMps <= 0) throw new Error("An open railway restriction must have a positive speed limit");
  const derivedSequence = existingStore?.nextSequence
    ?? Math.max(0, ...(existingStore?.events ?? []).map((event) => Number(String(event.id ?? "").split(":").at(-1)) || 0)) + 1;
  const id = input.id ?? `railway-disruption:${derivedSequence}`;
  if (!(typeof id === "string" && id) || (existingStore?.events ?? []).some((event) => event.id === id)) throw new Error(`Duplicate or invalid railway disruption id ${id}`);
  const event = {
    schema: RAILWAY_DISRUPTION_SCHEMA,
    contractVersion: 1,
    id,
    kind: input.kind,
    status: "active",
    lineId: textId(line.id),
    trackSegmentId,
    blockId,
    trainId,
    startedAtMinute,
    expectedEndMinute: startedAtMinute + durationMinutes,
    resolvedAtMinute: null,
    resolutionReason: null,
    severity: input.severity ?? (closed ? "major" : "minor"),
    effect: { closed, speedLimitMps },
    infrastructureOwnerId: input.infrastructureOwnerId ?? line.infrastructureOwnerId ?? null,
    operatorId: input.operatorId ?? line.operatorId ?? (line.owned ? "player" : null),
    responsibility: input.responsibility ?? "unknown",
    source: input.source ?? "simulation",
  };
  const store = ensureRailwayDisruptionState(state);
  store.events.push(event);
  store.events.sort((a, b) => a.startedAtMinute - b.startedAtMinute || a.id.localeCompare(b.id));
  const numericSequence = Number(String(id).split(":").at(-1));
  store.nextSequence = Math.max(store.nextSequence + (input.id ? 0 : 1), Number.isInteger(numericSequence) ? numericSequence + 1 : store.nextSequence);
  return clone(event);
}

export function resolveRailwayDisruption(state, eventId, { atMinute = state.simMinutes, reason = "recovered" } = {}) {
  const event = state.railwayDisruptions?.events?.find((entry) => entry.id === eventId);
  if (!event) throw new Error(`Unknown railway disruption ${eventId}`);
  if (!ongoing(event)) throw new Error(`Railway disruption ${eventId} is already ${event.status}`);
  if (!(Number.isFinite(atMinute) && atMinute >= event.startedAtMinute)) throw new Error("Railway disruption resolution time is invalid");
  event.status = "resolved";
  event.resolvedAtMinute = atMinute;
  event.resolutionReason = reason;
  syncRailwayControlOrders(state, atMinute);
  return clone(event);
}

function resolveExpired(state, atMinute) {
  const store = ensureRailwayDisruptionState(state);
  const resolved = [];
  for (const event of store.events) {
    if (!ongoing(event) || event.expectedEndMinute > atMinute + 1e-9) continue;
    event.status = "resolved";
    event.resolvedAtMinute = event.expectedEndMinute;
    event.resolutionReason = "natural-recovery";
    resolved.push(clone(event));
  }
  return resolved;
}

function chooseSectionKind(roll) {
  let cursor = 0;
  for (const [kind, weight] of SECTION_KIND_WEIGHTS) {
    cursor += weight;
    if (roll < cursor) return kind;
  }
  return SECTION_KIND_WEIGHTS.at(-1)[0];
}

function durationFor(spec, roll) {
  return Math.round(spec.minimumMinutes + (spec.maximumMinutes - spec.minimumMinutes) * roll);
}

function lineForSegment(state, segmentId) {
  return [...(state.lines ?? [])]
    .filter((line) => !line.planOnly && (line.trackSegmentIds ?? []).map(textId).includes(textId(segmentId)))
    .sort((a, b) => textId(a.id).localeCompare(textId(b.id)))[0] ?? null;
}

export function evaluateRailwayDisruptionHour(state, hour, { probabilityMultiplier = 1 } = {}) {
  const store = ensureRailwayDisruptionState(state);
  const created = [];
  const atMinute = hour * 60;
  const segments = [...(state.trackSegments ?? [])].filter((segment) => segment.status === undefined || segment.status === "available")
    .sort((a, b) => textId(a.id).localeCompare(textId(b.id)));
  for (const segment of segments) {
    const line = lineForSegment(state, segment.id);
    if (!line || nextRandom(store) >= SECTION_EVENT_PROBABILITY_PER_HOUR * probabilityMultiplier) continue;
    const kind = chooseSectionKind(nextRandom(store));
    const spec = RAILWAY_DISRUPTION_KINDS[kind];
    if (targetAlreadyActive(store, kind, textId(segment.id), null, null)) continue;
    created.push(createRailwayDisruption(state, {
      kind,
      lineId: line.id,
      trackSegmentId: segment.id,
      startedAtMinute: atMinute,
      durationMinutes: durationFor(spec, nextRandom(store)),
      source: "hourly-hazard",
    }));
  }
  return created;
}

export function advanceRailwayDisruptions(state) {
  const store = ensureRailwayDisruptionState(state);
  const now = Number(state.simMinutes ?? 0);
  const resolved = resolveExpired(state, now);
  const currentHour = Math.floor(now / 60);
  const created = [];
  while (store.lastEvaluatedHour < currentHour) {
    store.lastEvaluatedHour++;
    created.push(...evaluateRailwayDisruptionHour(state, store.lastEvaluatedHour));
  }
  syncRailwayControlOrders(state, now);
  return { created, resolved };
}

export function railwayDisruptionEffect(state, { lineId, trackSegmentId = null, blockId = null, trainId = null } = {}) {
  const events = (state.railwayDisruptions?.events ?? []).filter((event) => ongoing(event)
    && event.startedAtMinute <= state.simMinutes + 1e-9
    && ((event.trainId !== null && textId(event.lineId) === textId(lineId) && textId(event.trainId) === textId(trainId))
      || (event.trackSegmentId !== null
        && textId(event.trackSegmentId) === textId(trackSegmentId)
        && (event.blockId === null || textId(event.blockId) === textId(blockId)))));
  if (!events.length) return { active: false, closed: false, speedLimitMps: null, eventIds: [], kinds: [] };
  const limits = events.map((event) => event.effect?.speedLimitMps).filter(Number.isFinite);
  return {
    active: true,
    closed: events.some((event) => event.effect?.closed === true),
    speedLimitMps: limits.length ? Math.min(...limits) : null,
    eventIds: events.map((event) => event.id).sort(),
    kinds: [...new Set(events.map((event) => event.kind))].sort(),
  };
}

export function railwayDisruptionReport(state) {
  const events = state?.railwayDisruptions?.events ?? [];
  return {
    schema: "transitline.railway-disruption-report/1",
    contractVersion: 1,
    activeCount: events.filter((event) => ongoing(event)).length,
    events: clone(events),
  };
}
