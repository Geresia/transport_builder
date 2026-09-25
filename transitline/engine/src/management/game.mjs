import { EventLog, Ledger, SimulationClock, decodeSave, encodeSave, makeRng } from "./core.mjs";
import { getCountryProfile } from "./country-profiles.mjs";
import { assessPlan, createConstructionProject, contractConstruction, advanceConstructionMonth, resumeConstruction, suspendConstruction } from "./construction.mjs";
import { createCompetitors, createOpportunity, evaluateTender, generateCompetitorBids, negotiateAward, researchOpportunity, submitPlayerBid } from "./procurement.mjs";
import { createDepot, createManufacturers, placeVehicleOrder, advanceVehicleOrderMonth } from "./rolling-stock.mjs";
import { calculateFleetRequirement, checkOpenReady, operateServiceDay } from "./operations.mjs";
import { createPlanRecord } from "./domain.mjs";

export class ManagementGame {
  constructor({ countryId = "JP", seed = 1, openingCash = 500_000_000_000, playerName = "Player Transit" } = {}) {
    this.country = getCountryProfile(countryId);
    this.clock = new SimulationClock(0);
    this.rng = makeRng(seed);
    this.ledger = new Ledger(openingCash);
    this.events = new EventLog();
    this.player = { id: "player", name: playerName, cash: openingCash, reputation: 72, operatingScore: 80, bidCapacity: 3, activeBids: 0, backlog: 0 };
    this.competitors = createCompetitors();
    this.manufacturers = createManufacturers();
    this.opportunities = [];
    this.contracts = [];
    this.projects = [];
    this.vehicleOrders = [];
    this.depots = [];
    this.services = [];
    this.plans = [];
  }

  snapshot() {
    return {
      countryId: this.country.id,
      clock: { minute: this.clock.minute, queue: structuredClone(this.clock.queue), nextEventId: this.clock.nextEventId },
      rngState: this.rng.snapshot(),
      ledger: { openingCash: this.ledger.openingCash, entries: structuredClone(this.ledger.entries), commitments: structuredClone([...this.ledger.commitments.values()]) },
      events: structuredClone(this.events.entries),
      player: structuredClone(this.player),
      competitors: structuredClone(this.competitors),
      manufacturers: structuredClone(this.manufacturers),
      opportunities: structuredClone(this.opportunities),
      contracts: structuredClone(this.contracts),
      projects: structuredClone(this.projects),
      vehicleOrders: structuredClone(this.vehicleOrders),
      depots: structuredClone(this.depots),
      services: structuredClone(this.services),
      plans: structuredClone(this.plans),
      scenario: structuredClone(this.scenario ?? null),
    };
  }

  restore(snapshot) {
    this.country = getCountryProfile(snapshot.countryId);
    this.clock = new SimulationClock(snapshot.clock.minute);
    this.clock.queue = structuredClone(snapshot.clock.queue);
    this.clock.nextEventId = snapshot.clock.nextEventId;
    this.rng = makeRng(snapshot.rngState, true);
    this.ledger = new Ledger(snapshot.ledger.openingCash, snapshot.ledger.entries, snapshot.ledger.commitments);
    this.events = new EventLog(snapshot.events);
    for (const key of ["player", "competitors", "manufacturers", "opportunities", "contracts", "projects", "vehicleOrders", "depots", "services", "plans"]) {
      this[key] = structuredClone(snapshot[key] ?? []);
    }
    this.scenario = structuredClone(snapshot.scenario ?? null);
    return this;
  }

  save() {
    return encodeSave(this.snapshot());
  }

  static load(text) {
    const snapshot = decodeSave(text);
    return new ManagementGame({ countryId: snapshot.countryId }).restore(snapshot);
  }

  transact(type, action) {
    const before = this.snapshot();
    try {
      const result = action();
      this.ledger.assertInvariant();
      this.player.cash = this.ledger.cash;
      this.events.record(this.clock.minute, type, result ?? {});
      return result;
    } catch (error) {
      this.restore(before);
      throw error;
    }
  }

