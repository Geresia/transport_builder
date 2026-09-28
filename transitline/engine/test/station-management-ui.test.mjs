import test from "node:test";
import assert from "node:assert/strict";
import { stationManagementView } from "../src/station-management-ui.mjs";

function runtimeWith({ packages = [], summary = {} } = {}) {
  const project = { id: "project:p", status: "estimated" };
  return {
    game: { stationPackages: packages },
    projectForPlan: () => project,
    stationDeliverySummary: () => ({ expected: 2, designed: packages.length, awarded: 0, integrated: false, ready: false, reasons: [], packages, ...summary }),
  };
}

test("station management view exposes the next legal action without mutating runtime", () => {
  const site = { stationSiteId: "site:a" };
  const empty = stationManagementView(runtimeWith(), "p", site);
  assert.equal(empty.canDesign, true);
  assert.equal(empty.canResolve, false);

  const designedPackage = { stationSiteId: "site:a", status: "designed", unresolvedConditions: [{ code: "survey" }], unresolvedViolations: [], ranking: [] };
  const designed = stationManagementView(runtimeWith({ packages: [designedPackage] }), "p", site);
  assert.equal(designed.canDesign, false);
  assert.equal(designed.canResolve, true);
  assert.equal(designed.canTender, false);

  designedPackage.unresolvedConditions = [];
  assert.equal(stationManagementView(runtimeWith({ packages: [designedPackage] }), "p", site).canTender, true);
});

test("award and full-line integration actions require the corresponding package states", () => {
  const site = { stationSiteId: "site:a" };
  const tendered = { stationSiteId: "site:a", status: "tendered", unresolvedConditions: [], unresolvedViolations: [], ranking: [{ id: "bid:1" }] };
  assert.equal(stationManagementView(runtimeWith({ packages: [tendered] }), "p", site).canAward, true);

  const awarded = [
    { stationSiteId: "site:a", status: "awarded", unresolvedConditions: [], unresolvedViolations: [], ranking: [] },
    { stationSiteId: "site:b", status: "awarded", unresolvedConditions: [], unresolvedViolations: [], ranking: [] },
  ];
  const view = stationManagementView(runtimeWith({ packages: awarded, summary: { awarded: 2 } }), "p", site);
  assert.equal(view.canIntegrate, true);
});
