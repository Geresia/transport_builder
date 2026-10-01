export const OPERATING_RESOURCE_POOL_SCHEMA = "transitline.operating-resource-pool/1";

const clone = (value) => structuredClone(value);
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

function uniqueIds(values, label) {
  const ids = [...new Set((values ?? []).map(String))];
  if (!ids.length) throw new Error(`Operating resource pool requires at least one ${label}`);
  return ids;
}

function servicePriority(a, b) {
  return (b.priority ?? 0) - (a.priority ?? 0) || String(a.serviceId).localeCompare(String(b.serviceId));
}

function poolUnits(pool, vehicleOrders) {
  const orderIds = new Set(pool.vehicleOrderIds);
  return vehicleOrders.filter((order) => orderIds.has(order.id)).flatMap((order) => order.units ?? []).sort(byId);
}

function poolDepots(pool, depots) {
  const depotIds = new Set(pool.depotIds);
  return depots.filter((depot) => depotIds.has(depot.id));
}

export function createOperatingResourcePool(input, { vehicleOrders = [], depots = [] } = {}) {
  if (!input?.id) throw new Error("Operating resource pool requires an id");
  const vehicleOrderIds = uniqueIds(input.vehicleOrderIds, "vehicle order");
  const depotIds = uniqueIds(input.depotIds, "depot");
  for (const id of vehicleOrderIds) if (!vehicleOrders.some((order) => order.id === id)) throw new Error(`Unknown vehicle order ${id}`);
  for (const id of depotIds) if (!depots.some((depot) => depot.id === id)) throw new Error(`Unknown depot ${id}`);
  const totalStaffConcurrent = Number(input.totalStaffConcurrent);
  if (!Number.isFinite(totalStaffConcurrent) || totalStaffConcurrent < 0) throw new Error("Pool concurrent staff must be a non-negative number");
  return {
    schema: OPERATING_RESOURCE_POOL_SCHEMA,
    contractVersion: 1,
    id: String(input.id),
    name: input.name ?? String(input.id),
    vehicleOrderIds,
    depotIds,
    totalStaffConcurrent,
    assignments: [],
    sharedReserveUnitIds: [],
    revision: 0,
  };
}

export function assignServiceToOperatingResourcePool(pool, service, options = {}, context = {}) {
  if (!pool || pool.schema !== OPERATING_RESOURCE_POOL_SCHEMA) throw new Error("Invalid operating resource pool");
  if (!service?.id) throw new Error("Resource pool assignment requires a service");
  const depots = poolDepots(pool, context.depots ?? []);
  const homeDepotId = options.homeDepotId ?? service.depotId ?? depots[0]?.id;
  if (!pool.depotIds.includes(homeDepotId)) throw new Error(`Depot ${homeDepotId} is not part of pool ${pool.id}`);
  const compatibleOrders = (context.vehicleOrders ?? []).filter((order) => pool.vehicleOrderIds.includes(order.id) && order.modelId === service.modelId);
  if (!compatibleOrders.length) throw new Error(`Pool ${pool.id} has no ${service.modelId} vehicles for service ${service.id}`);
  const existing = pool.assignments.find((entry) => entry.serviceId === service.id);
  const assignment = existing ?? { serviceId: service.id, primaryUnitIds: [] };
  assignment.priority = Number.isFinite(options.priority) ? Number(options.priority) : (existing?.priority ?? 0);
  assignment.homeDepotId = homeDepotId;
  if (!existing) pool.assignments.push(assignment);
  service.resourcePoolId = pool.id;
  return rebalanceOperatingResourcePool(pool, context);
}

export function removeServiceFromOperatingResourcePool(pool, serviceId, services = []) {
  const index = pool.assignments.findIndex((entry) => entry.serviceId === serviceId);
  if (index < 0) return false;
  pool.assignments.splice(index, 1);
  const service = services.find((entry) => entry.id === serviceId);
  if (service?.resourcePoolId === pool.id) delete service.resourcePoolId;
  return true;
}

