// Dev-time generator for the railway disruption site examples in packs/<id>/railway-disruption-examples/.
//   node scripts/build-railway-disruption-site-examples.mjs [packId] [--out <dir>]   (npm run railway-disruption-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check regeneration).
//
// Each example places a disruption event on a rail capacity geometry example of the same pack
// (packs/<id>/rail-capacity-examples/). The events are SYNTHETIC: written by hand here in the shape of the engine's
// transitline.railway-disruption/1, not produced by it, and so is the application that links an operational track
// segment to a map section. Every example file says so in `source`. Nothing here reads a clock or a random number.
import fs from "node:fs";
import path from "node:path";
import { buildRailwayDisruptionSite, RAILWAY_DISRUPTION_EVENT_SCHEMA } from "../engine/src/map/railway-disruption-site.mjs";
import { round6 } from "../engine/src/map/ids.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";

const GENERATED_BY = "scripts/build-railway-disruption-site-examples.mjs";
const NOTE = "Synthetic event and application written by hand for this example in the shape of transitline.railway-disruption/1 and transitline.rail-capacity-application/1. They were not produced by the running engine; the geometry is a real rail capacity example of this pack.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && i !== outFlag + 1);

const loadGeometry = (pack, name) => { const { source: _drop, ...geometry } = readJson(`${pack.dir}/rail-capacity-examples/${name}.rail-capacity.json`); return geometry; };

// the point `fraction` of the way along a section's alignment (planar, around its own latitude)
function pointOn(section, fraction) {
  const poly = section.alignment;
  const kx = Math.cos((poly[0][1] * Math.PI) / 180);
  const seg = poly.slice(1).map((p, i) => Math.hypot((p[0] - poly[i][0]) * kx, p[1] - poly[i][1]));
  let rest = seg.reduce((s, v) => s + v, 0) * fraction;
  for (let i = 0; i < seg.length; i++) {
    if (rest <= seg[i] || i === seg.length - 1) { const t = seg[i] === 0 ? 0 : Math.min(1, rest / seg[i]); return [round6(poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t), round6(poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t)]; }
    rest -= seg[i];
  }
  return poly.at(-1);
}
const boxAround = ([lon, lat], dLon, dLat) => [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat]];
const withBlocks = (g) => g.sections.find((s) => s.blockIds && s.blockIds.length > 1);
const withJunction = (g) => g.sections.find((s) => s.junctionResourceIds?.length);
const planSection = (g, i = 0) => g.sections.filter((s) => s.sourceKind === "plan")[i];
const blocksOf = (g, section) => g.blocks.filter((b) => b.sectionId === section.sectionId).sort((a, b) => a.startAlongMeters - b.startAlongMeters);

const EFFECTS = { closed: { closed: true, speedLimitMps: 0 }, limited: { closed: false, speedLimitMps: 10 } };
// the operational track segment ids are the example's own: one per section, in section id order
const trackIdOf = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g) => ({
  schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision,
  sections: g.sections.map((s) => ({ trackSegmentId: trackIdOf(g, s), railCapacitySectionId: s.sectionId })),
});
const event = (n, kind, status, effect, target) => ({
  schema: RAILWAY_DISRUPTION_EVENT_SCHEMA, contractVersion: 1, id: `railway-disruption:${n}`, kind, status, lineId: "line:1",
  trackSegmentId: target.trackSegmentId ?? null, blockId: target.blockId ?? null, trainId: target.trainId ?? null,
  startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: status === "resolved" ? 645 : null, resolutionReason: status === "resolved" ? "natural-recovery" : null,
  severity: effect.closed ? "major" : "minor", effect, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "example-fixture",
});
const inBlock = (s, b) => pointOn(s, (b.startAlongMeters + b.endAlongMeters) / 2 / s.lengthMeters);

