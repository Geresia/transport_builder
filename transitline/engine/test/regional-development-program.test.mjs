import test from "node:test";
import assert from "node:assert/strict";
import {
  REGIONAL_DEVELOPMENT_PROGRAM_SCHEMA, buildRegionalDevelopmentProgram, buildRegionalDevelopmentProgramExport,
} from "../src/map/regional-development-program.mjs";
import {
  addRegionalDevelopmentMilestone, addRegionalDevelopmentProgram, drawnRegionalDevelopmentProgramsOf,
  newRegionalDevelopmentProgramDoc, removeRegionalDevelopmentProgram, restoreRegionalDevelopmentProgramDoc,
  serializeRegionalDevelopmentProgramDoc,
} from "../src/map/regional-development-program-editor.mjs";

const pack = { manifest: { id: "radial", version: "1", data: { license: "CC0", attribution: ["fixture"] } } };
const drawn = () => ({ key: "western", name: "Western Arc", active: true, linkedDevelopmentIds: ["town-a"], linkedPlanIds: null, linkedStationSiteIds: [], linkedServicePlanIds: null, playerStatedPolicy: "serve in phases", playerStatedPriority: 1, milestones: [{ key: "first", name: "First phase", sequence: 8, targetMonth: 0, durationMonths: null, linkedDevelopmentIds: ["town-a"], linkedPlanIds: null, linkedStationSiteIds: [], linkedServicePlanIds: null }] });
const context = () => ({ pack, newTownDevelopmentExport: { developments: [{ developmentId: "town-a", developmentRevision: "r1", sourcePackId: "radial", active: true }] } });

test("program ids ignore names and input list ordering, while its revision follows planning facts", () => {
  const one = buildRegionalDevelopmentProgram(drawn(), context());
  const reordered = drawn(); reordered.name = "renamed"; reordered.linkedDevelopmentIds = ["town-a", "town-a"];
  const two = buildRegionalDevelopmentProgram(reordered, context());
  assert.equal(one.schema, REGIONAL_DEVELOPMENT_PROGRAM_SCHEMA);
  assert.equal(one.programId, two.programId);
  assert.equal(one.programRevision, two.programRevision);
  const changed = drawn(); changed.milestones[0].targetMonth = 2;
  assert.notEqual(one.programRevision, buildRegionalDevelopmentProgram(changed, context()).programRevision);
});

test("null, stated zero, and an empty declared link list remain distinct", () => {
  const value = buildRegionalDevelopmentProgram(drawn(), context());
  assert.equal(value.linkedPlanIds, null);
  assert.deepEqual(value.linkedStationSiteIds, []);
  assert.equal(value.milestones[0].targetMonth, 0);
  assert.equal(value.milestones[0].durationMonths, null);
});

test("link facts report current, missing, inactive, other-pack, and unknown without a verdict", () => {
  const value = drawn(); value.linkedDevelopmentIds = ["current", "gone", "off", "foreign"]; value.linkedPlanIds = ["plan-a"];
  const result = buildRegionalDevelopmentProgram(value, { pack, newTownDevelopmentExport: { developments: [
    { developmentId: "current", developmentRevision: "1", sourcePackId: "radial", active: true },
    { developmentId: "off", developmentRevision: "2", sourcePackId: "radial", active: false },
    { developmentId: "foreign", developmentRevision: "3", sourcePackId: "elsewhere", active: true },
    { developmentId: "town-a", developmentRevision: "4", sourcePackId: "radial", active: true },
  ] } });
  const status = Object.fromEntries(result.linkFacts.map((fact) => [`${fact.refKind}:${fact.refId}`, fact.geometryStatus]));
  assert.deepEqual(status, { "development:current": "current", "development:foreign": "other-pack", "development:gone": "missing", "development:off": "inactive", "plan:plan-a": "missing", "development:town-a": "current" });
  assert.equal(result.linkFacts.find((fact) => fact.refKind === "plan").found, null);
  assert.ok(result.unknown.includes("linkFacts:plan"));
});

test("export is deterministic and does not mutate frozen source data", () => {
  const programs = Object.freeze([Object.freeze(drawn())]);
  const out1 = buildRegionalDevelopmentProgramExport({ ...context(), programs });
  const out2 = buildRegionalDevelopmentProgramExport({ ...context(), programs: [...programs].reverse() });
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  assert.equal(out1.programs.length, 1);
});

test("editor retains tombstones and rejects another pack without replacing current work", () => {
  const doc = newRegionalDevelopmentProgramDoc("radial", "1");
  addRegionalDevelopmentProgram(doc, { key: "p" }); addRegionalDevelopmentMilestone(doc, "p", { targetMonth: 0 });
  removeRegionalDevelopmentProgram(doc, "p"); const next = addRegionalDevelopmentProgram(doc);
  assert.equal(next.key, "program-1");
  assert.deepEqual(drawnRegionalDevelopmentProgramsOf(doc).map((item) => item.key), ["program-1"]);
  const restored = restoreRegionalDevelopmentProgramDoc(serializeRegionalDevelopmentProgramDoc(doc), { manifest: { id: "other", version: "1" } }, { current: doc });
  assert.equal(restored.document, doc); assert.equal(restored.rejected, "program-document-other-pack");
});
