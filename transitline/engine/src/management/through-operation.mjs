import { VEHICLE_MODELS } from "./rolling-stock.mjs";
import { calculateThroughFareSettlement, THROUGH_FARE_AGREEMENT_SCHEMA } from "./through-fare.mjs";

export const THROUGH_OPERATING_SETTLEMENT_SCHEMA = "transitline.through-operating-settlement/1";

const money = (value) => Math.round(Number(value) || 0);

function nonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative finite number`);
  return number;
}

function accessUsageSettlement(throughService, trackAccessAgreements, usage, totalTrainKm) {
  const linkedIds = [...new Set(throughService.trackAccessAgreementIds ?? [])].sort();
  const rows = Array.isArray(usage) ? usage : [];
  if (new Set(rows.map((entry) => entry.agreementId)).size !== rows.length) throw new Error("Track access usage repeats an agreement");
  const suppliedIds = [...rows.map((entry) => String(entry.agreementId)).sort()];
  if (JSON.stringify(suppliedIds) !== JSON.stringify(linkedIds)) throw new Error("Track access usage must cover every linked agreement exactly once");
  const settlements = rows.map((entry) => {
    const agreement = trackAccessAgreements.find((candidate) => candidate.id === entry.agreementId);
    if (!agreement) throw new Error(`Unknown linked track access agreement ${entry.agreementId}`);
    if (agreement.status !== "active") throw new Error(`Track access agreement ${agreement.id} is not active`);
    if (agreement.guestOperatorId !== throughService.operatorId) throw new Error(`Track access agreement ${agreement.id} has another guest operator`);
    const trainKm = nonNegative(entry.trainKm, `Track access train-km for ${agreement.id}`);
    const stationStops = nonNegative(entry.stationStops, `Track access station stops for ${agreement.id}`);
    if (!Number.isSafeInteger(stationStops)) throw new Error(`Track access station stops for ${agreement.id} must be an integer`);
    const accessCostJPY = money(trainKm * agreement.accessFeeJPYPerTrainKm + stationStops * agreement.stationFeeJPYPerStop);
    return { agreementId: agreement.id, infrastructureOwnerId: agreement.infrastructureOwnerId, trainKm, stationStops, accessCostJPY };
  }).sort((a, b) => a.agreementId.localeCompare(b.agreementId));
  if (settlements.reduce((sum, entry) => sum + entry.trainKm, 0) > totalTrainKm + 1e-6) throw new Error("Track access train-km cannot exceed total through-service train-km");
  return settlements;
}

export function calculateThroughOperatingSettlement({
  throughService,
  fareAgreement,
  trackAccessAgreements = [],
  actuals,
  playerOperatorId = "player",
} = {}) {
  if (throughService?.schema !== "transitline.through-service/1" || throughService.contractVersion !== 1) throw new Error("ThroughService v1 is required");
  if (throughService.status !== "approved") throw new Error("Through operating settlement requires an approved service");
  if (fareAgreement?.schema !== THROUGH_FARE_AGREEMENT_SCHEMA || fareAgreement.throughServiceId !== throughService.throughServiceId) throw new Error("Matching ThroughFareAgreement v1 is required");
  if (throughService.operatorId !== playerOperatorId) throw new Error("Player operating settlement requires the player to be the train operator");
  const operatingDay = Number(actuals?.operatingDay);
  if (!Number.isSafeInteger(operatingDay) || operatingDay < 0) throw new Error("Operating day must be a non-negative integer");
  const passengers = Number(actuals?.passengers);
  if (!Number.isSafeInteger(passengers) || passengers < 0) throw new Error("Passengers must be a non-negative integer");
  const trainKm = nonNegative(actuals?.trainKm, "Train-km");
  const electricityYenPerKwh = nonNegative(actuals?.electricityYenPerKwh ?? 25, "Electricity price");
  const staffCostPerTrainKm = nonNegative(actuals?.staffCostPerTrainKm ?? 1_800, "Staff cost per train-km");
  const maintenanceYenPerCarKm = nonNegative(actuals?.maintenanceYenPerCarKm ?? 35, "Maintenance cost per car-km");
  const otherOperatingCostJPY = money(nonNegative(actuals?.otherOperatingCostJPY ?? 0, "Other operating cost"));
  const model = VEHICLE_MODELS[throughService.guestModelId];
  if (!model) throw new Error(`Unknown through-service vehicle model ${throughService.guestModelId}`);
  const fare = calculateThroughFareSettlement(fareAgreement, {
    passengers,
    settlementId: `through-fare-settlement:${throughService.throughServiceId}:${operatingDay}`,
  });
  const playerAllocation = fare.allocations.find((entry) => entry.operatorId === playerOperatorId);
  if (!playerAllocation) throw new Error("Active through fare agreement has no player allocation");
  const access = accessUsageSettlement(throughService, trackAccessAgreements, actuals?.trackAccessUsage, trainKm);
  const carKm = trainKm * model.cars;
  const energyKwh = carKm * model.energyKwhPerCarKm;
  const energyCostJPY = money(energyKwh * electricityYenPerKwh);
  const staffCostJPY = money(trainKm * staffCostPerTrainKm);
  const vehicleMaintenanceJPY = money(carKm * maintenanceYenPerCarKm);
  const trackAccessCostJPY = access.reduce((sum, entry) => sum + entry.accessCostJPY, 0);
  const playerFareRevenueJPY = playerAllocation.netRevenueJPY;
  const externalFareAllocationJPY = fare.passengerRevenueJPY - playerFareRevenueJPY;
  const operatingCostJPY = energyCostJPY + staffCostJPY + vehicleMaintenanceJPY + trackAccessCostJPY + otherOperatingCostJPY;
  return {
    schema: THROUGH_OPERATING_SETTLEMENT_SCHEMA,
    contractVersion: 1,
    settlementId: `through-operation:${throughService.throughServiceId}:${operatingDay}`,
    throughServiceId: throughService.throughServiceId,
    fareAgreementId: fareAgreement.id,
    settledAtMinute: Number.isFinite(actuals?.settledAtMinute) ? Number(actuals.settledAtMinute) : null,
    operatingDay,
    passengers,
    trainKm,
    carKm,
    energyKwh,
    passengerRevenueJPY: fare.passengerRevenueJPY,
    playerFareRevenueJPY,
    externalFareAllocationJPY,
    fareAllocations: fare.allocations,
    trackAccessUsage: access,
    money: {
      playerFareRevenueJPY,
      energyJPY: energyCostJPY,
      staffJPY: staffCostJPY,
      vehicleMaintenanceJPY,
      trackAccessCostJPY,
      otherOperatingCostJPY,
      operatingCostJPY,
      operatingProfitJPY: playerFareRevenueJPY - operatingCostJPY,
    },
    assumptions: { electricityYenPerKwh, staffCostPerTrainKm, maintenanceYenPerCarKm },
  };
}
