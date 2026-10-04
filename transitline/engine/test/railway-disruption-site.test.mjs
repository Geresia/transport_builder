import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import { buildRailGeometry, planRevisionOf } from "../src/map/rail-capacity-geometry.mjs";
import {
  RAILWAY_DISRUPTION_SITE_EXPORT_SCHEMA, RAILWAY_DISRUPTION_SITE_SCHEMA, buildRailwayDisruptionSite, buildRailwayDisruptionSiteExport, disruptionSiteIdOf, snapToSection,
} from "../src/map/railway-disruption-site.mjs";
import * as editorModule from "../src/map/railway-disruption-site-editor.mjs";
import {
  activeSites, addSite, clearAffectedPolygon, clearLocation, deactivateSite, newRailwayDisruptionDoc, rebindRailGeometry, restoreRailwayDisruptionDoc, restoreSite,
  serializeRailwayDisruptionDoc, setAffectedPolygon, setLocation, setSectionLink, toDrawnSite,
} from "../src/map/railway-disruption-site-editor.mjs";
import {
  EFFECT_STYLES, STATUS_STYLES, buildRailwayDisruptionView, drawRailwayDisruptionOverlay, renderRailwayDisruptionLegend, renderRailwayDisruptionPanel,
} from "../src/map/railway-disruption-site-view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: a rail capacity geometry over plans along lat 35 ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const mapExport = buildMapExport({ pack, mode: "existing", drawnLines: [line("a", [[139, 35], [139.01, 35], [139.02, 35]]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]])] });
const planOf = (key) => mapExport.plans.find((p) => p.planId === stableId("plan", "t", "key", key));
const A = planOf("a");
const B = planOf("b");
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const E = [139.02, 35];
const EXT = "ext-line:42";
const boundary = (key, plan, i, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: plan.segments[i].from, alongMeters, basis: "player" });
const geometryOf = (extra = {}) => {
  const out = buildRailGeometry({ key: "g", planIds: [A.planId, B.planId], externalLineIds: [EXT], designedRevisions: revisionsOf(A, B), ...extra }, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, routes: [] });
  assert.ok(out.design, JSON.stringify(out.warnings));
  return out.design;
};
// the full geometry: three blocks in A's first section, a turnout in the middle block and one at A's end, a terminal at A's end
const G = geometryOf({
  blockBoundaries: [boundary("b1", A, 0, 300), boundary("b2", A, 0, 600)],
  junctions: [
    { key: "mid", kind: "turnout", location: [139.0045, 35], connections: [{ ...ref(A, 0), role: "stem" }] },
    { key: "end", kind: "turnout", location: E, connections: [{ ...ref(A, 1), role: "stem" }, { ...ref(B, 0), role: "main" }] },
  ],
  terminals: [{ key: "t1", stationId: A.segments[1].to, platforms: [{ key: "p1", approach: ref(A, 1), polyline: [E, [139.0212, 35]], platformLengthMeters: 120 }] }],
});
const BARE = geometryOf();
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const A0 = sectionOf(G, A, 0);
const A1 = sectionOf(G, A, 1);
const EXT_SECTION = G.sections.find((s) => s.sourceKind === "external");
const blocksOf = (g, section) => g.blocks.filter((b) => b.sectionId === section.sectionId).sort((a, b) => a.startAlongMeters - b.startAlongMeters);
const trackId = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g, extra = {}) => ({ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sections: g.sections.map((s) => ({ trackSegmentId: trackId(g, s), railCapacitySectionId: s.sectionId })), ...extra });
const APP = applicationOf(G);
const ev = (n, over = {}) => ({
  schema: "transitline.railway-disruption/1", contractVersion: 1, id: `railway-disruption:${n}`, kind: "signal-failure", status: "active", lineId: "line:1",
  trackSegmentId: trackId(G, A0), blockId: null, trainId: null, startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null,
  severity: "major", effect: { closed: true, speedLimitMps: 0 }, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "simulation", ...over,
});
const alongPoint = (section, fraction) => {
  const [a, b] = [section.startLocation, section.endLocation];
  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
};
const drawn = (n, extra = {}) => ({ eventId: `railway-disruption:${n}`, designedRailGeometryRevision: G.railGeometryRevision, ...extra });
const build = (d, events, extra = {}) => {
  const out = buildRailwayDisruptionSite(d, { pack, events, railGeometry: G, applications: [APP], ...extra });
  assert.ok(out.site, JSON.stringify(out.warnings));
  return out.site;
};
const rejected = (d, events, code, extra = {}) => {
  const out = buildRailwayDisruptionSite(d, { pack, events, railGeometry: G, applications: [APP], ...extra });
  assert.equal(out.site, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
// no cost, probability, drivability verdict, recovery time, delay or capacity field; id-bearing path keys are not field names
// (railCapacitySectionId / railGeometryId name the rail capacity contract itself and are required fields; a bare "capacity" is not)
const FORBIDDEN = /cost|price|fee|cash|probab|verdict|possible|approval|score|delay|duration|recover|expectedEnd|resolvedAt|startedAt|eta|(?<!rail)capacity|trainsPerHour|headway|timetable|throughput|severity|responsib|owner|operator/i;
const fieldNames = (value) => [...keysDeep(value)].filter((k) => !k.includes(":"));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
function assertUnknownContract(value, where = "site") {
  if (Array.isArray(value)) return value.forEach((v, i) => assertUnknownContract(v, `${where}[${i}]`));
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.unknown) && value.unknownReasons && typeof value.unknownReasons === "object") {
    assert.deepEqual([...value.unknown].sort(), Object.keys(value.unknownReasons).sort(), `${where}: unknown and unknownReasons are 1:1`);
    for (const f of value.unknown) {
      if (!f.includes(":")) assert.ok(value[f] === null || value[f] === undefined, `${where}.${f} is unknown so it must be null`);
      assert.equal(typeof value.unknownReasons[f], "string", `${where}.${f} has a reason`);
    }
  }
  for (const [k, v] of Object.entries(value)) if (k !== "unknown" && k !== "unknownReasons" && k !== "warnings") assertUnknownContract(v, `${where}.${k}`);
}

// --- identity ---
test("same input gives the same disruptionSiteId and byte-identical JSON", () => {
  const events = [ev(1)];
  const d = drawn(1, { location: alongPoint(A0, 0.4) });
  const site = build(d, events);
  assert.equal(JSON.stringify(site), JSON.stringify(build(structuredClone(d), structuredClone(events))));
  assert.equal(site.disruptionSiteId, disruptionSiteIdOf("t", "railway-disruption:1"));
  assert.equal(site.schema, RAILWAY_DISRUPTION_SITE_SCHEMA);
  assert.equal(site.contractVersion, 1);
  assert.deepEqual([site.eventId, site.railGeometryId, site.railGeometryRevision], ["railway-disruption:1", G.railGeometryId, G.railGeometryRevision]);
});

