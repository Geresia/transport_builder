import test from "node:test";
import assert from "node:assert/strict";
import { construction3dSourcesFrom2d } from "../src/construction-3d-source-adapters.mjs";

test("2D source adapter preserves source identity and supplied geometry without a verdict", () => {
  const output = construction3dSourcesFrom2d({
    railGeometries: { designs: [{ railGeometryId: "rail:1", railGeometryRevision: "r1", sourcePackId: "p", sections: [{ alignment: [[0, 0], [1, 1]] }] }] },
    stationSites: { sites: [{ stationSiteId: "station:1", stationSiteRevision: "s1", sourcePackId: "p", center: [1, 2] }] },
    depotSites: { sites: [{ depotSiteId: "depot:1", depotSiteRevision: "d1", sourcePackId: "p", polygon: [[0, 0], [1, 0], [0, 1]] }] },
    developments: { developments: [{ developmentId: "town:1", developmentRevision: "t1", sourcePackId: "p", phases: [{ polygon: [[2, 2], [3, 2], [2, 3]] }] }] },
  });
  assert.deepEqual(output.sources.map((row) => row.sourceType), ["depot-site", "new-town-development", "rail-geometry", "station-site"]);
  assert.deepEqual(output.warnings, []);
  assert.ok(output.notComputed.includes("conflict"));
});
test("missing and duplicate identities are warnings, not invented source IDs", () => {
  const output = construction3dSourcesFrom2d({ stationSites: [{ stationSiteId: "s", stationSiteRevision: "r", sourcePackId: "p" }, { stationSiteId: "s", stationSiteRevision: "r2", sourcePackId: "p" }, { stationSiteId: "missing" }] });
  assert.equal(output.sources.length, 1);
  assert.equal(output.sources[0].sourceRevision, "r");
  assert.equal(output.warnings.length, 2);
});
test("a source without a stated pack is retained as unknown, not silently attributed to the host pack", () => {
  const out = construction3dSourcesFrom2d({ stationSites: { sites: [{ stationSiteId: "station:unknown-pack", stationSiteRevision: "r1", center: [0, 0] }] } });
  assert.equal(out.sources[0].sourcePackId, null);
  assert.deepEqual(out.warnings, [{ code: "source-pack-unknown", sourceType: "station-site", sourceId: "station:unknown-pack" }]);
});
