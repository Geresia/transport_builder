// A small synthetic world for the map mount tests: plans a (a0 a1 a2) and b (a2 b1 b2) along lat 35, an existing line E1
// (d1..d3), and, per mode, a way to give the section a1-a2 a detour:
//   "none":   only plans a and b
//   "ext":    a loop through the existing line (handovers between differing stations, no alignment on the existing line)
//   "apart":  a loop through plan c whose two handovers join stations 100 m apart (measured apart)
//   "joined": plan c drawn between a1 and a2 themselves (shared stations, alignments that meet)
// The plans run 55 m north of the existing line's stations, so that no two stations share a position.
import assert from "node:assert/strict";
import { buildMapExport } from "../../src/map/plan-geometry.mjs";
import { stableId } from "../../src/map/ids.mjs";
import { buildRailGeometry, planRevisionOf } from "../../src/map/rail-capacity-geometry.mjs";
import { buildThroughRoute } from "../../src/map/through-route.mjs";
import { buildRailwayDisruptionSite } from "../../src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl } from "../../src/map/railway-service-control.mjs";

export const pack = {
  manifest: { id: "t", version: "1", origin: [139, 35], data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
export const EXT = "ext-line:42";
export const Y = 35.0005;
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
export const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
export const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
export const trackId = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
export const applicationOf = (g) => ({ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sections: g.sections.map((s) => ({ trackSegmentId: trackId(g, s), railCapacitySectionId: s.sectionId })) });
export const eventOf = (id, trackSegmentId, over = {}) => ({
  schema: "transitline.railway-disruption/1", contractVersion: 1, id, kind: "signal-failure", status: "active", lineId: "line:1", trackSegmentId, blockId: null, trainId: null,
  startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null, severity: "major", effect: { closed: true, speedLimitMps: 0 }, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "simulation", ...over,
});

export function makeWorld(mode = "none") {
  const drawn = [line("a", [[139, Y], [139.01, Y], [139.02, Y]]), line("b", [[139.02, Y], [139.03, Y], [139.04, Y]])];
  if (mode === "joined") drawn.push(line("c", [[139.01, Y], [139.015, Y + 0.003], [139.02, Y]]));
  if (mode === "apart") drawn.push(line("c", [[139.011, Y + 0.001], [139.019, Y + 0.001]]));
  const map = buildMapExport({ pack, mode: "existing", drawnLines: drawn });
  const plan = (k) => map.plans.find((p) => p.planId === stableId("plan", "t", "key", k));
  const [A, B, C] = [plan("a"), plan("b"), mode === "joined" || mode === "apart" ? plan("c") : null];
  const legs = mode === "ext" ? [
    { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
    { sourceKind: "external", key: "l2", externalLineId: EXT, fromStationId: "d1", toStationId: "d3", infrastructureOwnerId: "owner:other" },
    { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
  ] : mode === "apart" ? [
    { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
    { sourceKind: "planned", key: "l2", planId: C.planId, infrastructureOwnerId: "owner:other" },
    { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
  ] : null;
  const route = legs ? buildThroughRoute({ key: "r", legs }, { pack, plans: map.plans, externalNetworks: map.externalNetworks }).route : null;
  const planIds = [A.planId, B.planId, ...(C ? [C.planId] : [])];
  const G = buildRailGeometry({
    key: "g", planIds, externalLineIds: mode === "ext" ? [EXT] : [], ...(route ? { throughRouteId: route.throughRouteId } : {}),
    designedRevisions: { ...revisionsOf(A, B, ...(C ? [C] : [])), routes: route ? { [route.throughRouteId]: route.geometryRevision } : {} },
  }, { pack, plans: map.plans, externalNetworks: map.externalNetworks, routes: route ? [route] : [] }).design;
  assert.ok(G);
  return {
    mode, map, plans: map.plans, A, B, C, route, G, APP: applicationOf(G), A0: sectionOf(G, A, 0), A1: sectionOf(G, A, 1), B0: sectionOf(G, B, 0),
    a0: A.segments[0].from, a1: A.segments[0].to, a2: A.segments[1].to, EXT_SECTION: G.sections.find((s) => s.sourceKind === "external") ?? null,
  };
}

// the M6 site and the M7 control geometry of an event on a section of a world
export function siteAndControl(world, n = 1, section = world.A1, drawn = {}) {
  const event = eventOf(`railway-disruption:${n}`, trackId(world.G, section));
  const site = buildRailwayDisruptionSite({ eventId: event.id, designedRailGeometryRevision: world.G.railGeometryRevision, ...drawn }, { pack, events: [event], railGeometry: world.G, applications: [world.APP] }).site;
  assert.ok(site);
  const out = buildRailwayServiceControl({ eventId: event.id }, { pack, site, railGeometry: world.G, application: world.APP, routes: world.route ? [world.route] : [], externalNetworks: world.map.externalNetworks });
  assert.ok(out.control, JSON.stringify(out.warnings));
  return { event, site, control: out.control };
}