test("the id follows the event and the pack; the location, the polygon, the event order and the key order of the input change nothing", () => {
  const events = [ev(1), ev(2, { trackSegmentId: trackId(G, A1) })];
  const plain = build(drawn(1), events);
  const edited = build(drawn(1, { location: alongPoint(A0, 0.2), affectedPolygon: [[139, 35], [139.002, 35], [139.002, 35.001]] }), events);
  assert.equal(edited.disruptionSiteId, plain.disruptionSiteId);
  assert.notEqual(edited.siteRevision, plain.siteRevision);
  const reordered = build({ designedRailGeometryRevision: G.railGeometryRevision, eventId: "railway-disruption:1" }, [...events].reverse());
  assert.equal(JSON.stringify(reordered), JSON.stringify(plain));
  assert.notEqual(build(drawn(2), events).disruptionSiteId, plain.disruptionSiteId);
  assert.notEqual(disruptionSiteIdOf("other", "railway-disruption:1"), plain.disruptionSiteId);
});

test("event, geometry and id links are validated", () => {
  rejected(drawn(9), [ev(1)], "event-missing");
  rejected({ designedRailGeometryRevision: "x" }, [ev(1)], "event-missing");
  rejected(drawn(1), [ev(1, { schema: "other/1" })], "event-schema-invalid");
  rejected(drawn(1), [ev(1, { kind: 3 })], "event-kind-invalid");
  rejected(drawn(1), [ev(1, { trackSegmentId: null, trainId: null })], "event-target-missing");
  rejected(drawn(1), [ev(1)], "rail-geometry-schema-invalid", { railGeometry: { ...G, schema: "other/1" } });
  rejected(drawn(1), [ev(1)], "rail-geometry-other-pack", { railGeometry: { ...G, sourcePackId: "elsewhere" } });
  rejected(drawn(1, { location: ["x", 1] }), [ev(1)], "location-invalid");
  rejected(drawn(1, { location: alongPoint(A0, 0.5), locationBasis: "guess" }), [ev(1)], "location-basis-invalid");
  rejected(drawn(1, { railCapacitySectionId: "rail-section:nope" }), [ev(1, { trackSegmentId: "track-segment:unlinked" })], "section-missing");
  const w = buildRailwayDisruptionSite(drawn(1), { pack, events: [ev(1, { kind: "meteor" })], railGeometry: G, applications: [APP] });
  assert.ok(w.site, "an unknown kind is carried, not rejected");
  assert.equal(w.site.kind, "meteor");
  assert.deepEqual(w.warnings.map((x) => x.code), ["kind-not-known"]);
});

test("the section is found through the application (operational track -> map section), else by an explicit id; the two must agree", () => {
  const viaApp = build(drawn(1), [ev(1)]);
  assert.equal(viaApp.railCapacitySectionId, A0.sectionId);
  assert.equal(viaApp.sectionLinkBasis, "application");
  assert.equal(viaApp.trackSegmentId, trackId(G, A0));
  const explicit = build(drawn(1, { railCapacitySectionId: A1.sectionId }), [ev(1, { trackSegmentId: "track-segment:unlinked" })]);
  assert.equal(explicit.railCapacitySectionId, A1.sectionId);
  assert.equal(explicit.sectionLinkBasis, "explicit");
  assert.equal(build(drawn(1, { railCapacitySectionId: A0.sectionId }), [ev(1)]).railCapacitySectionId, A0.sectionId);
  const w = rejected(drawn(1, { railCapacitySectionId: A1.sectionId }), [ev(1)], "section-link-conflict");
  assert.deepEqual([w.mapped, w.explicit], [A0.sectionId, A1.sectionId]);
});

test("an event not yet linked to a map section is null with the reason, not rejected and not guessed", () => {
  const site = build(drawn(1), [ev(1, { trackSegmentId: "track-segment:unlinked" })]);
  assert.equal(site.railCapacitySectionId, null);
  for (const f of ["railCapacitySectionId", "alignment", "affectedExtent", "affectedSectionIds", "affectedBlockIds", "affectedSignalCandidateIds", "affectedJunctionResourceIds", "affectedStationIds", "affectedTerminalResourceIds", "alternativeAccessCandidates"]) {
    assert.equal(site[f], null, f);
    assert.equal(site.unknownReasons[f], "no-section-link", f);
  }
  assert.ok(site.spatialFlags.includes("no-section-link"));
  assert.equal(site.scope, "section", "the scope is still what the event states");
  // an application made on another revision of the geometry is not used for the link
  const stale = build(drawn(1), [ev(1)], { applications: [applicationOf(G, { railGeometryRevision: "rail-geometry-revision:old" })] });
  assert.equal(stale.railCapacitySectionId, null);
  assert.equal(stale.unknownReasons.railCapacitySectionId, "rail-capacity-link-stale");
  assert.equal(build(drawn(1, { railCapacitySectionId: A0.sectionId }), [ev(1)], { applications: [applicationOf(G, { railGeometryRevision: "x" })] }).railCapacitySectionId, A0.sectionId, "an explicit link still works");
});

// --- scope: the whole section, or exactly one block ---
test("blockId null affects the whole section: every block, signal candidate and junction of it", () => {
  const site = build(drawn(1), [ev(1)]);
  assert.equal(site.scope, "section");
  assert.equal(site.blockId, null);
  assert.deepEqual(site.affectedSectionIds, [A0.sectionId]);
  assert.deepEqual(site.affectedBlockIds, A0.blockIds);
  assert.equal(site.affectedBlockIds.length, 3);
  assert.deepEqual(site.affectedSignalCandidateIds, G.signalCandidates.filter((c) => c.sectionId === A0.sectionId).map((c) => c.signalCandidateId).sort());
  assert.equal(site.affectedSignalCandidateIds.length, 4);
  assert.deepEqual(site.affectedJunctionResourceIds, A0.junctionResourceIds);
  assert.deepEqual(site.affectedStationIds, [A0.fromStationId, A0.toStationId].sort());
  assert.deepEqual(site.alignment, A0.alignment);
  assert.equal(site.affectedExtent.lengthMeters, A0.lengthMeters);
  assert.ok(site.spatialFlags.includes("whole-section-affected") && !site.spatialFlags.includes("single-block-affected"));
});