// each example: { file, case[], geometry (rail capacity example name), make: (g) => { event, drawn } }
const EXAMPLES = {
  "example-radial": [
    { file: "01-signal-failure-whole-section", case: ["signal-failure", "whole-section"], geometry: "03-multiple-blocks-in-one-section",
      make: (g) => { const s = withBlocks(g); return { event: event(1, "signal-failure", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:1", location: pointOn(s, 0.4), locationBasis: "player" } }; } },
    { file: "02-obstruction-in-one-block", case: ["track-obstruction", "single-block"], geometry: "03-multiple-blocks-in-one-section",
      make: (g) => {
        const s = withBlocks(g);
        const b = blocksOf(g, s)[1];
        const location = inBlock(s, b);
        return { event: event(2, "track-obstruction", "responding", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s), blockId: b.blockId }), drawn: { eventId: "railway-disruption:2", location, locationBasis: "player", affectedPolygon: boxAround(location, 0.0014, 0.0008) } };
      } },
    { file: "03-weather-speed-limit-over-a-turnout", case: ["severe-weather", "speed-limit"], geometry: "04-shared-turnout",
      make: (g) => { const s = withJunction(g); return { event: event(3, "severe-weather", "active", EFFECTS.limited, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:3", affectedPolygon: boxAround(pointOn(s, 1), 0.006, 0.004) } }; } },
    { file: "04-construction-incident-at-a-crossing", case: ["construction-incident", "whole-section"], geometry: "05-flat-crossing",
      make: (g) => { const s = withJunction(g); return { event: event(4, "construction-incident", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:4", location: pointOn(s, 0.9), locationBasis: "player", affectedPolygon: boxAround(pointOn(s, 1), 0.004, 0.003) } }; } },
    { file: "05-location-unknown", case: ["location-unknown", "whole-section", "no-block-data"], geometry: "06-no-signal-or-block-data",
      make: (g) => ({ event: event(5, "signal-failure", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, planSection(g, 1)) }), drawn: { eventId: "railway-disruption:5" } }) },
    { file: "06-resolved-obstruction", case: ["track-obstruction", "resolved", "single-block"], geometry: "03-multiple-blocks-in-one-section",
      make: (g) => {
        const s = withBlocks(g);
        const b = blocksOf(g, s)[0];
        return { event: event(6, "track-obstruction", "resolved", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s), blockId: b.blockId }), drawn: { eventId: "railway-disruption:6", location: inBlock(s, b), locationBasis: "player" } };
      } },
  ],
  "example-corridor": [
    { file: "01-obstruction-on-a-terminal-approach", case: ["track-obstruction", "whole-section", "terminal-approach"], geometry: "01-terminal-two-platforms-with-turnback",
      make: (g) => { const s = withJunction(g); return { event: event(1, "track-obstruction", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:1", location: pointOn(s, 0.97), locationBasis: "player" } }; } },
    { file: "02-signal-failure-in-one-block", case: ["signal-failure", "single-block"], geometry: "03-single-track-with-blocks",
      make: (g) => {
        const s = withBlocks(g);
        const b = blocksOf(g, s)[1];
        return { event: event(2, "signal-failure", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s), blockId: b.blockId }), drawn: { eventId: "railway-disruption:2", location: inBlock(s, b), locationBasis: "player" } };
      } },
    { file: "03-construction-incident-without-block-data", case: ["construction-incident", "whole-section", "no-block-data"], geometry: "02-bare-sections",
      make: (g) => { const s = planSection(g, 1); return { event: event(3, "construction-incident", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:3", location: pointOn(s, 0.5), locationBasis: "player" } }; } },
  ],
  tokyo: [
    { file: "01-signal-failure-on-an-existing-line", case: ["signal-failure", "external-alignment-unknown"], geometry: "01-existing-line-through-route",
      make: (g) => { const s = g.sections.find((x) => x.sourceKind === "external"); return { event: event(1, "signal-failure", "active", EFFECTS.closed, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:1" } }; } },
    { file: "02-weather-speed-limit-on-a-plan-section", case: ["severe-weather", "speed-limit"], geometry: "02-station-variants-blocks",
      make: (g) => { const s = withBlocks(g) ?? planSection(g, 2); return { event: event(2, "severe-weather", "active", EFFECTS.limited, { trackSegmentId: trackIdOf(g, s) }), drawn: { eventId: "railway-disruption:2", affectedPolygon: boxAround(pointOn(s, 0.5), 0.02, 0.012) } }; } },
    { file: "03-vehicle-failure-train-position-unknown", case: ["vehicle-failure", "train-scope", "location-unknown"], geometry: "03-bay-spine-single",
      make: () => ({ event: event(3, "vehicle-failure", "active", EFFECTS.closed, { trainId: "train:7" }), drawn: { eventId: "railway-disruption:3" } }) },
  ],
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "railway-disruption-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id]) {
    const geometry = loadGeometry(pack, ex.geometry);
    const { event: ev, drawn: base } = ex.make(geometry);
    const drawn = { ...base, designedRailGeometryRevision: geometry.railGeometryRevision };
    const application = applicationOf(geometry);
    const out = buildRailwayDisruptionSite(drawn, { pack: { manifest: pack.manifest }, events: [ev], railGeometry: geometry, applications: [application] });
    if (!out.site) throw new Error(`${id}/${ex.file} was rejected: ${JSON.stringify(out.warnings)}`);
    const body = { ...out.site, source: { case: ex.case, synthetic: true, note: NOTE, railCapacityExample: ex.geometry, input: { event: ev, application, drawn }, generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.disruption-site.json`), `${JSON.stringify(body, null, 2)}\n`);
    const s = out.site;
    console.log(`[${id}] ${ex.file}: kind=${s.kind} status=${s.status} scope=${s.scope} effect=${s.effect?.closed ? "closed" : `limit:${s.effect?.speedLimitMps}`} location=${s.location ? "stated" : "unknown"} sections=${s.affectedSectionIds?.length ?? null} blocks=${s.affectedBlockIds?.length ?? null} signals=${s.affectedSignalCandidateIds?.length ?? null} junctions=${s.affectedJunctionResourceIds?.length ?? null} stations=${s.affectedStationIds?.length ?? null} access=${s.alternativeAccessCandidates?.length ?? null} flags=[${s.spatialFlags}] unknown=${s.unknown.length} warn=${out.warnings.map((w) => w.code)}`);
  }
}
