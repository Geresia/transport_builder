import { TECHNICAL_PROFILES } from "./construction.mjs";
import { VEHICLE_MODELS } from "./rolling-stock.mjs";

export const TECHNICAL_COMPATIBILITY_SCHEMA = "transitline.technical-compatibility/1";
export const TECHNICAL_COMPATIBILITY_VERDICTS = Object.freeze(["possible", "conditional", "impossible", "unknown"]);

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value) => typeof value === "string" && value.trim() ? value : null;
const list = (value) => Array.isArray(value) ? [...new Set(value.filter((entry) => text(entry)).map(String))].sort() : null;
const clone = (value) => value === undefined ? null : structuredClone(value);

function check(checkId, status, infrastructureValue, vehicleValue, reason) {
  return { checkId, status, infrastructureValue: clone(infrastructureValue), vehicleValue: clone(vehicleValue), reason };
}

function exactCheck(checkId, infrastructureValue, supportedValues) {
  const required = text(infrastructureValue);
  const supported = list(supportedValues);
  if (!required || supported === null) return check(checkId, "unknown", required, supported, `${checkId}-data-missing`);
  return supported.includes(required)
    ? check(checkId, "compatible", required, supported, null)
    : check(checkId, "incompatible", required, supported, `${checkId}-not-supported`);
}

function overlapCheck(checkId, infrastructureValues, vehicleValues) {
  const infrastructure = list(infrastructureValues);
  const vehicle = list(vehicleValues);
  if (infrastructure === null || vehicle === null || !infrastructure.length || !vehicle.length) return check(checkId, "unknown", infrastructure, vehicle, `${checkId}-data-missing`);
  return infrastructure.some((value) => vehicle.includes(value))
    ? check(checkId, "compatible", infrastructure, vehicle, null)
    : check(checkId, "incompatible", infrastructure, vehicle, `${checkId}-not-supported`);
}

function upperLimitCheck(checkId, infrastructureLimit, vehicleDemand) {
  const limit = finite(infrastructureLimit);
  const demand = finite(vehicleDemand);
  if (limit === null || demand === null) return check(checkId, "unknown", limit, demand, `${checkId}-data-missing`);
  return demand <= limit
    ? check(checkId, "compatible", limit, demand, null)
    : check(checkId, "incompatible", limit, demand, `${checkId}-limit-exceeded`);
}

function capabilityCheck(checkId, infrastructureDemand, vehicleCapability) {
  const demand = finite(infrastructureDemand);
  const capability = finite(vehicleCapability);
  if (demand === null || capability === null) return check(checkId, "unknown", demand, capability, `${checkId}-data-missing`);
  return capability >= demand
    ? check(checkId, "compatible", demand, capability, null)
    : check(checkId, "incompatible", demand, capability, `${checkId}-limit-exceeded`);
}

function minimumCheck(checkId, infrastructureMinimum, vehicleMinimum) {
  const available = finite(infrastructureMinimum);
  const required = finite(vehicleMinimum);
  if (available === null || required === null) return check(checkId, "unknown", available, required, `${checkId}-data-missing`);
  return required <= available
    ? check(checkId, "compatible", available, required, null)
    : check(checkId, "incompatible", available, required, `${checkId}-limit-exceeded`);
}

function powerCheck(infrastructure, vehicle) {
  const required = {
    collectionSystemId: text(infrastructure.collectionSystemId),
    currentSystem: text(infrastructure.currentSystem),
    voltageV: finite(infrastructure.voltageV),
  };
  const supported = Array.isArray(vehicle.supportedPowerSystems)
    ? vehicle.supportedPowerSystems.map((entry) => ({
      collectionSystemId: text(entry?.collectionSystemId),
      currentSystem: text(entry?.currentSystem),
      voltageV: finite(entry?.voltageV),
    }))
    : null;
  if (Object.values(required).some((value) => value === null) || supported === null) {
    return check("power-system", "unknown", required, supported, "power-system-data-missing");
  }
  const compatible = supported.some((entry) => entry.collectionSystemId === required.collectionSystemId
    && entry.currentSystem === required.currentSystem
    && entry.voltageV === required.voltageV);
  return compatible
    ? check("power-system", "compatible", required, supported, null)
    : check("power-system", "incompatible", required, supported, "power-system-not-supported");
}

function gaugeCheck(infrastructure, vehicle) {
  if (infrastructure.gaugeMm === null && !["steel-wheel", "linear-motor-steel-wheel"].includes(infrastructure.runningSystemId)) {
    return check("gauge", "compatible", null, vehicle.supportedGaugeMm ?? null, "gauge-not-applicable");
  }
  const required = finite(infrastructure.gaugeMm);
  const supported = Array.isArray(vehicle.supportedGaugeMm) ? vehicle.supportedGaugeMm.map(finite).filter((value) => value !== null) : null;
  if (required === null || supported === null) return check("gauge", "unknown", required, supported, "gauge-data-missing");
  return supported.includes(required)
    ? check("gauge", "compatible", required, supported, null)
    : check("gauge", "incompatible", required, supported, "gauge-not-supported");
}