test("a blockId affects only that block: its own length and alignment, the signals at its edges, the junctions inside it", () => {
  const [b0, b1, b2] = blocksOf(G, A0);
  const middle = build(drawn(1), [ev(1, { blockId: b1.blockId })]);
  assert.equal(middle.scope, "block");
  assert.equal(middle.blockId, b1.blockId);
  assert.equal(middle.sectionLinkBasis, "block");
  assert.deepEqual(middle.affectedBlockIds, [b1.blockId]);
  assert.deepEqual(middle.affectedSectionIds, [A0.sectionId]);
  assert.equal(middle.affectedExtent.lengthMeters, b1.blockLengthMeters);
  assert.deepEqual([middle.affectedExtent.startLocation, middle.affectedExtent.endLocation], [b1.startLocation, b1.endLocation]);
  assert.ok(middle.alignment.length >= 2);
  assert.notDeepEqual(middle.alignment, A0.alignment, "a block is not the whole section");
  assert.deepEqual([middle.alignment[0], middle.alignment.at(-1)], [b1.startLocation, b1.endLocation]);
  assert.equal(middle.affectedSignalCandidateIds.length, 4, "a signal candidate each way at both edges of the middle block");
  assert.deepEqual(middle.affectedJunctionResourceIds, [G.junctions.find((j) => j.key === "mid").junctionResourceId], "only the junction whose position falls inside the block");
  assert.deepEqual(middle.affectedStationIds, [], "a block in the middle of a section touches no station: that is a fact, not unknown");
  assert.ok(!middle.unknown.includes("affectedStationIds"));
  assert.ok(middle.spatialFlags.includes("single-block-affected"));
  const first = build(drawn(1), [ev(1, { blockId: b0.blockId })]);
  assert.deepEqual(first.affectedStationIds, [A0.fromStationId]);
  assert.equal(first.affectedSignalCandidateIds.length, 2);
  assert.deepEqual(first.affectedJunctionResourceIds, []);
  const last = build(drawn(1), [ev(1, { blockId: b2.blockId })]);
  assert.deepEqual(last.affectedStationIds, [A0.toStationId]);
});

test("a block that does not exist, has no block data or belongs to another section is rejected", () => {
  rejected(drawn(1), [ev(1, { blockId: "rail-block:nope" })], "block-missing");
  const mismatch = blocksOf(G, A0)[0].blockId;
  rejected(drawn(1, { railCapacitySectionId: A1.sectionId }), [ev(1, { blockId: mismatch })], "block-section-mismatch");
  const w = rejected(drawn(1), [ev(1, { trackSegmentId: trackId(G, A1), blockId: mismatch })], "block-section-mismatch");
  assert.deepEqual([w.blockSectionId, w.mapped], [A0.sectionId, A1.sectionId]);
  const bare = rejected(drawn(1), [ev(1, { blockId: "rail-block:any" })], "block-data-missing", { railGeometry: BARE, applications: [applicationOf(BARE)] });
  assert.equal(bare.blockId, "rail-block:any");
});

test("a whole-section event on a section with no block, junction or terminal data keeps those as null, not [] or 0", () => {
  const site = build(drawn(1), [ev(1, { trackSegmentId: trackId(BARE, sectionOf(BARE, A, 0)) })], { railGeometry: BARE, applications: [applicationOf(BARE)] });
  assert.deepEqual(site.affectedSectionIds, [sectionOf(BARE, A, 0).sectionId]);
  for (const f of ["affectedBlockIds", "affectedSignalCandidateIds", "affectedJunctionResourceIds", "affectedTerminalResourceIds"]) { assert.equal(site[f], null, f); assert.ok(site.unknown.includes(f), f); }
  assert.equal(site.unknownReasons.affectedBlockIds, "no-block-data");
  assert.equal(site.unknownReasons.affectedJunctionResourceIds, "no-junction-data");
  assert.equal(site.unknownReasons.affectedTerminalResourceIds, "no-terminal-data");
  assert.ok(site.spatialFlags.includes("block-data-missing"));
  assert.equal(site.affectedStationIds.length, 2, "the stations at the section's ends are known without block data");
});

test("terminals are affected when the section is their approach; a block only when it reaches the terminal's station", () => {
  const whole = build(drawn(1), [ev(1, { trackSegmentId: trackId(G, A1) })]);
  assert.deepEqual(whole.affectedTerminalResourceIds, [G.terminals[0].terminalResourceId]);
  assert.ok(whole.spatialFlags.includes("terminal-approach-affected"));
  assert.deepEqual(build(drawn(1), [ev(1)]).affectedTerminalResourceIds, [], "A's first section is no terminal approach: a known none");
  const block = blocksOf(G, A1)[0];
  assert.deepEqual(build(drawn(1), [ev(1, { trackSegmentId: trackId(G, A1), blockId: block.blockId })]).affectedTerminalResourceIds, [G.terminals[0].terminalResourceId]);
});

// --- location ---
test("no location is null and covers the whole stretch: it is never put at the middle of the section", () => {
  const site = build(drawn(1), [ev(1)]);
  assert.equal(site.location, null);
  assert.equal(site.locationBasis, null);
  assert.equal(site.locationAttach, null);
  assert.equal(site.unknownReasons.location, "location-not-stated");
  assert.equal(site.unknownReasons.locationAttach, "location-not-stated");
  assert.ok(site.spatialFlags.includes("location-unknown"));
  assert.deepEqual(site.alignment, A0.alignment, "the whole stretch is the affected place");
  const middle = alongPoint(A0, 0.5);
  assert.equal(JSON.stringify(site).includes(JSON.stringify(middle)), false, "no field carries the middle of the section");
  const block = build(drawn(1), [ev(1, { blockId: blocksOf(G, A0)[1].blockId })]);
  assert.equal(block.location, null);
  assert.ok(block.alignment.length >= 2);
});

test("a stated location is measured against the section: along it, how far from it, and whether inside the affected extent", () => {
  const [, b1] = blocksOf(G, A0);
  const mid = (b1.startAlongMeters + b1.endAlongMeters) / 2;
  const inside = build(drawn(1, { location: alongPoint(A0, mid / A0.lengthMeters) }), [ev(1, { blockId: b1.blockId })]);
  assert.equal(inside.locationBasis, "player");
  assert.equal(inside.locationAttach.sectionId, A0.sectionId);
  assert.equal(inside.locationAttach.onSection, true);
  assert.ok(inside.locationAttach.distanceToSectionMeters <= 1);
  assert.ok(Math.abs(inside.locationAttach.alongMeters - mid) < 1.5);
  assert.equal(inside.locationAttach.withinAffectedExtent, true);
  const outside = build(drawn(1, { location: alongPoint(A0, 0.9) }), [ev(1, { blockId: b1.blockId })]);
  assert.equal(outside.locationAttach.onSection, true);
  assert.equal(outside.locationAttach.withinAffectedExtent, false);
  assert.ok(outside.spatialFlags.includes("location-outside-affected-extent"));
  const apart = build(drawn(1, { location: [alongPoint(A0, 0.5)[0], 35.01] }), [ev(1)]);
  assert.equal(apart.locationAttach.onSection, false);
  assert.equal(apart.locationAttach.withinAffectedExtent, null);
  assert.equal(apart.locationAttach.unknownReasons.withinAffectedExtent, "location-not-on-section");
  assert.ok(apart.spatialFlags.includes("location-not-on-section"));
  const near = build(drawn(1, { location: [alongPoint(A0, 0.5)[0], 35.0002] }), [ev(1)]);
  assert.equal(near.locationAttach.onSection, null, "1-50 m: near, not on the section");
  assert.equal(build(drawn(1, { location: alongPoint(A0, 0.4), locationBasis: "source" }), [ev(1)]).locationBasis, "source");
});

