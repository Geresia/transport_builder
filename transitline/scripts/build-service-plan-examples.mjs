// Dev-time generator for the service plan examples in packs/<id>/service-plan-examples/.
//   node scripts/build-service-plan-examples.mjs [packId] [--out <dir>]   (npm run service-plan-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// Each example is a service plan the player wrote with the editor (engine/src/map/service-plan-editor.mjs), saved and
// restored, over a rail capacity geometry built from real plan examples of the same pack (packs/<id>/plan-examples/).
// The track facts (track count, block boundaries, terminals) and the operational line application are SYNTHETIC: written
// by hand here, not produced by the running engine, and every example file says so in `source`. The headways, trainsets
// and cars are what a player might ask for; nothing here says they could be run. No clock or RNG is involved.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildRailGeometry, planRevisionOf } from "../engine/src/map/rail-capacity-geometry.mjs";
import { buildServicePlan } from "../engine/src/map/service-plan-geometry.mjs";
import {
  addAssumption, addBand, addBothDirections, addDirection, addPlan, addTurnback, deactivatePlan, drawnPlansOf, newServicePlanDoc, restoreServicePlanDoc, serializeServicePlanDoc, setRoute, setVehicleIntent,
} from "../engine/src/map/service-plan-editor.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";

const GENERATED_BY = "scripts/build-service-plan-examples.mjs";
const NOTE = "Synthetic: the service plan is what a player might write with the editor, the track facts (track count, block boundaries, terminals) and the operational line application are written by hand for this example in the shape of transitline.rail-capacity-geometry/1 and transitline.rail-capacity-application/1. The plans are real plan examples of this pack. A requested headway, trainset count or car count says what the player asked for, not that it can be run.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && !(outFlag >= 0 && i === outFlag + 1));

const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const recorded = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const player = (plan, i, fact) => ({ ref: ref(plan, i), basis: "player", ...fact });
const boundary = (key, plan, i, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: plan.segments[i].from, alongMeters, basis: "player" });
const sec = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const first = (plan) => plan.segments[0].from;
const last = (plan) => plan.segments.at(-1).to;
const shift = ([x, y], dx, dy) => [Math.round((x + dx) * 1e6) / 1e6, Math.round((y + dy) * 1e6) / 1e6];
const terminalId = (g, key) => g.terminals.find((t) => t.key === key).terminalResourceId;
const applicationOf = (g) => ({
  schema: "transitline.rail-capacity-application/1", contractVersion: 1, applicationId: `rail-capacity-application:example:${g.railGeometryId}`, operationalLineId: "line:1",
  railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sections: g.sections.map((s, i) => ({ trackSegmentId: `track-segment:${i + 1}`, railCapacitySectionId: s.sectionId })),
});

// the west and east ends of the radial spoke each get a platform and a turnback track that start where the approach ends
const spokeTerminals = (sp) => {
  const west = sp.stationCandidates.find((s) => s.id === first(sp)).location;
  const east = sp.stationCandidates.find((s) => s.id === last(sp)).location;
  return [
    { key: "terminal-west", stationId: first(sp), platforms: [{ key: "platform-west", approach: ref(sp, 0), polyline: [west, shift(west, -0.0016, 0)], platformLengthMeters: 120 }], turnbackTracks: [{ key: "turnback-west", kind: "turnback", polyline: [west, shift(west, -0.0014, 0.0004)] }] },
    { key: "terminal-east", stationId: last(sp), platforms: [{ key: "platform-east", approach: ref(sp, 2), polyline: [east, shift(east, 0.0016, 0)], platformLengthMeters: 120 }], turnbackTracks: [{ key: "pull-out-east", kind: "pull-out", polyline: [east, shift(east, 0.0013, 0.0004)] }] },
  ];
};
const spokeDesign = (sp, key, name, { terminals = true, boundaries = [] } = {}) => ({
  key, name, planIds: [sp.planId], designedRevisions: recorded(sp), sectionFacts: [0, 1, 2].map((i) => player(sp, i, { directionMode: "double" })),
  blockBoundaries: boundaries, ...(terminals ? { terminals: spokeTerminals(sp) } : {}),
});
const corridorDesign = (t, key, name, extra = {}) => ({ key, name, planIds: [t.planId], designedRevisions: recorded(t), ...extra });
const BAND_PEAK = { label: "Weekday peak", periodId: "weekday", startMinute: 420, endMinute: 540 };
const BAND_DAY = { label: "Weekday daytime", periodId: "weekday", startMinute: 540, endMinute: 1020 };