function platformHeightCheck(infrastructure, vehicle) {
  const height = finite(infrastructure.platformHeightMm);
  const range = vehicle.supportedPlatformHeightMm;
  const minimum = finite(range?.min);
  const maximum = finite(range?.max);
  if (height === null || minimum === null || maximum === null) return check("platform-height", "unknown", height, range ?? null, "platform-height-data-missing");
  return height >= minimum && height <= maximum
    ? check("platform-height", "compatible", height, { min: minimum, max: maximum }, null)
    : check("platform-height", "incompatible", height, { min: minimum, max: maximum }, "platform-height-out-of-range");
}

function formationCheck(infrastructure, vehicle) {
  const cars = finite(vehicle.cars);
  const minCars = finite(infrastructure.minCars);
  const maxCars = finite(infrastructure.maxCars);
  if (cars === null || minCars === null || maxCars === null) return check("formation", "unknown", { minCars, maxCars }, cars, "formation-data-missing");
  return cars >= minCars && cars <= maxCars
    ? check("formation", "compatible", { minCars, maxCars }, cars, null)
    : check("formation", "incompatible", { minCars, maxCars }, cars, "formation-out-of-range");
}

function operatingModeAdjust(checks, operatingMode) {
  if (operatingMode !== "towed-transfer") return checks;
  const towConditional = new Set(["power-system", "signal-system"]);
  return checks.map((entry) => towConditional.has(entry.checkId) && entry.status === "incompatible"
    ? { ...entry, status: "conditional", reason: `${entry.checkId}-tow-and-authorisation-required` }
    : entry);
}

function verdictOf(checks) {
  if (checks.some((entry) => entry.status === "incompatible")) return "impossible";
  if (checks.some((entry) => entry.status === "unknown")) return "unknown";
  if (checks.some((entry) => entry.status === "conditional")) return "conditional";
  return "possible";
}

export function assessTechnicalCompatibility({
  legId = null,
  technicalProfileId,
  vehicleModelId,
  operatingMode = "revenue-self-propelled",
  infrastructureOverrides = {},
  vehicleOverrides = {},
} = {}) {
  if (!["revenue-self-propelled", "towed-transfer"].includes(operatingMode)) throw new Error(`Invalid operating mode ${operatingMode}`);
  const baseInfrastructure = TECHNICAL_PROFILES[technicalProfileId] ?? null;
  const baseVehicle = VEHICLE_MODELS[vehicleModelId] ?? null;
  if (!baseInfrastructure) throw new Error(`Unknown technical profile ${technicalProfileId}`);
  if (!baseVehicle) throw new Error(`Unknown vehicle model ${vehicleModelId}`);
  const infrastructure = { ...baseInfrastructure, ...structuredClone(infrastructureOverrides) };
  const vehicle = { ...baseVehicle, ...structuredClone(vehicleOverrides) };
  const checks = operatingModeAdjust([
    exactCheck("running-system", infrastructure.runningSystemId, vehicle.supportedRunningSystemIds),
    gaugeCheck(infrastructure, vehicle),
    powerCheck(infrastructure, vehicle),
    upperLimitCheck("loading-gauge-width", infrastructure.carWidthM, vehicle.carWidthM),
    upperLimitCheck("axle-load", infrastructure.maxAxleLoadTonnes, vehicle.axleLoadTonnes),
    minimumCheck("minimum-curve-radius", infrastructure.minimumCurveRadiusMeters, vehicle.minimumCurveRadiusMeters),
    capabilityCheck("maximum-gradient", infrastructure.maxGradientPermille, vehicle.maxGradientPermille),
    overlapCheck("signal-system", infrastructure.signalSystemIds, vehicle.supportedSignalSystemIds),
    platformHeightCheck(infrastructure, vehicle),
    exactCheck("door-layout", infrastructure.doorLayoutId, [vehicle.doorLayoutId]),
    formationCheck(infrastructure, vehicle),
    exactCheck("maintenance-system", infrastructure.maintenanceSystemId, vehicle.maintenanceSystemIds),
  ], operatingMode);
  const violations = checks.filter((entry) => entry.status === "incompatible").map((entry) => entry.reason);
  const conditions = checks.filter((entry) => entry.status === "conditional").map((entry) => entry.reason);
  const missingInputs = checks.filter((entry) => entry.status === "unknown").map((entry) => entry.reason);
  return {
    schema: TECHNICAL_COMPATIBILITY_SCHEMA,
    contractVersion: 1,
    legId: text(legId),
    technicalProfileId,
    vehicleModelId,
    operatingMode,
    verdict: verdictOf(checks),
    checks,
    violations,
    conditions,
    missingInputs,
  };
}