// --- external lines and trains ---
test("an existing line has no alignment: every spatial fact that needs one is null with the reason", () => {
  const site = build(drawn(1, { location: alongPoint(EXT_SECTION, 0.5) }), [ev(1, { trackSegmentId: trackId(G, EXT_SECTION) })]);
  assert.equal(site.railCapacitySectionId, EXT_SECTION.sectionId);
  assert.equal(site.alignment, null);
  assert.equal(site.locationAttach, null);
  assert.equal(site.alternativeAccessCandidates, null);
  assert.equal(site.affectedBlockIds, null);
  for (const f of ["alignment", "locationAttach", "alternativeAccessCandidates"]) assert.equal(site.unknownReasons[f], "external-alignment-not-in-source", f);
  assert.equal(site.affectedExtent.lengthMeters, null);
  assert.equal(site.affectedExtent.unknownReasons.lengthMeters, "external-alignment-not-in-source");
  assert.deepEqual(site.affectedExtent.startLocation, EXT_SECTION.startLocation, "station-level positions are known");
  assert.deepEqual(site.affectedStationIds, [EXT_SECTION.fromStationId, EXT_SECTION.toStationId].sort());
  assert.ok(site.spatialFlags.includes("external-alignment-unknown"));
  assert.equal(JSON.stringify(site).includes("Operator X"), false, "an operator tag is never copied");
});

test("an event on a train has no place on the map: the spatial facts are null, the train id is carried", () => {
  const site = build(drawn(1), [ev(1, { kind: "vehicle-failure", trackSegmentId: null, trainId: "train:7" })]);
  assert.equal(site.scope, "train");
  assert.equal(site.trainId, "train:7");
  assert.equal(site.trackSegmentId, null);
  for (const f of ["railCapacitySectionId", "alignment", "affectedExtent", "affectedSectionIds", "affectedBlockIds", "affectedSignalCandidateIds", "affectedJunctionResourceIds", "affectedStationIds", "affectedTerminalResourceIds", "alternativeAccessCandidates"]) {
    assert.equal(site[f], null, f);
    assert.equal(site.unknownReasons[f], "train-position-not-in-map", f);
  }
  assert.ok(site.spatialFlags.includes("train-position-not-in-map"));
  const located = build(drawn(1, { location: alongPoint(A0, 0.3) }), [ev(1, { kind: "vehicle-failure", trackSegmentId: null, trainId: "train:7" })]);
  assert.notEqual(located.location, null);
  assert.equal(located.locationAttach, null);
  assert.equal(located.unknownReasons.locationAttach, "train-position-not-in-map");
});

// --- the influence polygon ---
const POLYGON = [[139.0035, 34.999], [139.0075, 34.999], [139.0075, 35.001], [139.0035, 35.001]];

test("a drawn influence polygon is kept as a canonical ring; what it contains is measured, not assumed", () => {
  const site = build(drawn(1, { location: alongPoint(A0, 0.45), affectedPolygon: POLYGON }), [ev(1)]);
  assert.equal(site.affectedPolygon.length, 4);
  assert.deepEqual(site.affectedPolygon[0], [139.0035, 34.999], "the lowest vertex first");
  assert.deepEqual(site.polygonFacts.sectionIdsCrossed, [A0.sectionId]);
  assert.deepEqual(site.polygonFacts.junctionResourceIdsInside, [G.junctions.find((j) => j.key === "mid").junctionResourceId]);
  assert.deepEqual(site.polygonFacts.stationIdsInside, []);
  assert.equal(site.polygonFacts.coversLocation, true);
  assert.deepEqual([...site.polygonFacts.sectionIdsNotMeasured].sort(), G.sections.filter((s) => !s.alignment).map((s) => s.sectionId).sort(), "sections without alignment cannot be tested against a polygon");
  const wide = build(drawn(1, { affectedPolygon: [[138.99, 34.99], [139.05, 34.99], [139.05, 35.01], [138.99, 35.01]] }), [ev(1)]);
  assert.equal(wide.polygonFacts.sectionIdsCrossed.length, 4);
  assert.equal(wide.polygonFacts.coversLocation, null);
  assert.equal(wide.polygonFacts.unknownReasons.coversLocation, "location-not-stated");
  const elsewhere = build(drawn(1, { location: alongPoint(A0, 0.1), affectedPolygon: POLYGON }), [ev(1)]);
  assert.equal(elsewhere.polygonFacts.coversLocation, false);
  assert.ok(elsewhere.spatialFlags.includes("polygon-not-covering-location"));
});

test("no polygon is null; a degenerate or self-crossing one is dropped with a warning", () => {
  const none = build(drawn(1), [ev(1)]);
  assert.equal(none.affectedPolygon, null);
  assert.equal(none.polygonFacts, null);
  assert.equal(none.unknownReasons.affectedPolygon, "no-polygon-drawn");
  assert.equal(none.unknownReasons.polygonFacts, "no-polygon-drawn");
  assert.ok(none.spatialFlags.includes("polygon-not-drawn"));
  for (const bad of [[[139, 35], [139.001, 35.001]], [[139, 35], [139.002, 35.001], [139.002, 35], [139, 35.002]], [[139, 35], ["x", 1], [139.1, 35.1]]]) {
    const out = buildRailwayDisruptionSite(drawn(1, { affectedPolygon: bad }), { pack, events: [ev(1)], railGeometry: G, applications: [APP] });
    assert.equal(out.site.affectedPolygon, null);
    assert.equal(out.site.unknownReasons.affectedPolygon, "polygon-degenerate");
    assert.deepEqual(out.warnings.map((w) => w.code), ["polygon-degenerate"]);
  }
});

test("a design made on another revision of the geometry (or none recorded) is not measured: its facts are null, the drawing is kept", () => {
  const location = alongPoint(A0, 0.45);
  const stale = buildRailwayDisruptionSite(drawn(1, { location, affectedPolygon: POLYGON, designedRailGeometryRevision: "rail-geometry-revision:old" }), { pack, events: [ev(1)], railGeometry: G, applications: [APP] });
  assert.equal(stale.site.locationAttach, null);
  assert.equal(stale.site.polygonFacts, null);
  assert.equal(stale.site.unknownReasons.locationAttach, "design-revision-stale");
  assert.equal(stale.site.unknownReasons.polygonFacts, "design-revision-stale");
  assert.equal(stale.site.affectedPolygon.length, 4, "the player's polygon is still theirs");
  assert.deepEqual(stale.warnings.map((w) => w.code), ["revision-stale"]);
  assert.ok(stale.site.spatialFlags.includes("design-revision-stale"));
  assert.deepEqual(stale.site.affectedBlockIds, A0.blockIds, "what the event itself names is still read from the current geometry");
  const unrecorded = buildRailwayDisruptionSite({ eventId: "railway-disruption:1", location }, { pack, events: [ev(1)], railGeometry: G, applications: [APP] });
  assert.equal(unrecorded.site.unknownReasons.locationAttach, "design-revision-not-recorded");
  assert.deepEqual(unrecorded.warnings.map((w) => w.code), ["revision-not-recorded"]);
  const nothingDrawn = buildRailwayDisruptionSite({ eventId: "railway-disruption:1" }, { pack, events: [ev(1)], railGeometry: G, applications: [APP] });
  assert.deepEqual(nothingDrawn.warnings, [], "no drawing, no warning");
});

