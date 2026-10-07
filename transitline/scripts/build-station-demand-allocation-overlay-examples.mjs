// Dev-time generator for the station demand allocation overlay examples in packs/example-radial/station-demand-allocation-overlay-examples/.
//   node scripts/build-station-demand-allocation-overlay-examples.mjs [--out <dir>]   (npm run station-demand-allocation-overlay-examples)
// With --out the files go to <dir>/example-radial/ instead of the pack (the tests use that to check regeneration).
//
// Each example is the overlay's VIEW MODEL of an allocation that was really applied through the engine (map access export ->
// applyStationDemandAccess -> a player policy -> applyStationDemandAllocation), in a small SYNTHETIC world written for this purpose
// (scripts/lib/allocation-overlay-world.mjs): two access sites, three demand nodes, three operational stations.  Nothing here is a real
// place, a real policy or a real demand figure, and no passenger is created or counted.  Nothing here reads a clock or a random number.
import fs from "node:fs";
import path from "node:path";
import { buildAllocationOverlayView } from "../engine/src/map/station-demand-allocation-view.mjs";
import { ALLOCATION_VARIANTS, buildAppliedWorld } from "./lib/allocation-overlay-world.mjs";
import { root } from "./lib/pack-spatial.mjs";

const GENERATED_BY = "scripts/build-station-demand-allocation-overlay-examples.mjs";
const NOTE = "Synthetic: a tiny invented world run through the real engine apply path. The view model is what the map overlay draws from runtime.stationDemandAllocationReport(); shares are the policy's expected shares, not passenger counts.";
const CASES = {
  split: ["fixed-shares-60-40", "whole-node-assignment", "overlapping-catchments"],
  partial: ["fixed-shares-50-20", "unallocated-share", "unrouted-share"],
  blocked: ["blocked-link", "station-not-operational", "partly-routed"],
  held: ["shared-node-held", "no-rule", "exclusive-node-assigned"],
  unknown: ["coarse-demand-source", "unknown-nodes", "nothing-assigned"],
  stale: ["stale-allocation", "links-kept", "faded"],
  whole: ["single-site", "whole-node-assignment"],
};
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outDir = outFlag >= 0 ? path.join(path.resolve(args[outFlag + 1]), "example-radial") : path.join(root, "packs", "example-radial", "station-demand-allocation-overlay-examples");
fs.mkdirSync(outDir, { recursive: true });
ALLOCATION_VARIANTS.forEach((variant, index) => {
  const world = buildAppliedWorld(variant);
  const view = buildAllocationOverlayView({ report: world.report, access: world.access, demandNodes: world.demandNodes, stations: world.stations });
  const body = { ...view, source: { case: CASES[variant], synthetic: true, note: NOTE, world: "scripts/lib/allocation-overlay-world.mjs", variant, generatedBy: GENERATED_BY } };
  const file = `${String(index + 1).padStart(2, "0")}-${variant}.overlay.json`;
  fs.writeFileSync(path.join(outDir, file), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`${file}: status=${view.status} nodes=${view.nodes.map((n) => `${n.demandNodeId}:${n.visual.key}`).join(",")} lines=${view.lines.length} totals=${JSON.stringify(view.totals)}`);
});
