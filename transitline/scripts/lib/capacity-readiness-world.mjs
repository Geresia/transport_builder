// A small synthetic world for the service plan capacity readiness panel: the B16 service plan world (scripts/lib/service-plan-world.mjs: real
// map pipeline, plans a/b and an existing line) with an operational line over plan a, the rail capacity geometry APPLIED to it by the real
// applyRailCapacityGeometry, and B16 service plans written with the real editor and built with the real contract. It touches no file system (so
// it also loads in a browser) and says nothing about any real place.
import { buildServicePlanWorld, WORLD_PACK_ID } from "./service-plan-world.mjs";
import { applyRailCapacityGeometry, railCapacityApplicationReport } from "../../engine/src/rail-capacity-integration.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../../engine/src/state.mjs";
import { addBothDirections, addPlan, addTurnback, drawnPlansOf, newServicePlanDoc, setRoute } from "../../engine/src/map/service-plan-editor.mjs";
import { buildServicePlanExport } from "../../engine/src/map/service-plan-geometry.mjs";

export const READINESS_CASES = Object.freeze(["partial", "bare", "stale", "no-application", "no-line"]);

// the operational side: stations a0 a1 a2 and tracks ab, bc under one line, with the geometry applied to it (what the engine really does)
export function appliedWorld(world) {
  const state = createState(world.pack, { seed: 1 });
  const at = (id) => world.G.sections.flatMap((s) => [[s.fromStationId, s.startLocation], [s.toStationId, s.endLocation]]).find(([sid]) => sid === id)[1];
  const { a0, a1, a2 } = world.stations;
  for (const id of [a0, a1, a2]) addPhysicalStation(state, { id, location: at(id), status: "available" });
  addTrackSegment(state, { id: "ab", fromStationId: a0, toStationId: a1, lengthMeters: world.A0.lengthMeters, status: "available" });
  addTrackSegment(state, { id: "bc", fromStationId: a1, toStationId: a2, lengthMeters: world.A1.lengthMeters, status: "available" });
  const line = addLine(state, [a0, a1, a2]);
  line.trackSegmentIds = ["ab", "bc"];
  applyRailCapacityGeometry(state, { lineId: line.id, geometry: world.G });
  return { state, lineId: String(line.id), application: railCapacityApplicationReport(state, line.id)[0] };
}

// -> { variant, pack, geometries, applications, servicePlans (the B16 export plans), lineId } exactly what the panel is given
export function buildReadinessWorld(variant = "partial") {
  if (!READINESS_CASES.includes(variant)) throw new Error(`Unknown readiness case ${variant}`);
  const base = buildServicePlanWorld(variant === "bare" ? "bare" : "base", WORLD_PACK_ID);
  const { application, lineId } = appliedWorld(base);
  const current = variant === "stale" ? buildServicePlanWorld("next", WORLD_PACK_ID) : base; // the map changed after the application was made
  const doc = newServicePlanDoc(WORLD_PACK_ID, "1");
  const key = "plan-1";
  addPlan(doc, { key, name: "Line A", railGeometry: base.G, planKind: "regular", operatingPattern: "full", operationalLineId: variant === "no-line" ? null : variant === "no-application" ? "line:elsewhere" : lineId });
  setRoute(doc, key, { sectionIds: [base.A0.sectionId, base.A1.sectionId] }, base.G);
  addBothDirections(doc, key, base.stations.a0, base.stations.a2, ["Outbound", "Inbound"]);
  // a turnback at the first station with a stated terminal and its turnback track, and one at the last station with nothing chosen
  const terminal = base.G.terminals?.find((t) => t.key === "t-a0");
  addTurnback(doc, key, { stationId: base.stations.a0, intent: "route-end", ...(terminal ? { terminalResourceId: terminal.terminalResourceId, turnbackCandidateId: terminal.turnbackCandidates?.[0]?.turnbackCandidateId } : {}) });
  addTurnback(doc, key, { stationId: base.stations.a2, intent: "route-end" });
  const applications = variant === "no-application" ? [] : [application];
  const servicePlans = buildServicePlanExport({ pack: base.pack, railGeometries: [current.G], applications, plans: drawnPlansOf(doc) }).plans;
  return { variant, pack: base.pack, geometries: [current.G], applications, servicePlans, lineId, base, current };
}