// --- effect, status, other ways in ---
test("the event's own effect and status are passed through; a speed limit and a closure stay different, nothing is derived", () => {
  const closed = build(drawn(1), [ev(1)]);
  const limited = build(drawn(1), [ev(1, { kind: "severe-weather", effect: { closed: false, speedLimitMps: 10 } })]);
  assert.deepEqual(closed.effect, { closed: true, speedLimitMps: 0 });
  assert.deepEqual(limited.effect, { closed: false, speedLimitMps: 10 });
  assert.equal(limited.kind, "severe-weather");
  for (const status of ["active", "responding", "resolved"]) assert.equal(build(drawn(1), [ev(1, { status })]).status, status);
  const noEffect = build(drawn(1), [ev(1, { effect: { closed: "yes" } })]);
  assert.equal(noEffect.effect, null);
  assert.equal(noEffect.unknownReasons.effect, "effect-not-stated");
  assert.equal(build(drawn(1), [ev(1, { effect: { closed: false, speedLimitMps: -2 } })]).effect, null);
  const odd = buildRailwayDisruptionSite(drawn(1), { pack, events: [ev(1, { status: "paused" })], railGeometry: G, applications: [APP] });
  assert.equal(odd.site.status, null);
  assert.equal(odd.site.unknownReasons.status, "status-not-recognized");
  assert.deepEqual(odd.warnings.map((w) => w.code), ["status-not-recognized"]);
});

test("other ways to reach the stretch: the end stations and the sections joined there, measured from the location when it is known", () => {
  const withLocation = build(drawn(1, { location: alongPoint(A0, 0.25) }), [ev(1)]);
  const stations = withLocation.alternativeAccessCandidates.filter((c) => c.kind === "station");
  assert.deepEqual(stations.map((c) => c.refId).sort(), [A0.fromStationId, A0.toStationId].sort());
  const start = stations.find((c) => c.relation === "section-start");
  const end = stations.find((c) => c.relation === "section-end");
  assert.ok(Math.abs(start.distanceMeters - 0.25 * A0.lengthMeters) < 2);
  assert.ok(Math.abs(end.distanceMeters - 0.75 * A0.lengthMeters) < 2);
  const joined = withLocation.alternativeAccessCandidates.filter((c) => c.kind === "joined-section");
  assert.deepEqual(joined.map((c) => [c.refId, c.relation]), [[A1.sectionId, "joined-at-end"]]);
  assert.equal(withLocation.alternativeAccessCandidates.length, 3);
  const ids = withLocation.alternativeAccessCandidates.map((c) => c.candidateId);
  assert.deepEqual(ids, [...ids].sort());
  const first = withLocation.alternativeAccessCandidates[0];
  assert.equal(first.candidateId, stableId("railway-disruption-access", withLocation.disruptionSiteId, first.kind, first.refId, first.relation));
  const unknown = build(drawn(1), [ev(1)]);
  for (const c of unknown.alternativeAccessCandidates) { assert.equal(c.distanceMeters, null); assert.equal(c.unknownReasons.distanceMeters, "location-not-stated"); }
  assert.equal(unknown.alternativeAccessCandidates.length, 3, "who is reachable does not depend on where the event is");
});

// --- the module is spatial only ---
test("no management, engine-state or train import; no cost, probability, drivability, recovery-time or delay field in the output", () => {
  for (const file of ["railway-disruption-site", "railway-disruption-site-editor", "railway-disruption-site-view"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|scenario-runtime|trains|state)\.mjs/.test(text), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
  const rich = build(drawn(1, { location: alongPoint(A0, 0.45), affectedPolygon: POLYGON }), [ev(1, { blockId: blocksOf(G, A0)[1].blockId })]);
  assert.deepEqual(fieldNames(rich).filter((k) => FORBIDDEN.test(k)), []);
  const view = buildRailwayDisruptionView({ exportData: { sites: [rich], inactive: [], warnings: [] } });
  assert.deepEqual(fieldNames(view).filter((k) => FORBIDDEN.test(k)), []);
});

test("unknown[] and unknownReasons are 1:1 everywhere, and every unknown value is null", () => {
  const events = [ev(1), ev(2, { blockId: blocksOf(G, A0)[1].blockId }), ev(3, { trackSegmentId: trackId(G, EXT_SECTION) }), ev(4, { kind: "vehicle-failure", trackSegmentId: null, trainId: "train:7" }), ev(5, { trackSegmentId: "track-segment:unlinked" })];
  for (const [i, extra] of [[1, { location: alongPoint(A0, 0.4), affectedPolygon: POLYGON }], [2, {}], [3, { location: alongPoint(EXT_SECTION, 0.5) }], [4, {}], [5, {}]]) {
    const site = build(drawn(i, extra), events);
    assertUnknownContract(site, `site ${i}`);
    assert.deepEqual([...site.unknown], Object.keys(site.unknownReasons).sort());
  }
  const bare = build(drawn(1), [ev(1, { trackSegmentId: trackId(BARE, sectionOf(BARE, A, 0)) })], { railGeometry: BARE, applications: [applicationOf(BARE)] });
  assertUnknownContract(bare, "bare");
});

test("the inputs are never mutated (frozen event, geometry, application and drawn site)", () => {
  const d = deepFreeze(drawn(1, { location: alongPoint(A0, 0.4), affectedPolygon: POLYGON }));
  const events = deepFreeze([ev(1, { blockId: blocksOf(G, A0)[1].blockId })]);
  const geometry = deepFreeze(structuredClone(G));
  const apps = deepFreeze([structuredClone(APP)]);
  const frozenPack = deepFreeze(structuredClone(pack));
  const before = JSON.stringify([d, events, geometry, apps, frozenPack]);
  const out = buildRailwayDisruptionSite(d, { pack: frozenPack, events, railGeometry: geometry, applications: apps });
  assert.ok(out.site);
  assert.equal(JSON.stringify([d, events, geometry, apps, frozenPack]), before);
  const exp = buildRailwayDisruptionSiteExport({ pack: frozenPack, events, railGeometries: [geometry], applications: apps, sites: [d] });
  assert.equal(exp.sites.length, 1);
  const view = buildRailwayDisruptionView({ exportData: deepFreeze(exp) });
  assert.equal(view.sites.length, 1);
});

test("a map site does not touch cash, construction or train state: a stand-in engine state is unchanged after building, editing and viewing", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], constructionProjects: [{ id: "p" }], trains: [{ id: "train:7", lineId: "line:1" }], trackSegments: [{ id: "track-segment:1" }], railwayDisruptions: { events: [ev(1)], nextSequence: 2 } });
  const before = JSON.stringify(state);
  const doc = newRailwayDisruptionDoc("t", "1");
  addSite(doc, "railway-disruption:1", { railGeometry: G });
  setLocation(doc, "railway-disruption:1", alongPoint(A0, 0.4), { railGeometry: G, sectionId: A0.sectionId });
  const exp = buildRailwayDisruptionSiteExport({ pack, events: state.railwayDisruptions.events, railGeometries: [G], applications: [APP], sites: doc.sites });
  buildRailwayDisruptionView({ exportData: exp });
  assert.equal(JSON.stringify(state), before);
});

