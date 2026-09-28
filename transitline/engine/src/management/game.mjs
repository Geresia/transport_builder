import { EventLog, Ledger, SimulationClock, decodeSave, encodeSave, makeRng } from "./core.mjs";
import { getCountryProfile } from "./country-profiles.mjs";
import { assessPlan, cancelConstruction, createConstructionProject, contractConstruction, advanceConstructionMonth, resumeConstruction, suspendConstruction } from "./construction.mjs";
import { estimateStationConstruction } from "./station-construction.mjs";
import { awardStationDelivery, createStationContractors, createStationDeliveryPackage, integrateStationDeliveryPackages, resolveStationDeliveryConditions, tenderStationDelivery } from "./station-delivery.mjs";
import { createCompetitors, createOpportunity, evaluateTender, generateCompetitorBids, negotiateAward, reannounceOpportunity, researchOpportunity, reviewSingleBid, submitPlayerBid } from "./procurement.mjs";
import { createDepot, createManufacturers, placeVehicleOrder, advanceVehicleOrderMonth } from "./rolling-stock.mjs";
import { advanceDepotDevelopmentMonth, compareDepotCandidates, contractDepotDevelopment, createDepotDevelopment, negotiateDepotDevelopment, reviseDepotDevelopment, assessDepotCandidate } from "./depot-planning.mjs";
import { calculateFleetRequirement, checkOpenReady, operateServiceDay } from "./operations.mjs";
import { createPlanRecord } from "./domain.mjs";
import { createIntegratedConstructionSchedule, integratedScheduleSummary, recordIntegratedTaskDelay, refreshIntegratedConstructionSchedule } from "./integrated-schedule.mjs";
import { applyConstructionCandidateSelection, attachConstructionSitePackages, CONSTRUCTION_EXPORT_SCHEMA, mergeConstructionPackageReports, validateConstructionMarker } from "./construction-package-adapter.mjs";
import { applyConstructionEventOccurrence, applyConstructionImpactGeometry, createConstructionEvent, defaultConstructionResponse, ignoreConstructionEvent, resolveConstructionEvent, rollConstructionEvent } from "./construction-events.mjs";
import { applyConstructionWorkfront, awardConstructionPackage, constructionContractorSummary, createConstructionContractors, integrateConstructionPackageAwards, prepareConstructionPackageProcurement, releaseConstructionPackageContract, settleConstructionPriceIndex, tenderConstructionPackage } from "./construction-contractors.mjs";
import { approveConstructionChangeOrder, constructionChangeOrderSummary, proposeConstructionChangeOrder, rejectConstructionChangeOrder, resolveConstructionChangeResponsibility } from "./construction-change-orders.mjs";

export class ManagementGame {
  constructor({ countryId = "JP", seed = 1, openingCash = 500_000_000_000, playerName = "Player Transit" } = {}) {
    this.country = getCountryProfile(countryId);
    this.clock = new SimulationClock(0);
    this.rng = makeRng(seed);
    this.constructionEventRng = makeRng((Number(seed) || 1) ^ 0x13579bdf);
    this.ledger = new Ledger(openingCash);
    this.events = new EventLog();
    this.player = { id: "player", name: playerName, cash: openingCash, reputation: 72, operatingScore: 80, bidCapacity: 3, activeBids: 0, backlog: 0 };
    this.competitors = createCompetitors();
    this.manufacturers = createManufacturers();
    this.stationContractors = createStationContractors(countryId);
    this.constructionContractors = createConstructionContractors(countryId);
    this.opportunities = [];
    this.contracts = [];
    this.projects = [];
    this.stationPackages = [];
    this.vehicleOrders = [];
    this.depots = [];
    this.schedules = [];
    this.constructionMarkers = [];
    this.constructionEvents = [];
    this.nextConstructionEventSequence = 1;
    this.nextConstructionChangeOrderSequence = 1;
    this.services = [];
    this.plans = [];
  }

