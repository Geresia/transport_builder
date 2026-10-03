import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTechnicalCompatibility,
  TECHNICAL_COMPATIBILITY_SCHEMA,
  TECHNICAL_PROFILES,
  VEHICLE_MODELS,
} from "../src/management/index.mjs";

const assess = (overrides = {}) => assessTechnicalCompatibility({
  legId: "leg:1",
  technicalProfileId: "medium_steel",
  vehicleModelId: "medium_4car",
  ...overrides,
});

test("a matching built-in profile passes every detailed technical check", () => {
  const result = assess();
  assert.equal(result.schema, TECHNICAL_COMPATIBILITY_SCHEMA);
  assert.equal(result.verdict, "possible");
  assert.equal(result.checks.length, 12);
  assert.ok(result.checks.every((entry) => entry.status === "compatible"));
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.missingInputs, []);
});

test("every shipped vehicle model remains compatible with its declared infrastructure bundle", () => {
  for (const vehicle of Object.values(VEHICLE_MODELS)) {
    const result = assessTechnicalCompatibility({ technicalProfileId: vehicle.profileId, vehicleModelId: vehicle.id });
    assert.equal(result.verdict, "possible", `${vehicle.id}: ${JSON.stringify(result)}`);
  }
});

test("running system, gauge, collection, voltage and signal are independent failures", () => {
  const result = assess({
    vehicleOverrides: {
      supportedRunningSystemIds: ["rubber-tire-guideway"],
      supportedGaugeMm: [1067],
      supportedPowerSystems: [{ collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750 }],
      supportedSignalSystemIds: ["other-atc"],
    },
  });
  assert.equal(result.verdict, "impossible");
  assert.deepEqual(result.checks.filter((entry) => entry.status === "incompatible").map((entry) => entry.checkId), [
    "running-system", "gauge", "power-system", "signal-system",
  ]);
});

test("loading gauge, axle load, curve and gradient enforce their limits in the correct direction", () => {
  const result = assess({ vehicleOverrides: { carWidthM: 3.1, axleLoadTonnes: 17, minimumCurveRadiusMeters: 200, maxGradientPermille: 30 } });
  assert.equal(result.verdict, "impossible");
  assert.deepEqual(result.checks.filter((entry) => entry.status === "incompatible").map((entry) => entry.checkId), [
    "loading-gauge-width", "axle-load", "minimum-curve-radius", "maximum-gradient",
  ]);
});

test("platform height, door layout, formation and maintenance system are checked separately", () => {
  const result = assess({
    vehicleOverrides: {
      supportedPlatformHeightMm: { min: 700, max: 900 },
      doorLayoutId: "3-door-18m",
      cars: 2,
      maintenanceSystemIds: ["other"],
    },
  });
  assert.deepEqual(result.checks.filter((entry) => entry.status === "incompatible").map((entry) => entry.checkId), [
    "platform-height", "door-layout", "formation", "maintenance-system",
  ]);
});

test("missing facts remain unknown and are never converted to compatible", () => {
  const result = assess({ infrastructureOverrides: { signalSystemIds: null, platformHeightMm: null } });
  assert.equal(result.verdict, "unknown");
  assert.ok(result.missingInputs.includes("signal-system-data-missing"));
  assert.ok(result.missingInputs.includes("platform-height-data-missing"));
  assert.equal(result.checks.find((entry) => entry.checkId === "signal-system").status, "unknown");
});

test("multiple supported systems allow a genuinely multi-system vehicle without guessing", () => {
  const result = assess({
    infrastructureOverrides: { signalSystemIds: ["line-specific-atc", "ats-p"] },
    vehicleOverrides: {
      supportedGaugeMm: [1067, 1435],
      supportedPowerSystems: [
        { collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750 },
        { collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500 },
      ],
      supportedSignalSystemIds: ["other-atc", "ats-p"],
    },
  });
  assert.equal(result.verdict, "possible");
  assert.deepEqual(result.checks.find((entry) => entry.checkId === "signal-system").infrastructureValue, ["ats-p", "line-specific-atc"]);
});

test("towed transfer relaxes only traction power and signalling, not physical incompatibility", () => {
  const tractionOnly = assess({
    operatingMode: "towed-transfer",
    vehicleOverrides: {
      supportedPowerSystems: [{ collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750 }],
      supportedSignalSystemIds: ["other-atc"],
    },
  });
  assert.equal(tractionOnly.verdict, "conditional");
  assert.equal(tractionOnly.conditions.length, 2);
  const wrongGauge = assess({ operatingMode: "towed-transfer", vehicleOverrides: { supportedGaugeMm: [1067] } });
  assert.equal(wrongGauge.verdict, "impossible");
});

test("non-rail guideways explicitly treat gauge as not applicable", () => {
  const result = assessTechnicalCompatibility({ technicalProfileId: "agt", vehicleModelId: "agt_3car" });
  const gauge = result.checks.find((entry) => entry.checkId === "gauge");
  assert.equal(result.verdict, "possible");
  assert.equal(gauge.status, "compatible");
  assert.equal(gauge.reason, "gauge-not-applicable");
});

test("unknown catalog ids and invalid operating modes fail at the boundary", () => {
  assert.throws(() => assessTechnicalCompatibility({ technicalProfileId: "none", vehicleModelId: "medium_4car" }), /Unknown technical profile/);
  assert.throws(() => assessTechnicalCompatibility({ technicalProfileId: "medium_steel", vehicleModelId: "none" }), /Unknown vehicle model/);
  assert.throws(() => assess({ operatingMode: "teleport" }), /Invalid operating mode/);
});

test("assessment is deterministic, does not mutate catalogs, and contains no economic fields", () => {
  const profileBefore = structuredClone(TECHNICAL_PROFILES.medium_steel);
  const vehicleBefore = structuredClone(VEHICLE_MODELS.medium_4car);
  const first = assess();
  const second = assess();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(TECHNICAL_PROFILES.medium_steel, profileBefore);
  assert.deepEqual(VEHICLE_MODELS.medium_4car, vehicleBefore);
  const keys = JSON.stringify(first);
  assert.doesNotMatch(keys, /cost|price|fee|cash|duration|score/i);
});