// --- export ---
test("the export builds the active sites, keeps a switched-off site's id, and names the geometry through the line's application", () => {
  const events = [ev(1), ev(2, { trackSegmentId: trackId(G, A1) })];
  const exp = buildRailwayDisruptionSiteExport({ pack, events, railGeometries: [G, BARE], applications: [APP], sites: [drawn(1), drawn(2, { active: false }), drawn(1), { eventId: "railway-disruption:9" }, drawn(1, { railGeometryId: "rail-geometry:nope" })] });
  assert.equal(exp.schema, RAILWAY_DISRUPTION_SITE_EXPORT_SCHEMA);
  assert.deepEqual(exp.sites.map((s) => s.eventId), ["railway-disruption:1"]);
  assert.deepEqual(exp.inactive, [{ eventId: "railway-disruption:2", disruptionSiteId: disruptionSiteIdOf("t", "railway-disruption:2") }]);
  assert.deepEqual(exp.warnings.map((w) => w.code), ["duplicate-railway-disruption-site", "railway-disruption-site-rejected", "railway-disruption-site-rejected"]);
  assert.equal(exp.warnings[1].reasons[0].code, "event-missing", "an event the engine does not have is rejected by id");
  assert.equal(exp.warnings[2].reasons[0].code, "rail-geometry-missing");
  assert.equal(exp.sites[0].railGeometryId, G.railGeometryId);
  const two = buildRailwayDisruptionSiteExport({ pack, events, railGeometries: [G, BARE], applications: [], sites: [drawn(1)] });
  assert.equal(two.sites.length, 0, "two geometries and nothing that names one: not guessed");
  assert.equal(buildRailwayDisruptionSiteExport({ pack, events, railGeometries: [G], applications: [], sites: [drawn(1)] }).sites.length, 1, "the only geometry is used");
});

test("snapToSection is a pure helper over the section's alignment", () => {
  const off = [alongPoint(A0, 0.5)[0], 35.0003];
  const snapped = snapToSection(G, A0.sectionId, off);
  assert.equal(snapped.location[1], 35);
  assert.ok(snapped.distanceMeters > 30 && snapped.distanceMeters < 36);
  assert.equal(snapToSection(G, A0.sectionId, [alongPoint(A0, 0.5)[0], 35.01]), null, "farther than 50 m");
  assert.equal(snapToSection(G, EXT_SECTION.sectionId, alongPoint(EXT_SECTION, 0.5)), null, "no alignment, nothing to snap to");
  assert.equal(snapToSection(G, "rail-section:nope", off), null);
});

// --- editor ---
test("editor: a site keeps its event's id through every edit; location, polygon and section link are the player's statements", () => {
  const doc = newRailwayDisruptionDoc("t", "1");
  const site = addSite(doc, "railway-disruption:1", { railGeometry: G });
  assert.deepEqual([site.active, site.railGeometryId, site.designedRailGeometryRevision], [true, G.railGeometryId, G.railGeometryRevision]);
  assert.equal(addSite(doc, "railway-disruption:1", { railGeometry: G }), site, "an event has one site");
  assert.throws(() => addSite(doc, "", { railGeometry: G }), /needs an event id/);
  const built = () => buildRailwayDisruptionSite(toDrawnSite(site), { pack, events: [ev(1)], railGeometry: G, applications: [APP] }).site;
  const id = built().disruptionSiteId;
  assert.equal(id, disruptionSiteIdOf("t", "railway-disruption:1"));
  assert.equal(built().location, null);
  setLocation(doc, "railway-disruption:1", [alongPoint(A0, 0.4)[0], 35.0002], { railGeometry: G, sectionId: A0.sectionId });
  assert.equal(site.location[1], 35, "snapped onto the section's alignment");
  assert.equal(built().locationAttach.onSection, true);
  setLocation(doc, "railway-disruption:1", alongPoint(A0, 0.6), { basis: "source" });
  assert.equal(site.locationBasis, "source");
  setAffectedPolygon(doc, "railway-disruption:1", POLYGON);
  assert.equal(built().affectedPolygon.length, 4);
  setSectionLink(doc, "railway-disruption:1", A0.sectionId);
  assert.equal(site.railCapacitySectionId, A0.sectionId);
  setSectionLink(doc, "railway-disruption:1", null);
  clearAffectedPolygon(doc, "railway-disruption:1");
  clearLocation(doc, "railway-disruption:1");
  assert.deepEqual([site.location, site.locationBasis, site.affectedPolygon], [null, null, null]);
  assert.equal(built().disruptionSiteId, id);
  assert.throws(() => setLocation(doc, "railway-disruption:9", [0, 0]), /Unknown disruption site/);
});

test("editor: a site is switched off and back on, never deleted; it keeps its id, location and polygon", () => {
  const doc = newRailwayDisruptionDoc("t", "1");
  const site = addSite(doc, "railway-disruption:1", { railGeometry: G });
  setLocation(doc, "railway-disruption:1", alongPoint(A0, 0.4));
  setAffectedPolygon(doc, "railway-disruption:1", POLYGON);
  const saved = structuredClone(site);
  deactivateSite(doc, "railway-disruption:1");
  assert.equal(site.active, false);
  assert.equal(doc.sites.length, 1, "still in the document");
  assert.deepEqual(activeSites(doc), []);
  const exp = buildRailwayDisruptionSiteExport({ pack, events: [ev(1)], railGeometries: [G], applications: [APP], sites: doc.sites });
  assert.deepEqual([exp.sites.length, exp.inactive.map((i) => i.eventId)], [0, ["railway-disruption:1"]]);
  restoreSite(doc, "railway-disruption:1");
  assert.deepEqual(site, saved, "restored exactly as it was");
  assert.equal(activeSites(doc).length, 1);
  assert.equal(Object.keys(editorModule).some((k) => /^(remove|delete)/i.test(k)), false, "the editor offers no way to delete a site");
});

