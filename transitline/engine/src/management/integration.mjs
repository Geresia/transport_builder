import {
  addLine,
  addPhysicalStation,
  addPlatform,
  addStationAccessLink,
  addTrackSegment,
  deleteLine,
  setLineSuspended,
} from "../state.mjs";
import { VEHICLE_MODELS } from "./rolling-stock.mjs";
import { applyVehicleOperatingWear } from "./operating-economy.mjs";
import { dispatchVehicleFleet, reliabilityPunctualityPenalty } from "./service-reliability.mjs";
import { electricityPriceForPeriod, staffingPunctualityAdjustment } from "./service-policy.mjs";
import { railwayTrafficForDays } from "../railway-traffic-control.mjs";

function orderedStationSourceIds(plan) {
  const adjacency = new Map(plan.stationCandidates.map((station) => [station.id, []]));
  for (const segment of plan.segments) {
    adjacency.get(segment.from)?.push(segment.to);
    adjacency.get(segment.to)?.push(segment.from);
  }
  const visited = new Set();
  const stack = [plan.stationCandidates[0]?.id];
  while (stack.length) {
    const id = stack.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  if (visited.size !== plan.stationCandidates.length) throw new Error("Plan stations and segments must form one connected route");
  if ([...adjacency.values()].some((neighbors) => neighbors.length > 2)) throw new Error("Basic service commissioning does not support branched track plans");
  const endpoints = [...adjacency].filter(([, neighbors]) => neighbors.length === 1).map(([id]) => id);
  if (endpoints.length !== 2) throw new Error("Basic service commissioning requires a route with two termini");
  const ordered = [];
  let previous = null;
  let current = endpoints[0];
  while (current) {
    ordered.push(current);
    const next = (adjacency.get(current) ?? []).find((id) => id !== previous);
    previous = current;
    current = next;
  }
  return ordered;
}

function operationalCheckpoint(state) {
  return {
    stations: new Map(state.stations),
    platforms: structuredClone(state.platforms ?? []),
    trackSegments: structuredClone(state.trackSegments ?? []),
    accessLinks: structuredClone(state.accessLinks ?? []),
    accessVersion: state.accessVersion ?? 0,
    lines: structuredClone(state.lines),
    nextLineId: state.nextLineId,
    networkDirty: state.networkDirty,
  };
}

function restoreOperational(state, checkpoint) {
  state.stations = checkpoint.stations;
  state.platforms = checkpoint.platforms;
  state.trackSegments = checkpoint.trackSegments;
  state.accessLinks = checkpoint.accessLinks;
  state.accessVersion = checkpoint.accessVersion;
  state.lines = checkpoint.lines;
  state.nextLineId = checkpoint.nextLineId;
  state.networkDirty = checkpoint.networkDirty;
}

export function commissionProject(game, operationalState, input) {
  const managementBefore = game.snapshot();
  const operationalBefore = operationalCheckpoint(operationalState);
  try {
    const project = game.requireProject(input.projectId);
    if (project.status !== "available") throw new Error(`Project ${project.id} infrastructure is not available`);
    if (project.commissionedLineId !== undefined) throw new Error(`Project ${project.id} is already commissioned`);
    const service = input.serviceId ? game.services.find((item) => item.id === input.serviceId) : null;
    if (input.serviceId && (!service || service.status !== "open" || service.projectId !== project.id)) throw new Error("An open service belonging to the project is required");
    const stationAssets = project.assets.filter((asset) => asset.kind === "station");
    const platformAssets = project.assets.filter((asset) => asset.kind === "platform");
    const trackAssets = project.assets.filter((asset) => asset.kind === "track-segment");
    if (!stationAssets.length || !trackAssets.length) throw new Error("Project has no physical station or track assets");
    for (const asset of stationAssets) addPhysicalStation(operationalState, {
      id: asset.id,
      name: asset.name,
      location: asset.location,
      structure: asset.structure,
      depthMeters: asset.depthMeters,
      projectId: project.id,
      sourceStationId: asset.sourceId,
    });
    for (const asset of platformAssets) addPlatform(operationalState, {
      id: asset.id,
      stationId: asset.stationAssetId,
      platformType: asset.platformType,
      lengthMeters: asset.lengthMeters,
      projectId: project.id,
    });
    for (const asset of trackAssets) addTrackSegment(operationalState, {
      id: asset.id,
      fromStationId: asset.fromStationAssetId,
      toStationId: asset.toStationAssetId,
      lengthMeters: asset.lengthMeters,
      structure: asset.structure,
      projectId: project.id,
    });
    const stationAssetBySource = new Map(stationAssets.map((asset) => [asset.sourceId, asset.id]));
    for (const link of project.planGeometry.accessLinks ?? []) {
      const sourceStationId = link.stationCandidateId ?? link.stationId;
      const stationId = stationAssetBySource.get(sourceStationId);
      if (!stationId) throw new Error(`Access link references unknown station candidate ${sourceStationId}`);
      addStationAccessLink(operationalState, { id: link.id, demandNodeId: link.demandNodeId, stationId, walkMinutes: link.walkMinutes });
    }
    const orderedStations = orderedStationSourceIds(project.planGeometry).map((id) => stationAssetBySource.get(id));
    const model = service ? VEHICLE_MODELS[service.modelId] : null;
    const line = addLine(operationalState, orderedStations, {
      name: input.lineName ?? service?.name ?? project.planGeometry.name ?? project.planId,
      color: input.color,
      carsPerTrain: model?.cars,
      frequency: input.frequency,
    });
    line.projectId = project.id;
    line.managementServiceId = service?.id ?? null;
    line.trackSegmentIds = trackAssets.map((asset) => asset.id);
    line.owned = true;
    project.commissionedLineId = line.id;
    project.commissionedAt = game.clock.minute;
    if (service) service.operationalLineId = line.id;
    const planRecord = game.plans.find((record) => record.id === project.planRecordId);
    if (planRecord) planRecord.status = "commissioned";
    game.events.record(game.clock.minute, "project-commissioned", { projectId: project.id, serviceId: service?.id ?? null, lineId: line.id });
    return { line, stationIds: orderedStations, trackSegmentIds: line.trackSegmentIds };
  } catch (error) {
    game.restore(managementBefore);
    restoreOperational(operationalState, operationalBefore);
    throw error;
  }
}

export function suspendCommissionedService(game, operationalState, serviceId, suspended = true) {
  const service = game.services.find((item) => item.id === serviceId);
  if (!service || service.operationalLineId === undefined) throw new Error(`Service ${serviceId} is not commissioned`);
  if (!setLineSuspended(operationalState, service.operationalLineId, suspended)) return false;
  service.status = suspended ? "suspended" : "open";
  game.events.record(game.clock.minute, suspended ? "service-suspended" : "service-resumed", { serviceId, lineId: service.operationalLineId });
  return true;
}

export function decommissionService(game, operationalState, serviceId) {
  const service = game.services.find((item) => item.id === serviceId);
  if (!service || service.operationalLineId === undefined) throw new Error(`Service ${serviceId} is not commissioned`);
  const lineId = service.operationalLineId;
  deleteLine(operationalState, lineId);
  service.status = "decommissioned";
  service.decommissionedAt = game.clock.minute;
  delete service.operationalLineId;
  game.events.record(game.clock.minute, "service-decommissioned", { serviceId, lineId });
  return true;
}

export function settleIntegratedServiceDay(game, operationalState, serviceId) {
  const serviceBefore = game.services.find((item) => item.id === serviceId);
  const lineBefore = serviceBefore?.operationalLineId === undefined
    ? null
    : operationalState.lines.find((entry) => String(entry.id) === String(serviceBefore.operationalLineId));
  const frequencyBefore = lineBefore ? structuredClone(lineBefore.frequency) : null;
  try {
    return game.transact("integrated-service-day-settled", () => {
    const service = game.services.find((item) => item.id === serviceId);
    if (!service || service.status !== "open" || service.operationalLineId === undefined) throw new Error(`Service ${serviceId} is not operating on the network`);
    const lineId = String(service.operationalLineId);
    const simulationDay = Math.floor(operationalState.simMinutes / 1440);
    const operatingDay = Math.floor(game.clock.minute / 1440);
    const cursor = service.engineCursor ?? { day: simulationDay - 1, delivered: 0, trainKm: 0 };
    if (simulationDay <= cursor.day) throw new Error(`Service ${serviceId} day ${simulationDay} is already settled`);
    const deliveredNow = operationalState.stats.deliveredByLine?.[lineId] ?? 0;
    const trainKmNow = operationalState.stats.trainKmByLine?.[lineId] ?? 0;
    const trafficNow = operationalState.stats.railwayTrafficByLine?.[lineId] ?? {};
    const legacyTraffic = {
      dispatchedTrains: Math.max(0, (trafficNow.dispatchedTrains ?? 0) - (cursor.dispatchedTrains ?? 0)),
      completedTrains: Math.max(0, (trafficNow.completedTrains ?? 0) - (cursor.completedTrains ?? 0)),
      scheduledDispatchedTrains: Math.max(0, (trafficNow.scheduledDispatchedTrains ?? 0) - (cursor.scheduledDispatchedTrains ?? 0)),
      unscheduledDispatchedTrains: Math.max(0, (trafficNow.unscheduledDispatchedTrains ?? 0) - (cursor.unscheduledDispatchedTrains ?? 0)),
      scheduledCompletedTrains: Math.max(0, (trafficNow.scheduledCompletedTrains ?? 0) - (cursor.scheduledCompletedTrains ?? 0)),
      onTimeTrains: Math.max(0, (trafficNow.onTimeTrains ?? 0) - (cursor.onTimeTrains ?? 0)),
      missedDepartures: Math.max(0, (trafficNow.missedDepartures ?? 0) - (cursor.missedDepartures ?? 0)),
      departureDelaySeconds: Math.max(0, (trafficNow.departureDelaySeconds ?? 0) - (cursor.departureDelaySeconds ?? 0)),
      signalDelaySeconds: Math.max(0, (trafficNow.signalDelaySeconds ?? 0) - (cursor.signalDelaySeconds ?? 0)),
      junctionDelaySeconds: Math.max(0, (trafficNow.junctionDelaySeconds ?? 0) - (cursor.junctionDelaySeconds ?? 0)),
      terminalDelaySeconds: Math.max(0, (trafficNow.terminalDelaySeconds ?? 0) - (cursor.terminalDelaySeconds ?? 0)),
      disruptionDelaySeconds: Math.max(0, (trafficNow.disruptionDelaySeconds ?? 0) - (cursor.disruptionDelaySeconds ?? 0)),
      arrivalDelaySeconds: Math.max(0, (trafficNow.arrivalDelaySeconds ?? 0) - (cursor.arrivalDelaySeconds ?? 0)),
      lateCompletedTrains: Math.max(0, (trafficNow.lateCompletedTrains ?? 0) - (cursor.lateCompletedTrains ?? 0)),
      lateArrivalDelaySeconds: Math.max(0, (trafficNow.lateArrivalDelaySeconds ?? 0) - (cursor.lateArrivalDelaySeconds ?? 0)),
    };
    const traffic = railwayTrafficForDays(operationalState, lineId, cursor.day, simulationDay) ?? legacyTraffic;
    const scheduledObligations = traffic.scheduledDispatchedTrains + traffic.missedDepartures;
    traffic.completionOnTimeRatio = traffic.scheduledCompletedTrains ? traffic.onTimeTrains / traffic.scheduledCompletedTrains : null;
    traffic.serviceDeliveryRatio = scheduledObligations ? traffic.onTimeTrains / scheduledObligations : null;
    const deliveredAgents = Math.max(0, deliveredNow - cursor.delivered);
    const trainKm = Math.max(0, trainKmNow - cursor.trainKm);
    const days = simulationDay - cursor.day;
    const passengerWeight = service.passengerWeight ?? 100;
    const passengers = deliveredAgents * passengerWeight;
    const model = VEHICLE_MODELS[service.modelId];
    const fareRevenue = passengers * service.averageFare;
    const carKm = trainKm * model.cars;
    const electricityYenPerKwh = electricityPriceForPeriod(service, game.rng);
    const energyCost = carKm * model.energyKwhPerCarKm * electricityYenPerKwh;
    const maintenanceCost = carKm * service.maintenanceYenPerCarKm;
    const staffCost = trainKm * (service.staffCostPerTrainKm ?? 1_800);
    const fixedCost = days * service.dailyInfrastructureCost;
    const resources = game.resolveOperatingResources(serviceId);
    const depot = resources.depot;
    const accessImpact = game.trackAccessImpact(serviceId);
    const accessSettlement = game.settleTrackAccessForService(serviceId, operatingDay - 1, days);
    const infrastructureMaintenance = game.infrastructureMaintenanceImpact(service.projectId);
    const possessionImpact = game.throughHandoverPossessionImpact(service.id);
    const infrastructureSets = Math.max(0, Math.floor(service.fleetRequirement.serviceSets * infrastructureMaintenance.capacityFactor * possessionImpact.capacityFactor));
    const requiredSets = Math.min(infrastructureSets, resources.maximumStaffedSets ?? infrastructureSets);
    const reliability = dispatchVehicleFleet({
      units: resources.units,
      modelId: service.modelId,
      requiredSets,
      days,
      rng: game.rng,
      ledger: game.ledger,
      clock: game.clock,
      serviceId: service.id,
      preferredUnitIds: resources.preferredUnitIds,
      operatingDay: simulationDay,
    });
    const scheduledSets = reliability.operatingSets;
    const modelPunctuality = Math.max(0.5, Math.min(0.999, 0.985 - reliabilityPunctualityPenalty(reliability) - infrastructureMaintenance.punctualityPenalty - possessionImpact.punctualityPenalty - accessImpact.punctualityPenalty + staffingPunctualityAdjustment(service)));
    const punctuality = traffic.serviceDeliveryRatio === null ? modelPunctuality : Math.max(0.5, Math.min(modelPunctuality, traffic.serviceDeliveryRatio));
    const line = operationalState.lines.find((entry) => String(entry.id) === lineId);
    if (line) {
      service.nominalLineFrequency ??= structuredClone(line.frequency);
      const availabilityRatio = scheduledSets / Math.max(1, service.fleetRequirement.serviceSets);
      for (const [bandId, nominal] of Object.entries(service.nominalLineFrequency)) {
        line.frequency[bandId] = Math.max(0, Math.floor(nominal * availabilityRatio));
      }
    }
    const deadheadCost = depot.assessment?.economics?.deadhead
      ? depot.assessment.economics.deadhead.totalAnnualCost / 365 * days
      : scheduledSets * depot.deadheadKm * 2 * service.deadheadYenPerSetKm * days;
    const depotCost = depot.annualLeaseCost / 365 * days;
    const contract = game.contracts.find((item) => item.id === service.contractId);
    const basePublicPayment = contract ? contract.annualPayment / 365 * days : service.dailyPublicPayment * days;
    const target = contract?.kpi?.punctualityTarget ?? 0.97;
    const maxDeductionRate = contract?.kpi?.maxDeductionRate ?? 0.1;
    const kpiAdjustment = punctuality >= target
      ? basePublicPayment * (contract?.kpi?.bonusRate ?? 0.01)
      : -basePublicPayment * Math.min(maxDeductionRate, (target - punctuality) * 2);
    const publicPayment = basePublicPayment + kpiAdjustment;
    const advertising = service.dailyAdvertisingRevenue * days;
    const ancillaryRevenue = (depot.annualAncillaryRevenue ?? 0) / 365 * days;
    const trackAccessRevenueJPY = accessSettlement.accessRevenueJPY ?? 0;
    const trackAccessCostJPY = accessSettlement.accessCostJPY ?? 0;
    const income = fareRevenue + publicPayment + advertising + ancillaryRevenue + trackAccessRevenueJPY;
    const cost = energyCost + maintenanceCost + staffCost + fixedCost + deadheadCost + depotCost + trackAccessCostJPY;
    if (income > 0) game.ledger.post({ atMinute: game.clock.minute, amount: income, category: "integrated-operating-income", reference: service.id });
    if (cost > 0) game.ledger.post({ atMinute: game.clock.minute, amount: -cost, category: "integrated-operating-cost", reference: service.id });
    const vehicle = applyVehicleOperatingWear({ units: resources.units, modelId: service.modelId, trainKm, days, depot, ledger: game.ledger, clock: game.clock, maxUsedSets: scheduledSets, usedUnitIds: reliability.operatingUnitIds });
    service.engineCursor = {
      day: simulationDay,
      delivered: deliveredNow,
      trainKm: trainKmNow,
      dispatchedTrains: trafficNow.dispatchedTrains ?? 0,
      completedTrains: trafficNow.completedTrains ?? 0,
      scheduledDispatchedTrains: trafficNow.scheduledDispatchedTrains ?? 0,
      unscheduledDispatchedTrains: trafficNow.unscheduledDispatchedTrains ?? 0,
      scheduledCompletedTrains: trafficNow.scheduledCompletedTrains ?? 0,
      onTimeTrains: trafficNow.onTimeTrains ?? 0,
      missedDepartures: trafficNow.missedDepartures ?? 0,
      departureDelaySeconds: trafficNow.departureDelaySeconds ?? 0,
      signalDelaySeconds: trafficNow.signalDelaySeconds ?? 0,
      junctionDelaySeconds: trafficNow.junctionDelaySeconds ?? 0,
      terminalDelaySeconds: trafficNow.terminalDelaySeconds ?? 0,
      disruptionDelaySeconds: trafficNow.disruptionDelaySeconds ?? 0,
      arrivalDelaySeconds: trafficNow.arrivalDelaySeconds ?? 0,
      lateCompletedTrains: trafficNow.lateCompletedTrains ?? 0,
      lateArrivalDelaySeconds: trafficNow.lateArrivalDelaySeconds ?? 0,
    };
    service.integratedTotals = service.integratedTotals ?? { passengers: 0, trainKm: 0, income: 0, cost: 0 };
    service.integratedTotals.passengers += passengers;
    service.integratedTotals.trainKm += trainKm;
    service.integratedTotals.income += income;
    service.integratedTotals.cost += cost + vehicle.inspectionCostJPY + reliability.repairCostJPY;
    service.daysOperated = (service.daysOperated ?? 0) + days;
    const maintenanceProgress = game.advanceInfrastructureMaintenanceToCurrentDay();
    const settlement = {
      day: simulationDay,
      operatingDay,
      days,
      passengers,
      denied: 0,
      punctuality,
      electricityYenPerKwh,
      trainKm,
      income,
      cost: cost + vehicle.inspectionCostJPY + reliability.repairCostJPY,
      profit: income - cost - vehicle.inspectionCostJPY - reliability.repairCostJPY,
      money: {
        fareRevenueJPY: fareRevenue,
        publicPaymentJPY: publicPayment,
        advertisingJPY: advertising,
        ancillaryRevenueJPY: ancillaryRevenue,
        trackAccessRevenueJPY,
        energyJPY: energyCost,
        staffJPY: staffCost,
        vehicleMaintenanceJPY: maintenanceCost,
        vehicleInspectionJPY: vehicle.inspectionCostJPY,
        vehicleRepairJPY: reliability.repairCostJPY,
        deadheadJPY: deadheadCost,
        infrastructureJPY: fixedCost,
        depotJPY: depotCost,
        trackAccessCostJPY,
      },
      vehicle,
      reliability,
      railwayTraffic: traffic,
      resourcePoolId: resources.poolId,
      resourceWarnings: resources.warnings,
      throughHandoverPossession: possessionImpact,
      trackAccess: { impact: accessImpact, settlement: accessSettlement },
      infrastructureMaintenance,
      maintenanceProgress,
    };
    return { ...settlement, ...game.applyOperatingSettlement(service, settlement) };
    });
  } catch (error) {
    if (lineBefore && frequencyBefore) lineBefore.frequency = frequencyBefore;
    throw error;
  }
}
