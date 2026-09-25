const STRUCTURES = new Set(["surface", "elevated", "cut-cover", "shield", "deep", "bridge", "embankment", "cutting"]);

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
  if (!plan?.coordinateReference) missingInputs.push("coordinateReference");
  if (!Array.isArray(plan?.stationCandidates) || plan.stationCandidates.length < 2) violations.push("At least two station candidates are required");
  if (!Array.isArray(plan?.segments) || plan.segments.length < 1) violations.push("At least one segment is required");
  const stationIds = new Set();
  for (const station of plan?.stationCandidates ?? []) {
    if (!station.id) missingInputs.push("stationCandidates[].id");
    if (stationIds.has(station.id)) violations.push(`Duplicate station ${station.id}`);
    stationIds.add(station.id);
    if (!Array.isArray(station.location) || station.location.length !== 2) missingInputs.push(`stationCandidates.${station.id ?? "unknown"}.location`);
    if (!station.platformType) missingInputs.push(`stationCandidates.${station.id ?? "unknown"}.platformType`);
  }
  for (const [index, segment] of (plan?.segments ?? []).entries()) {
    if (!(segment.lengthMeters > 0)) violations.push(`Segment ${index} length must be positive`);
    if (!STRUCTURES.has(segment.structureHint)) violations.push(`Segment ${index} has unsupported structure ${segment.structureHint}`);
    if (segment.dataQuality === undefined) missingInputs.push(`segments.${index}.dataQuality`);
  }
  const buildable = violations.length ? false : missingInputs.length ? "conditional" : true;
  return { buildable, violations, missingInputs };
}