test("editor: a geometry that changed leaves the site stale until the player re-confirms it", () => {
  const doc = newRailwayDisruptionDoc("t", "1");
  const site = addSite(doc, "railway-disruption:1", { railGeometry: G });
  setLocation(doc, "railway-disruption:1", alongPoint(A0, 0.4));
  const changed = { ...G, railGeometryRevision: "rail-geometry-revision:changed" };
  const built = (g) => buildRailwayDisruptionSite(toDrawnSite(site), { pack, events: [ev(1)], railGeometry: g, applications: [applicationOf(g)] });
  assert.equal(built(G).site.locationAttach.onSection, true);
  assert.equal(built(changed).site.unknownReasons.locationAttach, "design-revision-stale");
  setLocation(doc, "railway-disruption:1", alongPoint(A0, 0.5), { railGeometry: changed, sectionId: A0.sectionId });
  assert.equal(built(changed).site.unknownReasons.locationAttach, "design-revision-stale", "editing does not confirm the design");
  rebindRailGeometry(doc, "railway-disruption:1", changed);
  assert.equal(built(changed).site.locationAttach.onSection, true);
});

test("saving and restoring keeps every site and id; another pack's save is refused", () => {
  const doc = newRailwayDisruptionDoc("t", "1");
  addSite(doc, "railway-disruption:1", { railGeometry: G });
  setLocation(doc, "railway-disruption:1", alongPoint(A0, 0.4));
  addSite(doc, "railway-disruption:2", { railGeometry: G });
  deactivateSite(doc, "railway-disruption:2");
  const text = serializeRailwayDisruptionDoc(doc);
  const restored = restoreRailwayDisruptionDoc(text, pack);
  assert.deepEqual(restored.warnings, []);
  assert.equal(serializeRailwayDisruptionDoc(restored.doc), text);
  const run = (d) => JSON.stringify(buildRailwayDisruptionSiteExport({ pack, events: [ev(1), ev(2)], railGeometries: [G], applications: [APP], sites: d.sites }));
  assert.equal(run(restored.doc), run(doc), "the same ids and facts after a reload");
  const refused = restoreRailwayDisruptionDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(refused.warnings, [{ code: "railway-disruption-doc-other-pack", savedPackId: "t" }]);
  assert.equal(refused.doc.sites.length, 0);
  assert.equal(refused.doc.packId, "other");
  assert.equal(restoreRailwayDisruptionDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreRailwayDisruptionDoc("{nope", pack).warnings[0].code, "railway-disruption-doc-unreadable");
  assert.equal(restoreRailwayDisruptionDoc(JSON.stringify({ version: 9, sites: [] }), pack).warnings[0].code, "railway-disruption-doc-version");
  assert.deepEqual(restoreRailwayDisruptionDoc(null, pack).doc.sites, []);
});

// --- view ---
function fakeCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : (...args) => { calls.push([name, ...args]); }),
    set: (target, name, value) => { target[name] = value; calls.push(["set", name, value]); return true; },
  });
  return { ctx, calls };
}
function fakeDom() {
  const make = () => ({ className: "", textContent: "", hidden: false, children: [], ownerDocument: null, append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; } });
  const doc = { createElement: () => { const e = make(); e.ownerDocument = doc; return e; } };
  const rootEl = make();
  rootEl.ownerDocument = doc;
  return rootEl;
}
const textsOf = (node) => [node.textContent, ...node.children.flatMap(textsOf)].filter(Boolean);
const screen = ([lon, lat]) => [(lon - 139) * 20000, (35.01 - lat) * 20000];
const exportOf = (...sites) => ({ sites, inactive: [], warnings: [] });
const BANNED_TEXT = /원|비용|공기|승인|확률|가능|불가|복구|지연/;

test("view: a closure and a speed limit look different, and active, responding and resolved look different", () => {
  assert.notEqual(EFFECT_STYLES.closed.color, EFFECT_STYLES["speed-limit"].color);
  assert.notEqual(EFFECT_STYLES.closed.glyph, EFFECT_STYLES["speed-limit"].glyph);
  assert.ok(EFFECT_STYLES["speed-limit"].dash.length > 0 && EFFECT_STYLES.closed.dash.length === 0);
  assert.equal(new Set(Object.values(STATUS_STYLES).map((s) => s.label)).size, 4);
  assert.ok(STATUS_STYLES.resolved.alpha < STATUS_STYLES.active.alpha && STATUS_STYLES.responding.outline === true);
  const sites = [build(drawn(1), [ev(1)]), build(drawn(2), [ev(2, { kind: "severe-weather", effect: { closed: false, speedLimitMps: 10 }, status: "responding" })]), build(drawn(3), [ev(3, { status: "resolved" })])];
  const model = buildRailwayDisruptionView({ exportData: exportOf(...sites), selectedId: sites[1].disruptionSiteId });
  assert.equal(model.schema, "transitline.railway-disruption-site-map-view/1");
  assert.deepEqual(model.sites.map((s) => s.effectStyle.key), ["closed", "speed-limit", "closed"]);
  assert.deepEqual(model.sites.map((s) => s.statusStyle.key), ["active", "responding", "resolved"]);
  assert.equal(model.sites[1].effectText, "속도 제한 36 km/h");
  assert.equal(model.sites[0].effectText, "폐쇄");
  assert.deepEqual(model.sites.map((s) => s.selected), [false, true, false]);
  assert.equal(buildRailwayDisruptionView({ exportData: exportOf(build(drawn(1), [ev(1, { effect: { closed: "?" } })])) }).sites[0].effectStyle.key, "unknown-effect");
});

test("view: an event without a location is labelled 'unknown location — whole stretch', never drawn as a marker in the middle", () => {
  const whole = build(drawn(1), [ev(1)]);
  const block = build(drawn(2), [ev(2, { blockId: blocksOf(G, A0)[1].blockId })]);
  const train = build(drawn(3), [ev(3, { kind: "vehicle-failure", trackSegmentId: null, trainId: "train:7" })]);
  const external = build(drawn(4), [ev(4, { trackSegmentId: trackId(G, EXT_SECTION) })]);
  const model = buildRailwayDisruptionView({ exportData: exportOf(whole, block, train, external) });
  assert.deepEqual(model.sites.map((s) => s.locationText), ["위치 미상—구간 전체", "위치 미상—해당 폐색", "위치 미상—열차", "위치 미상—구간 전체"]);
  const { ctx, calls } = fakeCtx();
  drawRailwayDisruptionOverlay(ctx, { ...model, sites: [model.sites[0]] }, screen);
  assert.equal(calls.some((c) => c[0] === "arc"), false, "no marker is placed anywhere: the stretch itself is highlighted");
  const texts = calls.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => String(c[1]));
  assert.ok(texts.some((t) => t.includes("위치 미상—구간 전체")));
  assert.ok(calls.some((c) => c[0] === "stroke") && calls.some((c) => c[0] === "lineTo"), "the whole affected alignment is drawn");
  const ext = fakeCtx();
  drawRailwayDisruptionOverlay(ext.ctx, { ...model, sites: [model.sites[3]] }, screen);
  assert.ok(ext.calls.filter((c) => c[0] === "fillText").some((c) => String(c[1]).includes("선형 자료 없음")));
  assert.equal(ext.calls.some((c) => c[0] === "lineTo"), false, "no alignment, no line");
});