  announceOpportunity(input) {
    return this.transact("opportunity-announced", () => {
      if (this.opportunities.some((item) => item.id === input.id)) throw new Error(`Duplicate opportunity ${input.id}`);
      const opportunity = createOpportunity(input);
      this.opportunities.push(opportunity);
      return opportunity;
    });
  }

  research(opportunityId, level) {
    return this.transact("opportunity-researched", () => researchOpportunity(this.requireOpportunity(opportunityId), this.ledger, this.clock, level));
  }

  bid(opportunityId, proposal) {
    return this.transact("bid-submitted", () => submitPlayerBid(this.requireOpportunity(opportunityId), this.player, this.ledger, this.clock, proposal));
  }

  closeTender(opportunityId) {
    return this.transact("tender-evaluated", () => {
      const opportunity = this.requireOpportunity(opportunityId);
      if (this.clock.minute < opportunity.deadlineMinute) this.clock.advance(opportunity.deadlineMinute - this.clock.minute);
      generateCompetitorBids(opportunity, this.competitors, this.rng);
      return evaluateTender(opportunity);
    });
  }

  award(opportunityId, bidderId, accepted = true) {
    return this.transact("tender-negotiated", () => {
      const opportunity = this.requireOpportunity(opportunityId);
      const contract = negotiateAward(opportunity, bidderId, accepted);
      if (contract) {
        this.contracts.push(contract);
        if (bidderId === this.player.id) this.ledger.release(`bond:${opportunity.id}`);
      }
      return contract;
    });
  }

  assess(plan, technicalProfileId) {
    return assessPlan(plan, technicalProfileId, this.country);
  }

  submitPlan(plan, technicalProfileId) {
    return this.transact("plan-submitted", () => {
      const assessment = this.assess(plan, technicalProfileId);
      const record = createPlanRecord(this.plans, plan, technicalProfileId, assessment, this.clock.minute);
      this.plans.push(record);
      return record;
    });
  }

  approvePlan(planRecordId) {
    return this.transact("plan-approved", () => {
      const record = this.requirePlan(planRecordId);
      if (record.status !== "assessed") throw new Error(`Plan ${planRecordId} is ${record.status}, not ready for approval`);
      const newer = this.plans.some((item) => item.planId === record.planId && item.version > record.version);
      if (newer) throw new Error(`Plan ${planRecordId} has a newer version`);
      record.status = "approved";
      record.approvedAt = this.clock.minute;
      return record;
    });
  }

  createProjectFromPlan(planRecordId) {
    return this.transact("project-created-from-plan", () => {
      const record = this.requirePlan(planRecordId);
      if (record.status !== "approved") throw new Error(`Plan ${planRecordId} must be approved before project creation`);
      if (this.projects.some((project) => project.planId === record.planId)) throw new Error(`Duplicate plan ${record.planId}`);
      const project = createConstructionProject({ ...record.geometry, version: record.version }, record.technicalProfileId, this.country);
      project.planRecordId = record.id;
      this.projects.push(project);
      record.status = "in-project";
      record.projectId = project.id;
      return project;
    });
  }

  createProject(plan, technicalProfileId) {
    return this.transact("project-created", () => {
      if (this.projects.some((project) => project.planId === plan.planId)) throw new Error(`Duplicate plan ${plan.planId}`);
      const project = createConstructionProject(plan, technicalProfileId, this.country);
      this.projects.push(project);
      return project;
    });
  }

  contractProject(projectId) {
    return this.transact("construction-contracted", () => {
      const project = this.requireProject(projectId);
      const deposit = contractConstruction(project, this.ledger, this.clock);
      return { projectId, deposit };
    });
  }

  suspendProject(projectId, reason) {
    return this.transact("construction-suspended", () => suspendConstruction(this.requireProject(projectId), reason, this.clock));
  }

  resumeProject(projectId) {
    return this.transact("construction-resumed", () => resumeConstruction(this.requireProject(projectId), this.clock));
  }