// each example: { file, case[], externalNetworks?, design: (plans) => drawn rail design, previousDesign?: (plans) => the design the player made the plan on,
//   application?: bool, inactive?: bool, author: (doc, g, plans) => the plan key (the player's editing, step by step) }
const EXAMPLES = {
  "example-radial": () => {
    const spoke = (p) => byName(p, "spoke");
    const full = (id) => (p) => spokeDesign(spoke(p), `example:radial:${id}`, "Spoke with a platform and a turnback track stated at both terminals");
    const keyOf = (id) => `example:radial:service-${id}`;
    const start = (doc, g, id, name, over) => { const key = keyOf(id); addPlan(doc, { key, name, railGeometry: g, operationalLineId: "line:1", ...over }); return key; };
    const wholeSpoke = (doc, g, sp, key) => setRoute(doc, key, { sectionIds: [0, 1, 2].map((i) => sec(g, sp, i).sectionId) }, g);
    return [
      { file: "01-double-track-both-directions", case: ["double-track-both-directions"], design: full("geometry-double"), application: true,
        author: (doc, g, p) => {
          const sp = spoke(p);
          const key = start(doc, g, "double-track", "Spoke, both directions, turning back at the terminals", { planKind: "regular", operatingPattern: "full" });
          wholeSpoke(doc, g, sp, key);
          addBothDirections(doc, key, first(sp), last(sp), ["Outbound", "Inbound"]);
          addBand(doc, key, { ...BAND_PEAK, headwayMinutes: 4, trainsets: 8, formationCars: 8 });
          addBand(doc, key, { ...BAND_DAY, headwayMinutes: 8, trainsets: 5, formationCars: 6 });
          addTurnback(doc, key, { stationId: first(sp), intent: "route-end", terminalResourceId: terminalId(g, "terminal-west") });
          addTurnback(doc, key, { stationId: last(sp), intent: "route-end" }); // the east terminal exists in the geometry, but the player did not pick it
          setVehicleIntent(doc, key, { vehicleModelId: "vehicle-model:example-8-car", requestedCars: 8, requestedTrainsets: 8 });
          addAssumption(doc, key, "Peak trains are not short-turned.");
          return key;
        } },
      { file: "02-short-working", case: ["short-working"], design: full("geometry-short"), application: true,
        author: (doc, g, p) => {
          const sp = spoke(p);
          const key = start(doc, g, "short-working", "Only the western two sections run; trains turn back at the third station", { planKind: "disruption-response", operatingPattern: "short-turn" });
          setRoute(doc, key, { sectionIds: [0, 1].map((i) => sec(g, sp, i).sectionId) }, g);
          addBothDirections(doc, key, first(sp), sp.segments[1].to, ["Outbound", "Inbound"]);
          addBand(doc, key, { label: "All day", periodId: "weekday", startMinute: 360, endMinute: 1320, headwayMinutes: 10, trainsets: 3, formationCars: 4 });
          addTurnback(doc, key, { stationId: sp.segments[1].to, intent: "intermediate" });
          addAssumption(doc, key, "The eastern section is closed; passengers are not carried past the third station.");
          return key;
        } },
      { file: "03-midway-turnback-no-facility-data", case: ["midway-turnback-no-facility-data"], design: (p) => spokeDesign(spoke(p), "example:radial:geometry-no-terminals", "Spoke with no terminal data stated", { terminals: false }),
        author: (doc, g, p) => {
          const sp = spoke(p);
          const key = start(doc, g, "midway-turnback", "Full line plus peak trains that turn back at the third station", { planKind: "regular", operatingPattern: "short-turn" });
          wholeSpoke(doc, g, sp, key);
          const [out, back] = addBothDirections(doc, key, first(sp), last(sp), ["Outbound", "Inbound"]);
          const short = addDirection(doc, key, { label: "Short outbound", fromStationId: first(sp), toStationId: sp.segments[1].to });
          const shortBack = addDirection(doc, key, { label: "Short inbound", fromStationId: sp.segments[1].to, toStationId: first(sp) });
          addBand(doc, key, { ...BAND_PEAK, headwayMinutes: 6, trainsets: 6, formationCars: 8, directionKeys: [out.key, back.key] });
          addBand(doc, key, { label: "Peak, short working", periodId: "weekday", startMinute: 420, endMinute: 540, headwayMinutes: 12, trainsets: 2, formationCars: 8, directionKeys: [short.key, shortBack.key] });
          addTurnback(doc, key, { stationId: sp.segments[1].to, intent: "intermediate" });
          return key;
        } },
      { file: "04-stale-geometry-revision", case: ["stale-geometry-revision"], application: true,
        previousDesign: full("geometry-stale"),
        design: (p) => spokeDesign(spoke(p), "example:radial:geometry-stale", "Spoke with a platform and a turnback track stated at both terminals", { boundaries: [boundary("boundary-1", spoke(p), 1, 1200)] }),
        author: (doc, g, p) => {
          const sp = spoke(p);
          const key = start(doc, g, "stale", "Written before a block boundary was drawn in the middle section", { planKind: "regular", operatingPattern: "full" });
          wholeSpoke(doc, g, sp, key);
          addBothDirections(doc, key, first(sp), last(sp));
          addBand(doc, key, { ...BAND_PEAK, headwayMinutes: 5, trainsets: 7, formationCars: 8 });
          return key;
        } },
      { file: "05-inactive-saved-restored", case: ["inactive-saved-restored"], design: full("geometry-inactive"), inactive: true,
        author: (doc, g, p) => {
          const sp = spoke(p);
          const key = start(doc, g, "inactive", "Switched off for now, kept for later", { planKind: "regular", operatingPattern: "full" });
          wholeSpoke(doc, g, sp, key);
          addBothDirections(doc, key, first(sp), last(sp));
          addBand(doc, key, { ...BAND_DAY, headwayMinutes: 12, trainsets: 4, formationCars: 6 });
          return key;
        } },
    ];
  },
  "example-corridor": () => {
    const trunk = (p) => p[0];
    const keyOf = (id) => `example:corridor:service-${id}`;
    const whole = (doc, g, t, key) => { setRoute(doc, key, { sectionIds: [0, 1, 2].map((i) => sec(g, t, i).sectionId) }, g); addBothDirections(doc, key, first(t), last(t), ["Eastbound", "Westbound"]); };
    return [
      { file: "01-single-track-meeting-unknown", case: ["single-track-meeting-unknown"], design: (p) => corridorDesign(trunk(p), "example:corridor:geometry-single", "Trunk, only the middle section stated as single track, no block data", { sectionFacts: [player(trunk(p), 1, { directionMode: "single" })] }),
        author: (doc, g, p) => {
          const t = trunk(p);
          const key = keyOf("single-track");
          addPlan(doc, { key, name: "Trunk run in both directions over a single-track middle section", railGeometry: g, planKind: "regular", operatingPattern: "full" });
          whole(doc, g, t, key);
          addBand(doc, key, { ...BAND_DAY, headwayMinutes: 15, trainsets: 3, formationCars: 4 });
          return key;
        } },
      { file: "02-terminal-resource-stated", case: ["terminal-resource-stated"], application: true,
        design: (p) => {
          const t = trunk(p);
          return corridorDesign(t, "example:corridor:geometry-terminal", "East terminal with two platform tracks, a stabling track and a pull-out track", {
            sectionFacts: [0, 1, 2].map((i) => player(t, i, { directionMode: "double" })),
            junctions: [{ key: "turnout-1", kind: "turnout", location: [0.0092, 0], connections: [{ ...ref(t, 2), role: "stem" }] }],
            terminals: [{ key: "terminal-1", stationId: last(t),
              platforms: [
                { key: "platform-1", approach: ref(t, 2), polyline: [[0.01, 0], [0.0112, 0]], platformLengthMeters: 120 },
                { key: "platform-2", approach: ref(t, 2), viaJunctionKeys: ["turnout-1"], polyline: [[0.0092, 0], [0.0097, -0.0003], [0.0112, -0.0003]], platformLengthMeters: 120 },
              ],
              turnbackTracks: [
                { key: "stabling-1", kind: "stabling", viaJunctionKey: "turnout-1", polyline: [[0.0092, 0], [0.0092, -0.0007], [0.0106, -0.0011]] },
                { key: "pull-out-1", kind: "pull-out", polyline: [[0.0095, 0.0003], [0.0112, 0.0003]] },
              ] }],
          });
        },
        author: (doc, g, p) => {
          const t = trunk(p);
          const key = keyOf("terminal-resource");
          addPlan(doc, { key, name: "Trunk turning back at the stated east terminal", railGeometry: g, planKind: "regular", operatingPattern: "full", operationalLineId: "line:1" });
          whole(doc, g, t, key);
          const terminal = g.terminals.find((x) => x.key === "terminal-1");
          addBand(doc, key, { ...BAND_PEAK, headwayMinutes: 6, trainsets: 6, formationCars: 8 });
          addTurnback(doc, key, { stationId: last(t), intent: "route-end", terminalResourceId: terminal.terminalResourceId, turnbackCandidateId: terminal.turnbackCandidates.find((c) => c.key === "pull-out-1").turnbackCandidateId });
          setVehicleIntent(doc, key, { vehicleModelId: "vehicle-model:example-8-car", requestedCars: 8, requestedTrainsets: 6 });
          return key;
        } },
      { file: "03-several-blocks", case: ["several-blocks"], design: (p) => { const t = trunk(p); return corridorDesign(t, "example:corridor:geometry-blocks", "Double-track trunk split into several blocks", { sectionFacts: [0, 1, 2].map((i) => player(t, i, { directionMode: "double" })), blockBoundaries: [boundary("boundary-1", t, 0, 700), boundary("boundary-2", t, 0, 1500), boundary("boundary-3", t, 1, 1000), boundary("boundary-4", t, 2, 900)] }); },
        author: (doc, g, p) => {
          const t = trunk(p);
          const key = keyOf("several-blocks");
          addPlan(doc, { key, name: "Trunk over sections that hold several blocks each", railGeometry: g, planKind: "regular", operatingPattern: "full" });
          whole(doc, g, t, key);
          addBand(doc, key, { ...BAND_PEAK, headwayMinutes: 3, trainsets: 10, formationCars: 8 });
          return key;
        } },
    ];
  },
  tokyo: (pack) => {
    const koto = readJson(`${pack.dir}/existing-network.json`).lines.filter((l) => l.stationIds.includes("ward-koto") && l.osmRelationId !== undefined).sort((a, b) => a.osmRelationId - b.osmRelationId)[0];
    const extId = `ext-line:${koto.osmRelationId}`;
    return [
      { file: "01-external-through-service", case: ["external-through-service"], externalNetworks: true,
        design: (p) => { const plan = byName(p, "east-river-crossing"); return { key: "example:tokyo:geometry-through", name: "East river crossing and an existing line (station level only)", planIds: [plan.planId], externalLineIds: [extId], designedRevisions: recorded(plan), sectionFacts: [player(plan, 1, { directionMode: "double" })] }; },
        author: (doc, g, p) => {
          const plan = byName(p, "east-river-crossing");
          const key = "example:tokyo:service-through";
          const externalSection = (i) => g.sections.find((s) => s.externalLineId === extId && s.fromStationId === koto.stationIds[i] && s.toStationId === koto.stationIds[i + 1]);
          addPlan(doc, { key, name: "Through service from the new crossing onto the existing line", railGeometry: g, planKind: "regular", operatingPattern: "full" });
          setRoute(doc, key, { sectionIds: [sec(g, plan, 0).sectionId, sec(g, plan, 1).sectionId, externalSection(0).sectionId, externalSection(1).sectionId] }, g);
          addDirection(doc, key, { label: "Outbound", fromStationId: first(plan), toStationId: koto.stationIds[2] });
          addBand(doc, key, { ...BAND_PEAK, headwayMinutes: 8, trainsets: 6, formationCars: 10 });
          addAssumption(doc, key, "The existing line's owner has agreed to the through service.");
          return key;
        } },
      { file: "02-almost-no-track-data", case: ["almost-no-track-data"],
        design: (p) => { const plan = byName(p, "bay-ward-spine"); return { key: "example:tokyo:geometry-bare", name: "Bay ward spine with nothing stated about its tracks", planIds: [plan.planId], designedRevisions: recorded(plan) }; },
        author: (doc, g, p) => {
          const plan = byName(p, "bay-ward-spine");
          const key = "example:tokyo:service-bare";
          addPlan(doc, { key, name: "Spine with only the route chosen", railGeometry: g });
          setRoute(doc, key, { sectionIds: [0, 1, 2].map((i) => sec(g, plan, i).sectionId) }, g);
          return key;
        } },
    ];
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const planList = fs.readdirSync(path.join(root, pack.dir, "plan-examples")).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
  const externals = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "service-plan-examples");
  fs.mkdirSync(outDir, { recursive: true });
  const ctxPack = { manifest: pack.manifest };
  for (const ex of EXAMPLES[id](pack)) {
    const externalNetworks = ex.externalNetworks ? externals : [];
    const geometryOf = (design) => {
      const out = buildRailGeometry(design, { pack: ctxPack, plans: planList, externalNetworks });
      if (!out.design) throw new Error(`${id}/${ex.file}: geometry rejected ${JSON.stringify(out.warnings)}`);
      return out.design;
    };
    const current = geometryOf(ex.design(planList));
    const madeOn = ex.previousDesign ? geometryOf(ex.previousDesign(planList)) : current; // the geometry the player wrote the plan on
    const doc = newServicePlanDoc(pack.manifest.id, pack.manifest.version ?? null);
    const key = ex.author(doc, madeOn, planList);
    if (ex.inactive) deactivatePlan(doc, key);
    const saved = serializeServicePlanDoc(doc);
    const restored = restoreServicePlanDoc(saved, ctxPack);
    if (restored.rejected || restored.warnings.length || serializeServicePlanDoc(restored.doc) !== saved) throw new Error(`${id}/${ex.file}: the saved document did not come back as it was`);
    const drawn = drawnPlansOf(restored.doc).find((p) => p.key === key);
    const application = ex.application ? applicationOf(madeOn) : null;
    const out = buildServicePlan(drawn, { pack: ctxPack, railGeometry: current, application });
    if (!out.plan) throw new Error(`${id}/${ex.file}: plan rejected ${JSON.stringify(out.warnings)}`);
    const body = { ...out.plan, source: {
      case: ex.case, synthetic: true, note: NOTE, existingRail: Boolean(ex.externalNetworks),
      input: { drawnGeometry: ex.design(planList), ...(ex.previousDesign ? { previousDrawnGeometry: ex.previousDesign(planList) } : {}), application, savedDocument: JSON.parse(saved) }, generatedBy: GENERATED_BY,
    } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.service-plan.json`), `${JSON.stringify(body, null, 2)}\n`);
    const p = out.plan;
    console.log(`[${id}] ${ex.file}: active=${p.active} revision=${p.revision.state} sections=${p.route.sectionIds?.length ?? null} stations=${p.route.stationIds?.length ?? null} dirs=${p.directions?.length ?? null} bands=${p.serviceBands?.length ?? null} turnbacks=${p.turnbacks?.length ?? null} flags=[${p.spatialFacts.spatialFlags}] unknown=${p.unknown.length} warn=${out.warnings.map((w) => w.code)}`);
  }
}