  snapshot() {
    return {
      countryId: this.country.id,
      clock: { minute: this.clock.minute, queue: structuredClone(this.clock.queue), nextEventId: this.clock.nextEventId },
      rngState: this.rng.snapshot(),
      constructionEventRngState: this.constructionEventRng.snapshot(),
      ledger: { openingCash: this.ledger.openingCash, entries: structuredClone(this.ledger.entries), commitments: structuredClone([...this.ledger.commitments.values()]) },
      events: structuredClone(this.events.entries),
      player: structuredClone(this.player),
      competitors: structuredClone(this.competitors),
      manufacturers: structuredClone(this.manufacturers),
      stationContractors: structuredClone(this.stationContractors),
      constructionContractors: structuredClone(this.constructionContractors),
      opportunities: structuredClone(this.opportunities),
      contracts: structuredClone(this.contracts),
      projects: structuredClone(this.projects),
      stationPackages: structuredClone(this.stationPackages),
      vehicleOrders: structuredClone(this.vehicleOrders),
      depots: structuredClone(this.depots),
      schedules: structuredClone(this.schedules),
      constructionMarkers: structuredClone(this.constructionMarkers),
      constructionEvents: structuredClone(this.constructionEvents),
      nextConstructionEventSequence: this.nextConstructionEventSequence,
      nextConstructionChangeOrderSequence: this.nextConstructionChangeOrderSequence,
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
    this.constructionEventRng = snapshot.constructionEventRngState === undefined
      ? makeRng(20260928)
      : makeRng(snapshot.constructionEventRngState, true);
    this.ledger = new Ledger(snapshot.ledger.openingCash, snapshot.ledger.entries, snapshot.ledger.commitments);
    this.events = new EventLog(snapshot.events);
    for (const key of ["player", "competitors", "manufacturers", "stationContractors", "constructionContractors", "opportunities", "contracts", "projects", "stationPackages", "vehicleOrders", "depots", "schedules", "constructionMarkers", "constructionEvents", "services", "plans"]) {
      this[key] = structuredClone(snapshot[key] ?? []);
    }
    for (const event of this.constructionEvents) {
      if (event.status === "awaiting-response") event.status = "unresolved";
      for (const response of event.responses ?? []) {
        response.baseUpfrontCostJPY ??= response.upfrontCostJPY;
        response.baseDelayMonths ??= response.delayMonths;
      }
    }
    for (const marker of this.constructionMarkers) if (marker.status === "awaiting-response") marker.status = "unresolved";
    this.nextConstructionEventSequence = snapshot.nextConstructionEventSequence
      ?? this.constructionEvents.reduce((max, event) => Math.max(max, Number(event.id?.match(/^construction-event:(\d+)$/)?.[1]) || 0), 0) + 1;
    this.nextConstructionChangeOrderSequence = snapshot.nextConstructionChangeOrderSequence
      ?? this.schedules.flatMap((schedule) => schedule.constructionChangeOrders ?? []).reduce((max, order) => Math.max(max, Number(order.id?.match(/^construction-change-order:(\d+)$/)?.[1]) || 0), 0) + 1;
    if (!this.stationContractors.length) this.stationContractors = createStationContractors(snapshot.countryId);
    if (!this.constructionContractors.length) this.constructionContractors = createConstructionContractors(snapshot.countryId);
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
      if (opportunity.status !== "announced") throw new Error(`Tender cannot close from ${opportunity.status}`);
      if (this.clock.minute < opportunity.deadlineMinute) this.clock.advance(opportunity.deadlineMinute - this.clock.minute);
      generateCompetitorBids(opportunity, this.competitors, this.rng);
      const result = evaluateTender(opportunity);
      if (["failed-no-bids", "failed-technical"].includes(opportunity.status)) this.releaseTenderParticipants(opportunity);
      return result;
    });
  }

  reviewSingleBid(opportunityId, accepted = true) {
    return this.transact("single-bid-reviewed", () => {
      const opportunity = this.requireOpportunity(opportunityId);
      const result = reviewSingleBid(opportunity, accepted);
      if (!accepted) this.releaseTenderParticipants(opportunity);
      return result;
    });
  }

  reannounceTender(opportunityId, options = {}) {
    return this.transact("tender-reannounced", () => {
      const opportunity = this.requireOpportunity(opportunityId);
      this.releaseTenderParticipants(opportunity);
      return reannounceOpportunity(opportunity, this.clock, options);
    });
  }

  award(opportunityId, bidderId, accepted = true) {
    return this.transact("tender-negotiated", () => {
      const opportunity = this.requireOpportunity(opportunityId);
      const contract = negotiateAward(opportunity, bidderId, accepted);
      if (contract) {
        this.contracts.push(contract);
        this.releaseTenderParticipants(opportunity);
      } else if (!accepted) {
        this.releaseTenderBid(opportunity, bidderId);
        if (opportunity.status === "retender") this.releaseTenderParticipants(opportunity);
      }
      return contract;
    });
  }

  releaseTenderParticipants(opportunity) {
    for (const bid of opportunity.bids) this.releaseTenderBid(opportunity, bid.bidderId);
  }

  releaseTenderBid(opportunity, bidderId) {
    const bid = opportunity.bids.find((item) => item.bidderId === bidderId);
    if (!bid || bid.participationReleased) return false;
    const bidder = bidderId === this.player.id ? this.player : this.competitors.find((item) => item.id === bidderId);
    if (bidder) bidder.activeBids = Math.max(0, bidder.activeBids - 1);
    bid.participationReleased = true;
    if (bidderId === this.player.id) this.ledger.release(`bond:${opportunity.id}`);
    return true;
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
      this.syncStationPackageRecords(project);
      return { projectId, deposit };
    });
  }

  suspendProject(projectId, reason) {
    return this.transact("construction-suspended", () => {
      const project = suspendConstruction(this.requireProject(projectId), reason, this.clock);
      this.syncStationPackageRecords(project);
      this.refreshProjectSchedules(project.id);
      return project;
    });
  }

  resumeProject(projectId) {
    return this.transact("construction-resumed", () => {
      const project = resumeConstruction(this.requireProject(projectId), this.clock);
      this.syncStationPackageRecords(project);
      this.refreshProjectSchedules(project.id);
      return project;
    });
  }

  cancelProject(projectId) {
    return this.transact("construction-cancelled", () => {
      const project = this.requireProject(projectId);
      const sunkCost = cancelConstruction(project, this.ledger, this.clock);
      for (const schedule of this.schedules.filter((entry) => entry.projectId === projectId)) {
        for (const deliveryPackage of schedule.constructionPackages ?? []) releaseConstructionPackageContract(deliveryPackage, this.constructionContractors, "cancelled", this.clock);
      }
      this.syncStationPackageRecords(project);
      this.refreshProjectSchedules(project.id);
      return { projectId, sunkCost };
    });
  }

  designStationPackage(input) {
    return this.transact("station-package-designed", () => {
      if (this.stationPackages.some((entry) => entry.id === input.id)) throw new Error(`Duplicate station package ${input.id}`);
      const constructionEstimate = estimateStationConstruction({
        stationPlan: input.adaptation.stationPlan,
        accessPlan: input.adaptation.accessPlan,
        context: input.adaptation.constructionContext,
        countryProfile: this.country,
        methodId: input.methodId,
      });
      const deliveryPackage = createStationDeliveryPackage({ id: input.id, adaptation: input.adaptation, constructionEstimate });
      deliveryPackage.statusHistory[0].atMinute = this.clock.minute;
      this.stationPackages.push(deliveryPackage);
      return deliveryPackage;
    });
  }

  resolveStationPackage(packageId, resolutions) {
    return this.transact("station-package-conditions-resolved", () => resolveStationDeliveryConditions(this.requireStationPackage(packageId), resolutions));
  }

  tenderStationPackage(packageId) {
    return this.transact("station-package-tendered", () => tenderStationDelivery(this.requireStationPackage(packageId), this.stationContractors, this.rng, this.clock));
  }

  awardStationPackage(packageId, bidId) {
    return this.transact("station-package-awarded", () => awardStationDelivery(this.requireStationPackage(packageId), this.stationContractors, bidId, this.clock));
  }

  integrateStationPackages(projectId, packageIds, options = {}) {
    return this.transact("station-packages-integrated", () => {
      const project = this.requireProject(projectId);
      const packages = packageIds.map((id) => this.requireStationPackage(id));
      return integrateStationDeliveryPackages(project, packages, options);
    });
  }

  addDepot(input) {
    return this.transact("depot-secured", () => {
      if (this.depots.some((depot) => depot.id === input.id)) throw new Error(`Duplicate depot ${input.id}`);
      const depot = createDepot(input);
      this.depots.push(depot);
      return depot;
    });
  }

  evaluateDepotCandidate(input) {
    return assessDepotCandidate({ ...input, countryProfile: this.country });
  }

  compareDepotCandidates(inputs) {
    return compareDepotCandidates(inputs.map((input) => this.evaluateDepotCandidate(input)));
  }

  planDepot(input) {
    return this.transact("depot-planned", () => {
      if (this.depots.some((depot) => depot.id === input.id)) throw new Error(`Duplicate depot ${input.id}`);
      const depot = createDepotDevelopment(input, this.country);
      this.depots.push(depot);
      return depot;
    });
  }

  negotiateDepot(depotId, terms = {}) {
    return this.transact("depot-negotiated", () => negotiateDepotDevelopment(this.requireDepot(depotId), terms));
  }

  reviseDepot(depotId, changes) {
    return this.transact("depot-revised", () => reviseDepotDevelopment(this.requireDepot(depotId), changes, this.country));
  }

  contractDepot(depotId) {
    return this.transact("depot-contracted", () => contractDepotDevelopment(this.requireDepot(depotId), this.ledger, this.clock));
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

  createIntegratedSchedule({ id, projectId, depotIds, vehicleOrderIds, stationPackageIds } = {}) {
    return this.transact("integrated-schedule-created", () => {
      const project = this.requireProject(projectId);
      if (this.schedules.some((entry) => entry.id === (id ?? `schedule:${project.id}`))) throw new Error(`Duplicate integrated schedule ${id ?? `schedule:${project.id}`}`);
      const depots = (depotIds ?? []).map((depotId) => this.requireDepot(depotId));
      const vehicleOrders = (vehicleOrderIds ?? []).map((orderId) => {
        const order = this.vehicleOrders.find((entry) => entry.id === orderId);
        if (!order) throw new Error(`Unknown vehicle order ${orderId}`);
        return order;
      });
      const packageIds = stationPackageIds ?? (project.stationDeliveryPackages ?? []).map((entry) => entry.id);
      const stationPackages = packageIds.map((packageId) => this.stationPackages.find((entry) => entry.id === packageId)
        ?? project.stationDeliveryPackages?.find((entry) => entry.id === packageId)
        ?? (() => { throw new Error(`Unknown station package ${packageId}`); })());
      const schedule = createIntegratedConstructionSchedule({ id, project, stationPackages, depots, vehicleOrders, clock: this.clock, approvalMonths: this.country.approvalMonths });
      this.schedules.push(schedule);
      return schedule;
    });
  }

  refreshIntegratedSchedule(scheduleId) {
    return this.transact("integrated-schedule-refreshed", () => integratedScheduleSummary(this.refreshScheduleRecord(this.requireSchedule(scheduleId))));
  }

  delayIntegratedTask(scheduleId, taskId, delay) {
    return this.transact("integrated-schedule-task-delayed", () => {
      const schedule = this.requireSchedule(scheduleId);
      const event = recordIntegratedTaskDelay(schedule, taskId, delay, this.clock);
      this.refreshScheduleRecord(schedule);
      return { event, schedule: integratedScheduleSummary(schedule) };
    });
  }

  configureConstructionPackages(scheduleId, constructionExport, selections = []) {
    return this.transact("construction-packages-configured", () => {
      if (constructionExport?.schema !== CONSTRUCTION_EXPORT_SCHEMA || !Array.isArray(constructionExport.sites)) throw new Error("Invalid ConstructionExport");
      const schedule = this.requireSchedule(scheduleId);
      if (schedule.contractorProcurementPrepared) throw new Error("Construction packages cannot be redrawn after contractor procurement starts");
      const { depots } = this.scheduleEntities(schedule);
      attachConstructionSitePackages(schedule, constructionExport.sites, { depots });
      for (const selection of selections) applyConstructionCandidateSelection(schedule, selection);
      this.refreshScheduleRecord(schedule);
      return mergeConstructionPackageReports([schedule]);
    });
  }

  selectConstructionCandidate(scheduleId, selection) {
    return this.transact("construction-candidate-selected", () => {
      const schedule = this.requireSchedule(scheduleId);
      const deliveryPackage = schedule.constructionPackages?.find((entry) => entry.constructionSiteId === selection?.constructionSiteId);
      if (deliveryPackage?.procurement && deliveryPackage.procurement.status !== "planned") throw new Error("Construction candidate cannot change after its tender starts");
      return applyConstructionCandidateSelection(schedule, selection);
    });
  }

  prepareConstructionProcurement(scheduleId) {
    return this.transact("construction-procurement-prepared", () => {
      const schedule = this.requireSchedule(scheduleId);
      const packages = prepareConstructionPackageProcurement(schedule, this.requireProject(schedule.projectId));
      return structuredClone(packages);
    });
  }

  tenderConstructionPackage(scheduleId, constructionSiteId, options = {}) {
    return this.transact("construction-package-tendered", () => tenderConstructionPackage(
      this.requireSchedule(scheduleId), constructionSiteId, this.constructionContractors, this.rng, options, this.clock,
    ));
  }

  awardConstructionPackage(scheduleId, constructionSiteId, bidId) {
    return this.transact("construction-package-awarded", () => awardConstructionPackage(
      this.requireSchedule(scheduleId), constructionSiteId, this.constructionContractors, bidId, this.clock,
    ));
  }

  integrateConstructionPackageAwards(scheduleId) {
    return this.transact("construction-package-contracts-integrated", () => {
      const schedule = this.requireSchedule(scheduleId);
      const project = this.requireProject(schedule.projectId);
      const replacement = integrateConstructionPackageAwards(schedule, project);
      this.adjustConstructionCommitment(project);
      this.refreshScheduleRecord(schedule);
      return { replacement, packages: constructionContractorSummary(schedule) };
    });
  }

  settleConstructionPriceIndex(scheduleId, priceIndex, options = {}) {
    return this.transact("construction-price-index-settled", () => {
      const schedule = this.requireSchedule(scheduleId);
      const project = this.requireProject(schedule.projectId);
      const settlement = settleConstructionPriceIndex(schedule, project, priceIndex, this.clock, options);
      this.adjustConstructionCommitment(project);
      return settlement;
    });
  }

  constructionContractorReport(scheduleId = null) {
    const schedules = scheduleId === null ? this.schedules : [this.requireSchedule(scheduleId)];
    return schedules.flatMap((schedule) => constructionContractorSummary(schedule));
  }

  applyConstructionWorkfront(scheduleId, workfront) {
    return this.transact("construction-workfront-assessed", () => applyConstructionWorkfront(
      this.requireSchedule(scheduleId), workfront, this.constructionContractors, this.clock,
    ));
  }

  equipmentAssignmentReport(scheduleId = null) {
    return this.constructionContractorReport(scheduleId).flatMap((entry) => entry.equipmentAssignments);
  }

  workfrontAssessmentReport(scheduleId = null) {
    const schedules = scheduleId === null ? this.schedules : [this.requireSchedule(scheduleId)];
    return schedules.flatMap((schedule) => (schedule.constructionPackages ?? []).flatMap((deliveryPackage) =>
      (deliveryPackage.procurement?.workfrontAssessments ?? []).map((assessment) => ({
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        planId: schedule.planId,
        constructionSiteId: deliveryPackage.constructionSiteId,
        kind: deliveryPackage.kind,
        equipmentType: deliveryPackage.procurement.equipmentType,
        ...structuredClone(assessment),
      }))));
  }

  requestConstructionChangeOrder(scheduleId, input) {
    return this.transact("construction-change-order-requested", () => {
      const schedule = this.requireSchedule(scheduleId);
      const order = proposeConstructionChangeOrder({
        id: `construction-change-order:${this.nextConstructionChangeOrderSequence}`,
        schedule,
        project: this.requireProject(schedule.projectId),
        contractors: this.constructionContractors,
        input,
        clock: this.clock,
      });
      this.nextConstructionChangeOrderSequence++;
      return order;
    });
  }

  resolveConstructionChangeResponsibility(scheduleId, changeOrderId, responsibility) {
    return this.transact("construction-change-responsibility-resolved", () => resolveConstructionChangeResponsibility(
      this.requireSchedule(scheduleId), changeOrderId, responsibility, this.clock,
    ));
  }

  approveConstructionChangeOrder(scheduleId, changeOrderId) {
    return this.transact("construction-change-order-approved", () => {
      const schedule = this.requireSchedule(scheduleId);
      const project = this.requireProject(schedule.projectId);
      const order = approveConstructionChangeOrder(schedule, project, changeOrderId, this.clock);
      this.adjustConstructionCommitment(project);
      this.refreshScheduleRecord(schedule);
      return order;
    });
  }

  rejectConstructionChangeOrder(scheduleId, changeOrderId, reason) {
    return this.transact("construction-change-order-rejected", () => rejectConstructionChangeOrder(
      this.requireSchedule(scheduleId), changeOrderId, reason, this.clock,
    ));
  }

  constructionChangeOrderReport(scheduleId = null) {
    const schedules = scheduleId === null ? this.schedules : [this.requireSchedule(scheduleId)];
    return schedules.flatMap((schedule) => constructionChangeOrderSummary(schedule));
  }

  recordConstructionMarker(input) {
    return this.transact("construction-marker-recorded", () => {
      validateConstructionMarker(input, this.schedules);
      const marker = {
        id: `construction-marker:${this.constructionMarkers.length + 1}`,
        constructionSiteId: input.constructionSiteId,
        kind: input.kind,
        location: input.location === undefined ? null : structuredClone(input.location),
        message: input.message === undefined ? null : String(input.message),
        eventId: input.eventId ?? null,
        candidateRef: input.candidateRef ? structuredClone(input.candidateRef) : null,
        severity: input.severity ?? null,
        status: input.status ?? null,
        atMinute: this.clock.minute,
      };
      this.constructionMarkers.push(marker);
      return structuredClone(marker);
    });
  }

  constructionPackageReport() {
    return mergeConstructionPackageReports(this.schedules);
  }

  triggerConstructionEvent(scheduleId, input) {
    return this.transact("construction-event-triggered", () => {
      const schedule = this.requireSchedule(scheduleId);
      const project = this.requireProject(schedule.projectId);
      const event = createConstructionEvent({
        id: this.allocateConstructionEventId(),
        schedule,
        project,
        constructionSiteId: input.constructionSiteId,
        kind: input.kind,
        severity: input.severity ?? "moderate",
        clock: this.clock,
        risk: input.risk ?? null,
      });
      applyConstructionEventOccurrence(event, schedule, this.clock);
      this.constructionEvents.push(event);
      this.addConstructionEventMarker(event);
      this.refreshScheduleRecord(schedule);
      return structuredClone(event);
    });
  }

  respondConstructionEvent(eventId, responseId) {
    return this.transact("construction-event-resolved", () => {
      const event = this.requireConstructionEvent(eventId);
      const schedule = this.requireSchedule(event.scheduleId);
      const project = this.requireProject(event.projectId);
      const outcome = resolveConstructionEvent(event, responseId, { schedule, project, player: this.player, ledger: this.ledger, clock: this.clock });
      this.syncConstructionEventMarker(event);
      this.refreshScheduleRecord(schedule);
      return { event: structuredClone(event), outcome, schedule: integratedScheduleSummary(schedule) };
    });
  }

  applyConstructionImpact(eventId, impact) {
    return this.transact("construction-impact-applied", () => {
      const event = this.requireConstructionEvent(eventId);
      const adjustment = applyConstructionImpactGeometry(event, impact);
      this.syncConstructionEventMarker(event);
      const marker = this.constructionMarkers.find((entry) => entry.eventId === event.id);
      if (marker && Array.isArray(event.eventLocation)) marker.location = structuredClone(event.eventLocation);
      return { event: structuredClone(event), adjustment };
    });
  }

  ignoreConstructionEvent(eventId) {
    return this.transact("construction-event-ignored", () => {
      const event = this.requireConstructionEvent(eventId);
      const schedule = this.requireSchedule(event.scheduleId);
      const project = this.requireProject(event.projectId);
      const outcome = ignoreConstructionEvent(event, { schedule, project, player: this.player, clock: this.clock });
      this.syncConstructionEventMarker(event);
      this.refreshScheduleRecord(schedule);
      return { event: structuredClone(event), outcome, schedule: integratedScheduleSummary(schedule) };
    });
  }

  constructionEventReport() {
    return structuredClone(this.constructionEvents);
  }

  advanceMonth() {
    return this.transact("month-advanced", () => {
      this.clock.advance(30 * 1440);
      const autoResolvedEvents = this.resolveExpiredConstructionEvents();
      const construction = this.projects.filter((project) => ["contracted", "underConstruction", "inspection"].includes(project.status))
        .map((project) => {
          const procurement = this.schedules.find((schedule) => schedule.projectId === project.id && schedule.contractorProcurementPrepared && !schedule.contractorProcurementIntegrated);
          if (procurement) return { projectId: project.id, blocked: true, reason: "construction-package-procurement" };
          const equipmentBlocked = this.schedules.find((schedule) => schedule.projectId === project.id
            && this.equipmentAssignmentReport(schedule.id).some((assignment) => assignment.status === "assigned" && assignment.placementStatus === "infeasible"));
          if (equipmentBlocked) return { projectId: project.id, blocked: true, reason: "equipment-workfront-infeasible" };
          const packageEventsEnabled = this.schedules.some((schedule) => schedule.projectId === project.id && (schedule.constructionPackages?.length ?? 0) > 0);
          const result = advanceConstructionMonth(project, this.ledger, this.clock, this.rng, this.country, { randomRisk: !packageEventsEnabled });
          if (project.status === "available") {
            for (const schedule of this.schedules.filter((entry) => entry.projectId === project.id)) {
              for (const deliveryPackage of schedule.constructionPackages ?? []) releaseConstructionPackageContract(deliveryPackage, this.constructionContractors, "completed", this.clock);
            }
          }
          return { projectId: project.id, ...result };
        });
      for (const project of this.projects) this.syncStationPackageRecords(project);
      for (const project of this.projects.filter((item) => item.status === "available" && item.planRecordId)) {
        const record = this.plans.find((item) => item.id === project.planRecordId);
        if (record && record.status === "in-project") record.status = "assets-available";
      }
      const vehicles = this.vehicleOrders.filter((order) => !["accepted", "cancelled"].includes(order.stage)).map((order) => {
        const manufacturer = this.manufacturers.find((item) => item.id === order.manufacturerId);
        return { orderId: order.id, ...advanceVehicleOrderMonth(order, manufacturer, this.ledger, this.clock, this.rng) };
      });
      const depots = this.depots.filter((depot) => depot.status === "underConstruction")
        .map((depot) => ({ depotId: depot.id, ...advanceDepotDevelopmentMonth(depot, this.ledger, this.clock, this.rng, this.country) }));
      let schedules = this.schedules.map((schedule) => integratedScheduleSummary(this.refreshScheduleRecord(schedule)));
      const generatedEvents = [];
      for (const schedule of this.schedules) {
        const project = this.requireProject(schedule.projectId);
        const event = rollConstructionEvent({
          id: this.nextAvailableConstructionEventId(),
          schedule,
          project,
          countryProfile: this.country,
          difficultyFactor: this.scenario?.delayFactor ?? 1,
          rng: this.constructionEventRng,
          clock: this.clock,
          existingEvents: this.constructionEvents,
        });
        if (!event) continue;
        this.nextConstructionEventSequence++;
        applyConstructionEventOccurrence(event, schedule, this.clock);
        this.constructionEvents.push(event);
        this.addConstructionEventMarker(event);
        generatedEvents.push(structuredClone(event));
        this.refreshScheduleRecord(schedule);
      }
      if (generatedEvents.length) schedules = this.schedules.map((schedule) => integratedScheduleSummary(schedule));
      return { construction, vehicles, depots, schedules, generatedEvents, autoResolvedEvents };
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

  requireDepot(id) {
    const depot = this.depots.find((item) => item.id === id);
    if (!depot) throw new Error(`Unknown depot ${id}`);
    return depot;
  }

  requirePlan(id) {
    const item = this.plans.find((plan) => plan.id === id);
    if (!item) throw new Error(`Unknown plan ${id}`);
    return item;
  }

  requireStationPackage(id) {
    const item = this.stationPackages.find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown station package ${id}`);
    return item;
  }

  requireSchedule(id) {
    const item = this.schedules.find((schedule) => schedule.id === id);
    if (!item) throw new Error(`Unknown integrated schedule ${id}`);
    return item;
  }

  requireConstructionEvent(id) {
    const item = this.constructionEvents.find((event) => event.id === id);
    if (!item) throw new Error(`Unknown construction event ${id}`);
    return item;
  }

  allocateConstructionEventId() {
    const id = this.nextAvailableConstructionEventId();
    this.nextConstructionEventSequence++;
    return id;
  }

  nextAvailableConstructionEventId() {
    let id = `construction-event:${this.nextConstructionEventSequence}`;
    while (this.constructionEvents.some((event) => event.id === id)) id = `construction-event:${++this.nextConstructionEventSequence}`;
    return id;
  }

  addConstructionEventMarker(event) {
    if (event.kind === "cost-inflation") return null;
    const schedule = this.requireSchedule(event.scheduleId);
    const deliveryPackage = schedule.constructionPackages?.find((entry) => entry.constructionSiteId === event.constructionSiteId);
    const selected = deliveryPackage?.selectedCandidate;
    const marker = {
      id: `construction-marker:${this.constructionMarkers.length + 1}`,
      constructionSiteId: event.constructionSiteId,
      kind: event.kind,
      location: event.eventLocation === null ? null : structuredClone(event.eventLocation),
      message: event.title,
      eventId: event.id,
      severity: event.severity,
      status: event.status,
      candidateRef: selected ? { kind: selected.kind, id: selected.candidateId } : null,
      atMinute: event.occurredAtMinute,
    };
    validateConstructionMarker(marker, this.schedules);
    this.constructionMarkers.push(marker);
    return marker;
  }

  syncConstructionEventMarker(event) {
    const marker = this.constructionMarkers.find((entry) => entry.eventId === event.id);
    if (marker) marker.status = event.status;
  }

  resolveExpiredConstructionEvents() {
    const resolved = [];
    for (const event of this.constructionEvents.filter((entry) => ["unresolved", "responding"].includes(entry.status) && entry.responseDueMinute <= this.clock.minute)) {
      const schedule = this.requireSchedule(event.scheduleId);
      const project = this.requireProject(event.projectId);
      const preferred = event.responses.find((entry) => entry.id === defaultConstructionResponse(event));
      const affordable = event.responses.filter((entry) => entry.upfrontCostJPY <= this.ledger.cash)
        .sort((a, b) => a.upfrontCostJPY - b.upfrontCostJPY || a.delayMonths - b.delayMonths)[0];
      const response = preferred?.upfrontCostJPY <= this.ledger.cash ? preferred : affordable;
      if (!response) continue;
      const outcome = resolveConstructionEvent(event, response.id, { schedule, project, player: this.player, ledger: this.ledger, clock: this.clock, automatic: true });
      this.syncConstructionEventMarker(event);
      this.refreshScheduleRecord(schedule);
      resolved.push({ eventId: event.id, responseId: response.id, outcome });
    }
    return resolved;
  }

  adjustConstructionCommitment(project) {
    const commitmentId = `construction:${project.id}`;
    const commitment = this.ledger.commitments.get(commitmentId);
    if (!commitment) return null;
    const remaining = Math.max(0, project.estimate.totalP50 - project.paid);
    const availableIncludingCurrent = this.ledger.availableCash + commitment.remaining;
    if (remaining > availableIncludingCurrent + 1e-6) throw new Error("Insufficient available cash for awarded construction packages");
    if (remaining <= 1e-6) {
      this.ledger.release(commitmentId);
      return { original: project.paid, remaining: 0 };
    }
    commitment.original = project.paid + remaining;
    commitment.remaining = remaining;
    commitment.repricedAtMinute = this.clock.minute;
    return structuredClone(commitment);
  }

  scheduleEntities(schedule) {
    const project = this.requireProject(schedule.projectId);
    const stationPackages = schedule.linkedStationPackageIds.map((id) => this.stationPackages.find((entry) => entry.id === id)
      ?? project.stationDeliveryPackages?.find((entry) => entry.id === id)).filter(Boolean);
    const depots = schedule.linkedDepotIds.map((id) => this.depots.find((entry) => entry.id === id)).filter(Boolean);
    const vehicleOrders = schedule.linkedVehicleOrderIds.map((id) => this.vehicleOrders.find((entry) => entry.id === id)).filter(Boolean);
    return { project, stationPackages, depots, vehicleOrders };
  }

  refreshScheduleRecord(schedule) {
    return refreshIntegratedConstructionSchedule(schedule, this.scheduleEntities(schedule), this.clock);
  }

  refreshProjectSchedules(projectId) {
    return this.schedules.filter((schedule) => schedule.projectId === projectId).map((schedule) => this.refreshScheduleRecord(schedule));
  }

  syncStationPackageRecords(project) {
    for (const embedded of project.stationDeliveryPackages ?? []) {
      const record = this.stationPackages.find((entry) => entry.id === embedded.id);
      if (!record) continue;
      const terminal = ["available", "cancelled"].includes(embedded.status);
      const releaseCapacity = terminal && !record.capacityReleased;
      Object.assign(record, structuredClone(embedded));
      if (releaseCapacity) {
        const contractor = this.stationContractors.find((entry) => entry.id === record.awardedBid?.contractorId);
        if (contractor) {
          contractor.backlog = Math.max(0, contractor.backlog - 1);
          if (embedded.status === "available") contractor.completedPackages++;
        }
        record.capacityReleased = true;
        embedded.capacityReleased = true;
      }
    }
  }
}