export function rebalanceOperatingResourcePool(pool, { services = [], vehicleOrders = [], depots = [] } = {}) {
  const previousState = JSON.stringify({ assignments: pool.assignments, sharedReserveUnitIds: pool.sharedReserveUnitIds, capacity: pool.capacity });
  const units = poolUnits(pool, vehicleOrders);
  const claimed = new Set();
  const ordered = pool.assignments
    .filter((assignment) => services.some((service) => service.id === assignment.serviceId))
    .sort(servicePriority);
  pool.assignments = ordered;
  let staffRemaining = pool.totalStaffConcurrent;

  for (const assignment of ordered) {
    const service = services.find((entry) => entry.id === assignment.serviceId);
    const target = Math.max(0, Math.floor(service.fleetRequirement?.serviceSets ?? 0));
    const compatible = units.filter((unit) => unit.modelId === service.modelId);
    const preserved = (assignment.primaryUnitIds ?? [])
      .map((id) => compatible.find((unit) => unit.id === id))
      .filter((unit) => unit && !claimed.has(unit.id));
    const available = compatible.filter((unit) => !claimed.has(unit.id) && !preserved.some((entry) => entry.id === unit.id));
    const primary = [...preserved, ...available].slice(0, target);
    for (const unit of primary) claimed.add(unit.id);
    const staffRequired = target * Math.max(0, Number(service.staffPerSet) || 0);
    const staffAssigned = Math.min(staffRequired, staffRemaining);
    staffRemaining = Math.max(0, staffRemaining - staffAssigned);
    assignment.primaryUnitIds = primary.map((unit) => unit.id);
    assignment.requestedPrimarySets = target;
    assignment.staffRequired = staffRequired;
    assignment.staffAssigned = staffAssigned;
    assignment.maximumStaffedSets = service.staffPerSet > 0 ? Math.floor(staffAssigned / service.staffPerSet) : target;
    assignment.shortfalls = [
      primary.length < target ? "primary-fleet-shortfall" : null,
      staffAssigned < staffRequired ? "staff-shortfall" : null,
    ].filter(Boolean);
    assignment.status = assignment.shortfalls.length ? "constrained" : "ready";
  }

  pool.sharedReserveUnitIds = units.filter((unit) => !claimed.has(unit.id)).map((unit) => unit.id);
  const depotList = poolDepots(pool, depots);
  const totalDepotCapacitySets = depotList.reduce((sum, depot) => sum + (Number(depot.capacitySets) || 0), 0);
  const totalInspectionSetsPerDay = depotList.reduce((sum, depot) => sum + (Number(depot.inspectionSetsPerDay) || 0), 0);
  pool.capacity = {
    totalVehicleSets: units.length,
    assignedPrimarySets: claimed.size,
    sharedReserveSets: pool.sharedReserveUnitIds.length,
    totalStaffConcurrent: pool.totalStaffConcurrent,
    assignedStaffConcurrent: pool.totalStaffConcurrent - staffRemaining,
    totalDepotCapacitySets,
    totalInspectionSetsPerDay,
    depotStorageShortfallSets: Math.max(0, units.length - totalDepotCapacitySets),
  };
  const nextState = JSON.stringify({ assignments: pool.assignments, sharedReserveUnitIds: pool.sharedReserveUnitIds, capacity: pool.capacity });
  if (nextState !== previousState) pool.revision = (pool.revision ?? 0) + 1;
  return clone(pool);
}

export function operatingResourcePoolReport(pool, context = {}) {
  const working = clone(pool);
  rebalanceOperatingResourcePool(working, context);
  const units = poolUnits(working, context.vehicleOrders ?? []);
  const unavailable = units.filter((unit) => unit.status !== "available");
  return {
    schema: OPERATING_RESOURCE_POOL_SCHEMA,
    contractVersion: 1,
    id: working.id,
    name: working.name,
    revision: working.revision,
    capacity: clone(working.capacity),
    vehicleOrderIds: [...working.vehicleOrderIds],
    depotIds: [...working.depotIds],
    assignments: clone(working.assignments),
    sharedReserveUnitIds: [...working.sharedReserveUnitIds],
    availableSharedReserveUnitIds: working.sharedReserveUnitIds.filter((id) => units.find((unit) => unit.id === id)?.status === "available"),
    unavailableUnitIds: unavailable.map((unit) => unit.id),
    warnings: [
      working.capacity.depotStorageShortfallSets > 0 ? "depot-storage-shortfall" : null,
      working.assignments.some((entry) => entry.shortfalls.includes("staff-shortfall")) ? "staff-shortfall" : null,
      working.assignments.some((entry) => entry.shortfalls.includes("primary-fleet-shortfall")) ? "primary-fleet-shortfall" : null,
    ].filter(Boolean),
  };
}

export function resolveOperatingResourcePoolService(pool, service, { services = [], vehicleOrders = [], depots = [] } = {}) {
  const working = clone(pool);
  rebalanceOperatingResourcePool(working, { services, vehicleOrders, depots });
  const assignment = working.assignments.find((entry) => entry.serviceId === service.id);
  if (!assignment) throw new Error(`Service ${service.id} is not assigned to pool ${working.id}`);
  const allUnits = poolUnits(working, vehicleOrders);
  const eligibleIds = new Set([...assignment.primaryUnitIds, ...working.sharedReserveUnitIds]);
  const units = allUnits.filter((unit) => eligibleIds.has(unit.id) && unit.modelId === service.modelId);
  const depotList = poolDepots(working, depots);
  const homeDepot = depotList.find((depot) => depot.id === assignment.homeDepotId) ?? depotList[0];
  if (!homeDepot) throw new Error(`Pool ${working.id} has no usable depot`);
  const requestedTotal = working.assignments.reduce((sum, entry) => sum + Math.max(0, entry.requestedPrimarySets ?? 0), 0);
  const share = requestedTotal > 0 ? assignment.requestedPrimarySets / requestedTotal : 1 / Math.max(1, working.assignments.length);
  const inspectionTotal = depotList.reduce((sum, depot) => sum + (Number(depot.inspectionSetsPerDay) || 0), 0);
  const virtualDepot = {
    ...clone(homeDepot),
    id: `${working.id}:${service.id}:shared-depot`,
    name: `${working.name} / ${homeDepot.name}`,
    capacitySets: units.length,
    inspectionSetsPerDay: Math.max(0, Math.floor(inspectionTotal * share)),
    annualLeaseCost: depotList.reduce((sum, depot) => sum + (Number(depot.annualLeaseCost) || 0), 0) * share,
    annualAncillaryRevenue: depotList.reduce((sum, depot) => sum + (Number(depot.annualAncillaryRevenue) || 0), 0) * share,
    sharedPoolId: working.id,
  };
  return {
    poolId: working.id,
    assignment: clone(assignment),
    units,
    depot: virtualDepot,
    preferredUnitIds: [...assignment.primaryUnitIds],
    maximumStaffedSets: assignment.maximumStaffedSets,
    warnings: [...assignment.shortfalls, ...(working.capacity.depotStorageShortfallSets > 0 ? ["depot-storage-shortfall"] : [])],
  };
}
