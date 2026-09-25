const STRUCTURES = new Set(["surface", "elevated", "cut-cover", "shield", "deep", "bridge", "embankment", "cutting"]);
const DATA_QUALITIES = new Set(["high", "medium", "low", "unknown"]);
const PLATFORM_TYPES = new Set(["side", "island", "two-side", "two-face-three-track", "two-face-four-track"]);
export const PLAN_GEOMETRY_VERSION = 1;
export const PLAN_GEOMETRY_SCHEMA = "transitline.plan-geometry/1";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function planFingerprint(plan) {
  const text = canonical(plan);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function cityPackToDomain(pack) {
  const demandNodes = (pack.demand?.points ?? []).map((point) => ({
    id: point.id,
    name: point.name ?? point.id,
    location: [...point.location],
    residents: point.residents ?? 0,
    jobs: point.jobs ?? 0,
    kind: point.kind ?? "mixed",
  }));
  const externalNetworks = pack.existingNetwork ? [{
    id: `external:${pack.manifest?.id ?? "pack"}`,
    owner: "external",
    lines: structuredClone(pack.existingNetwork.lines ?? []),
  }] : [];
  return { demandNodes, accessLinks: [], stations: [], platforms: [], trackSegments: [], serviceLines: [], vehicleUnits: [], externalNetworks };
}

export function addAccessLink(domain, link) {
  if (!domain.demandNodes.some((node) => node.id === link.demandNodeId)) throw new Error(`Unknown demand node ${link.demandNodeId}`);
  if (!domain.stations.some((station) => station.id === link.stationId)) throw new Error(`Unknown station ${link.stationId}`);
  if (!(link.walkMinutes > 0)) throw new Error("Access time must be positive");
  domain.accessLinks.push({ ...link });
}

export function validatePlanGeometry(plan) {
  const violations = [];
  const missingInputs = [];
  if (!plan?.planId) missingInputs.push("planId");
  if (plan?.schema !== undefined && plan.schema !== PLAN_GEOMETRY_SCHEMA) violations.push(`Unsupported PlanGeometry schema ${plan.schema}`);
  if (plan?.contractVersion !== undefined && plan.contractVersion !== PLAN_GEOMETRY_VERSION) violations.push(`Unsupported PlanGeometry version ${plan.contractVersion}`);
  if (plan?.schema === undefined && plan?.contractVersion === undefined) missingInputs.push("schema or contractVersion");
  if (!plan?.coordinateReference) missingInputs.push("coordinateReference");
  if (!plan?.sourcePackId) missingInputs.push("sourcePackId");
  if (!plan?.sourcePackVersion) missingInputs.push("sourcePackVersion");
  if (!Array.isArray(plan?.stationCandidates) || plan.stationCandidates.length < 2) violations.push("At least two station candidates are required");
  if (!Array.isArray(plan?.segments) || plan.segments.length < 1) violations.push("At least one segment is required");
  const stationIds = new Set();
  for (const station of plan?.stationCandidates ?? []) {
    if (!station.id) missingInputs.push("stationCandidates[].id");
    if (stationIds.has(station.id)) violations.push(`Duplicate station ${station.id}`);
    stationIds.add(station.id);
    if (!Array.isArray(station.location) || station.location.length !== 2 || station.location.some((value) => !Number.isFinite(value))) missingInputs.push(`stationCandidates.${station.id ?? "unknown"}.location`);
    if (!station.platformType) missingInputs.push(`stationCandidates.${station.id ?? "unknown"}.platformType`);
    else if (!PLATFORM_TYPES.has(station.platformType)) violations.push(`Station ${station.id} has unsupported platform type ${station.platformType}`);
    if (station.structure !== undefined && !STRUCTURES.has(station.structure)) violations.push(`Station ${station.id} has unsupported structure ${station.structure}`);
  }
  const segmentKeys = new Set();
  for (const [index, segment] of (plan?.segments ?? []).entries()) {
    if (!(segment.lengthMeters > 0)) violations.push(`Segment ${index} length must be positive`);
    if (!STRUCTURES.has(segment.structureHint)) violations.push(`Segment ${index} has unsupported structure ${segment.structureHint}`);
    if (segment.dataQuality === undefined) missingInputs.push(`segments.${index}.dataQuality`);
    else if (!DATA_QUALITIES.has(segment.dataQuality)) violations.push(`Segment ${index} has unsupported data quality ${segment.dataQuality}`);
    if (!segment.from || !segment.to) missingInputs.push(`segments.${index}.from/to`);
    if (segment.from && !stationIds.has(segment.from)) violations.push(`Segment ${index} references unknown station ${segment.from}`);
    if (segment.to && !stationIds.has(segment.to)) violations.push(`Segment ${index} references unknown station ${segment.to}`);
    if (segment.from && segment.from === segment.to) violations.push(`Segment ${index} cannot connect a station to itself`);
    const key = [segment.from, segment.to].sort().join("|");
    if (segmentKeys.has(key)) violations.push(`Segment ${index} duplicates ${key}`);
    segmentKeys.add(key);
  }
  const accessIds = new Set();
  for (const [index, link] of (plan?.accessLinks ?? []).entries()) {
    if (!link.id || !link.demandNodeId) missingInputs.push(`accessLinks.${index}.id/demandNodeId`);
    const stationId = link.stationCandidateId ?? link.stationId;
    if (!stationId) missingInputs.push(`accessLinks.${index}.stationCandidateId`);
    else if (!stationIds.has(stationId)) violations.push(`Access link ${index} references unknown station ${stationId}`);
    if (!(link.walkMinutes > 0)) violations.push(`Access link ${index} walkMinutes must be positive`);
    if (link.id && accessIds.has(link.id)) violations.push(`Duplicate access link ${link.id}`);
    accessIds.add(link.id);
  }
  const buildable = violations.length ? false : missingInputs.length ? "conditional" : true;
  return { buildable, violations, missingInputs };
}

export function createPlanRecord(existingRecords, plan, technicalProfileId, assessment, submittedAt) {
  const previous = existingRecords.filter((record) => record.planId === plan.planId).sort((a, b) => b.version - a.version)[0];
  const normalizedGeometry = { contractVersion: PLAN_GEOMETRY_VERSION, schema: PLAN_GEOMETRY_SCHEMA, ...structuredClone(plan) };
  const fingerprint = planFingerprint(normalizedGeometry);
  if (previous?.fingerprint === fingerprint) throw new Error(`Plan ${plan.planId} version is unchanged`);
  if (previous && ["approved", "in-project", "commissioned"].includes(previous.status)) throw new Error(`Plan ${plan.planId} can no longer be revised`);
  const version = (previous?.version ?? 0) + 1;
  return {
    id: `plan:${plan.planId}:v${version}`,
    planId: plan.planId,
    version,
    fingerprint,
    technicalProfileId,
    submittedAt,
    status: assessment.buildable === false ? "rejected" : assessment.buildable === "conditional" ? "needs-information" : "assessed",
    assessment: structuredClone(assessment),
    geometry: normalizedGeometry,
  };
}