test("view: a located event gets a marker; a resolved one is faded with a check; a responding one is outlined", () => {
  const located = build(drawn(1, { location: alongPoint(A0, 0.4), affectedPolygon: POLYGON }), [ev(1)]);
  const resolved = build(drawn(2, { location: alongPoint(A0, 0.4) }), [ev(2, { status: "resolved" })]);
  const responding = build(drawn(3), [ev(3, { status: "responding" })]);
  const active = build(drawn(4), [ev(4)]);
  const model = buildRailwayDisruptionView({ exportData: exportOf(located, resolved, responding, active) });
  const run = (site) => { const c = fakeCtx(); drawRailwayDisruptionOverlay(c.ctx, { ...model, sites: [site] }, screen); return c.calls; };
  const a = run(model.sites[0]);
  assert.ok(a.some((c) => c[0] === "arc"), "a marker at the stated location");
  assert.ok(a.filter((c) => c[0] === "fillText").some((c) => c[1] === "✕"), "the closure glyph");
  const b = run(model.sites[1]);
  assert.ok(b.filter((c) => c[0] === "fillText").some((c) => c[1] === "✓"), "resolved: a check, not the closure glyph");
  assert.ok(b.some((c) => c[0] === "set" && c[1] === "globalAlpha" && c[2] < 1), "resolved is faded");
  const strokes = (calls) => calls.filter((c) => c[0] === "stroke").length;
  assert.equal(strokes(run(model.sites[2])), strokes(run(model.sites[3])) + 1, "responding draws one extra outline stroke");
  const texts = a.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => String(c[1])).join("|");
  assert.equal(BANNED_TEXT.test(texts), false);
});

test("view: the panel and legend use textContent only and never show cost, probability, drivability or recovery", () => {
  const sites = [build(drawn(1, { location: alongPoint(A0, 0.4) }), [ev(1)]), build(drawn(2), [ev(2, { kind: "<img src=x onerror=alert(1)>", status: "resolved" })])];
  const model = buildRailwayDisruptionView({ exportData: { sites, inactive: [], warnings: [{ code: "railway-disruption-site-rejected" }] } });
  const panel = fakeDom();
  renderRailwayDisruptionPanel(panel, model);
  const all = textsOf(panel);
  assert.ok(all.some((t) => t.includes("<img src=x onerror=alert(1)>")), "an engine-supplied string is shown as text");
  assert.ok(all.some((t) => t.startsWith("운행 장애 2건")));
  assert.ok(all.some((t) => t.includes("위치 미상—구간 전체")));
  assert.ok(all.some((t) => t.includes("영향 구간 1")));
  assert.ok(all.some((t) => t.includes("railway-disruption-site-rejected")));
  assert.equal(all.some((t) => BANNED_TEXT.test(t)), false);
  const empty = fakeDom();
  renderRailwayDisruptionPanel(empty, buildRailwayDisruptionView({ exportData: exportOf() }));
  assert.equal(empty.hidden, true);
  const legend = fakeDom();
  renderRailwayDisruptionLegend(legend);
  const legendText = textsOf(legend);
  assert.ok(legendText.length >= 8);
  assert.equal(legendText.some((t) => BANNED_TEXT.test(t)), false);
});

// --- shipped examples: regenerated by the script, and checked against the contract ---
const examplePacks = ["tokyo", "example-radial", "example-corridor"];
const exampleDir = (id) => path.join(root, "packs", id, "railway-disruption-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".disruption-site.json")).sort().map((f) => ({ file: f, site: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("every shipped example satisfies the contract: it links to a real rail capacity example of its pack and is labelled synthetic", () => {
  for (const id of examplePacks) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 3, id);
    for (const { file, site } of examples) {
      const { source, ...body } = site;
      assert.equal(body.schema, RAILWAY_DISRUPTION_SITE_SCHEMA, `${id}/${file}`);
      assert.equal(body.sourcePackId, id);
      assert.equal(source.generatedBy, "scripts/build-railway-disruption-site-examples.mjs");
      assert.equal(source.synthetic, true);
      assert.deepEqual(fieldNames(body).filter((k) => FORBIDDEN.test(k)), [], file);
      assertUnknownContract(body, `${id}/${file}`);
      const geometry = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "rail-capacity-examples", `${source.railCapacityExample}.rail-capacity.json`), "utf8"));
      assert.equal(body.railGeometryId, geometry.railGeometryId, file);
      assert.equal(body.railGeometryRevision, geometry.railGeometryRevision, file);
      if (body.railCapacitySectionId) assert.ok(geometry.sections.some((s) => s.sectionId === body.railCapacitySectionId), `${file}: section`);
      if (body.blockId) assert.ok(geometry.blocks.some((b) => b.blockId === body.blockId && b.sectionId === body.railCapacitySectionId), `${file}: block`);
      assert.equal(body.disruptionSiteId, disruptionSiteIdOf(id, body.eventId), file);
    }
  }
});

test("the example set covers every required case", () => {
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.site));
  const cases = new Set(all.flatMap((s) => s.source.case));
  for (const c of ["signal-failure", "track-obstruction", "severe-weather", "speed-limit", "construction-incident", "single-block", "whole-section", "location-unknown", "external-alignment-unknown", "resolved", "no-block-data", "train-scope"]) assert.ok(cases.has(c), c);
  const caseOf = (c) => all.filter((s) => s.source.case.includes(c));
  assert.ok(caseOf("single-block").every((s) => s.scope === "block" && s.affectedBlockIds.length === 1));
  assert.ok(caseOf("whole-section").every((s) => s.scope === "section" && s.blockId === null));
  assert.ok(caseOf("speed-limit").every((s) => s.effect.closed === false && s.effect.speedLimitMps > 0));
  assert.ok(caseOf("resolved").every((s) => s.status === "resolved"));
  assert.ok(caseOf("location-unknown").every((s) => s.location === null && s.unknownReasons.location === "location-not-stated"));
  assert.ok(caseOf("external-alignment-unknown").every((s) => s.alignment === null && s.unknownReasons.alignment === "external-alignment-not-in-source"));
  assert.ok(caseOf("no-block-data").every((s) => s.affectedBlockIds === null));
  assert.ok(all.some((s) => s.status === "responding"), "a site being responded to");
  assert.ok(all.some((s) => s.affectedPolygon !== null && s.polygonFacts !== null), "a drawn influence polygon");
  assert.ok(all.some((s) => s.affectedJunctionResourceIds?.length > 0), "a junction affected");
  assert.ok(all.some((s) => s.affectedTerminalResourceIds?.length > 0), "a terminal approach affected");
});

test("re-running the generator rewrites every example to the same canonical content", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "disruption-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-railway-disruption-site-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const canonical = (text) => text.replaceAll("\r\n", "\n");
  for (const id of examplePacks) {
    const files = fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".disruption-site.json")).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), files, id);
    for (const f of files) assert.equal(canonical(fs.readFileSync(path.join(out, id, f), "utf8")), canonical(fs.readFileSync(path.join(exampleDir(id), f), "utf8")), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