  addDepot(input) {
    return this.transact("depot-secured", () => {
      if (this.depots.some((depot) => depot.id === input.id)) throw new Error(`Duplicate depot ${input.id}`);
      const depot = createDepot(input);
      this.depots.push(depot);
      return depot;
    });
  }

  orderVehicles(input) {
    return this.transact("vehicles-ordered", () => {
      const manufacturer = this.manufacturers.find((item) => item.id === input.manufacturerId);
      if (!manufacturer) throw new Error(`Unknown manufacturer ${input.manufacturerId}`);
      const order = placeVehicleOrder({ ...input, manufacturer, ledger: this.ledger, clock: this.clock });
      this.vehicleOrders.push(order);
      return order;
    });
  }

  advanceMonth() {
    return this.transact("month-advanced", () => {
      this.clock.advance(30 * 1440);
      const construction = this.projects.filter((project) => ["contracted", "underConstruction", "inspection"].includes(project.status))
        .map((project) => ({ projectId: project.id, ...advanceConstructionMonth(project, this.ledger, this.clock, this.rng, this.country) }));
      for (const project of this.projects.filter((item) => item.status === "available" && item.planRecordId)) {
        const record = this.plans.find((item) => item.id === project.planRecordId);
        if (record && record.status === "in-project") record.status = "assets-available";
      }
      const vehicles = this.vehicleOrders.filter((order) => !["accepted", "cancelled"].includes(order.stage)).map((order) => {
        const manufacturer = this.manufacturers.find((item) => item.id === order.manufacturerId);
        return { orderId: order.id, ...advanceVehicleOrderMonth(order, manufacturer, this.ledger, this.clock, this.rng) };
      });
      return { construction, vehicles };
    });
  }

  createService(input) {
    return this.transact("service-created", () => {
      const project = this.requireProject(input.projectId);
      const depot = this.depots.find((item) => item.id === input.depotId);
      if (!depot) throw new Error(`Unknown depot ${input.depotId}`);
      const units = this.vehicleOrders.filter((order) => order.id === input.vehicleOrderId).flatMap((order) => order.units);
      const fleetRequirement = calculateFleetRequirement(input);
      const readiness = checkOpenReady({ project, units, depot, fleetRequirement, staffReady: input.staffReady, timetableReady: input.timetableReady, trialOperationPassed: input.trialOperationPassed, approvalsValid: input.approvalsValid, platformLengthM: input.platformLengthM });
      const service = {
        averageFare: 220,
        electricityYenPerKwh: 25,
        maintenanceYenPerCarKm: 65,
        staffPerSet: 2.5,
        dailyStaffCost: 42_000,
        deadheadYenPerSetKm: 1_100,
        dailyInfrastructureCost: 8_000_000,
        dailyPublicPayment: 0,
        dailyAdvertisingRevenue: 650_000,
        tripsPerSetDay: 18,
        dailyDemand: 42_000,
        status: readiness.ready ? "open" : "pre-opening",
        daysOperated: 0,
        ...structuredClone(input),
        fleetRequirement,
        readiness,
      };
      this.services.push(service);
      return service;
    });
  }

  operateDay(serviceId) {
    return this.transact("service-day-operated", () => {
      const service = this.services.find((item) => item.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const order = this.vehicleOrders.find((item) => item.id === service.vehicleOrderId);
      const depot = this.depots.find((item) => item.id === service.depotId);
      const contract = this.contracts.find((item) => item.id === service.contractId);
      this.clock.advance(1440);
      return operateServiceDay({ service, units: order?.units ?? [], depot, contract }, this.ledger, this.clock, this.rng);
    });
  }

  requireOpportunity(id) {
    const item = this.opportunities.find((opportunity) => opportunity.id === id);
    if (!item) throw new Error(`Unknown opportunity ${id}`);
    return item;
  }

  requireProject(id) {
    const item = this.projects.find((project) => project.id === id);
    if (!item) throw new Error(`Unknown project ${id}`);
    return item;
  }

  requirePlan(id) {
    const item = this.plans.find((plan) => plan.id === id);
    if (!item) throw new Error(`Unknown plan ${id}`);
    return item;
  }
}
