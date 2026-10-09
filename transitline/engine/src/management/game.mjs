import { EventLog, Ledger, SimulationClock, decodeSave, encodeSave, makeRng } from "./core.mjs";
import { getCountryProfile } from "./country-profiles.mjs";
import { assessPlan, cancelConstruction, createConstructionProject, contractConstruction, advanceConstructionMonth, resumeConstruction, suspendConstruction } from "./construction.mjs";
import { estimateStationConstruction } from "./station-construction.mjs";
import { awardStationDelivery, createStationContractors, createStationDeliveryPackage, integrateStationDeliveryPackages, resolveStationDeliveryConditions, tenderStationDelivery } from "./station-delivery.mjs";
import { createCompetitors, createOpportunity, evaluateTender, generateCompetitorBids, negotiateAward, reannounceOpportunity, researchOpportunity, reviewSingleBid, submitPlayerBid } from "./procurement.mjs";
import { createDepot, createManufacturers, placeVehicleOrder, advanceVehicleOrderMonth, VEHICLE_MODELS } from "./rolling-stock.mjs";
import { advanceDepotDevelopmentMonth, compareDepotCandidates, contractDepotDevelopment, createDepotDevelopment, negotiateDepotDevelopment, reviseDepotDevelopment, assessDepotCandidate } from "./depot-planning.mjs";
import { calculateFleetRequirement, checkOpenReady, operateServiceDay } from "./operations.mjs";
import { createPlanRecord } from "./domain.mjs";
import { createIntegratedConstructionSchedule, integratedScheduleSummary, recordIntegratedTaskDelay, refreshIntegratedConstructionSchedule } from "./integrated-schedule.mjs";
import { applyConstructionCandidateSelection, attachConstructionSitePackages, CONSTRUCTION_EXPORT_SCHEMA, mergeConstructionPackageReports, validateConstructionMarker } from "./construction-package-adapter.mjs";
import { applyConstructionEventOccurrence, applyConstructionImpactGeometry, createConstructionEvent, defaultConstructionResponse, ignoreConstructionEvent, resolveConstructionEvent, rollConstructionEvent } from "./construction-events.mjs";
import { applyConstructionWorkfront, awardConstructionPackage, constructionContractorSummary, createConstructionContractors, integrateConstructionPackageAwards, prepareConstructionPackageProcurement, releaseConstructionPackageContract, settleConstructionPriceIndex, tenderConstructionPackage } from "./construction-contractors.mjs";
import { approveConstructionChangeOrder, constructionChangeOrderSummary, proposeConstructionChangeOrder, rejectConstructionChangeOrder, resolveConstructionChangeResponsibility } from "./construction-change-orders.mjs";
import { approveStationDesignChange, proposeStationDesignChange, rejectStationDesignChange, stationDesignChangeSummary } from "./station-design-changes.mjs";
import { createConstructionCycleReport, integratedConstructionProgressGate } from "./construction-cycle.mjs";
import { advanceConstructionPriceMonth, applyConstructionPriceShock, constructionFundingOptions, createConstructionFinanceRecord, createConstructionPriceState, createOrUpdateConstructionFundingCase } from "./construction-finance.mjs";
import { activateProjectOperatingFinance, applyInfrastructureOperatingWear, operatingMonthFromMinute, operatingMonthReport, recordInfrastructureMaintenancePayments, recordOperatingFinanceSettlements, recordOperatingPeriod, settleProjectOperatingFinance } from "./operating-economy.mjs";
import { advanceInfrastructureMaintenancePrograms, infrastructureMaintenanceImpact, startInfrastructureMaintenance } from "./infrastructure-maintenance.mjs";
import { applyServicePolicy, createOperatingCompetitor, ELECTRICITY_CONTRACTS } from "./service-policy.mjs";
import { corporateFinancialStatements } from "./corporate-finance.mjs";
import { assignServiceToOperatingResourcePool as assignPoolService, createOperatingResourcePool as buildOperatingResourcePool, operatingResourcePoolReport as buildOperatingResourcePoolReport, rebalanceOperatingResourcePool as rebalancePool, removeServiceFromOperatingResourcePool as removePoolService, resolveOperatingResourcePoolService as resolvePoolService } from "./operating-resource-pool.mjs";
import { awardTrackAccessOffer as buildTrackAccessAgreement, createTrackAccessOpportunity as buildTrackAccessOpportunity, generateTrackAccessOffers as buildTrackAccessOffers, setTrackAccessAgreementStatus as changeTrackAccessStatus, settleTrackAccessRevenue, trackAccessImpact as calculateTrackAccessImpact } from "./track-access.mjs";
import { createThroughService as buildThroughService } from "./through-service.mjs";
import { advanceVehicleRetrofitMonth, authorizeVehicleRetrofitRetest as buildVehicleRetrofitRetest, createVehicleRetrofitProgram, mergeVehicleTechnicalOverrides, startVehicleRetrofitProgram } from "./vehicle-retrofit.mjs";
import { activeThroughHandoverConfirmations, advanceThroughHandoverProjectMonth, awardThroughHandoverProject, cancelThroughHandoverProject, createThroughHandoverProject, grantThroughHandoverPermission, tenderThroughHandoverProject } from "./through-handover-project.mjs";
import { createThroughHandoverPossessionPlan, settleThroughHandoverPossessionMonth, throughHandoverPossessionImpact as calculateThroughHandoverPossessionImpact } from "./through-handover-possession.mjs";
import { activateRailwayTimetable, approveRailwayTimetable, buildRailwayTimetable, withdrawRailwayTimetable } from "./railway-timetable.mjs";
import {
  agreeNewTownDevelopmentRecord, assessNewTownDevelopment as assessNewTownDevelopmentRecord, cancelNewTownDevelopmentRecord, createNewTownDevelopmentDraft, delayNewTownDevelopmentRecord,
  newTownDevelopmentHooks as buildNewTownDevelopmentHooks, proposeNewTownDevelopmentRecord, recordNewTownOccupancyRecord, resumeNewTownDevelopmentRecord, startNewTownServicingRecord,
} from "./new-town-development.mjs";
import {
  NEW_TOWN_RAIL_CONTRIBUTION_LEDGER_CATEGORY, agreeContributionRecord, assessContribution, createContributionDraft, delayContributionRecord, fundContributionRecord,
  newTownRailContributionHooks as buildNewTownRailContributionHooks, proposeContributionRecord, releaseContributionRecord, resumeContributionRecord, terminateContributionRecord,
} from "./new-town-rail-contribution.mjs";
import {
  assessNewTownDemandIntake as assessNewTownDemandIntakeRecord, decideNewTownDemandCandidate, newTownDemandIntakeReport as buildNewTownDemandIntakeReport, revokeNewTownDemandIntakeRecord,
} from "./new-town-demand-intake.mjs";
import {
  adoptCampaignProgram, assessCampaignProgram as assessCampaignProgramRecord, cancelCampaignProgram, campaignProgramHooks as buildCampaignProgramHooks,
  completeCampaignProgram, createCampaignProgramDraft, delayCampaignProgram, monitorCampaignProgram, reachCampaignMilestone, resumeCampaignProgram,
} from "./campaign-program.mjs";
import { assessCampaignActivation as assessCampaignActivationRecord, createCampaignActivation, withdrawCampaignActivation } from "./campaign-activation.mjs";
import { acceptThroughFareAgreement as acceptFareAgreement, activateThroughFareAgreement as activateFareAgreement, createThroughFareAgreement, fileThroughFareAgreement as fileFareAgreement, setThroughFareAgreementStatus as changeThroughFareStatus } from "./through-fare.mjs";
import { calculateThroughOperatingSettlement } from "./through-operation.mjs";

// What the event log keeps of a campaign command: who, which status, and the one transition just made - not the whole record, which grows
// with its milestones and history (see `transact`).
const campaignProgramEvent = (record) => ({ campaignProgramId: record.id, programId: record.programId, programRevision: record.programRevision, status: record.status, transition: structuredClone(record.history.at(-1) ?? null) });
const campaignActivationEvent = (record) => ({ activationId: record.activationId, programId: record.programId, milestoneId: record.milestoneId, status: record.status });

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
    this.constructionCycleReports = [];
    this.constructionPriceState = createConstructionPriceState(countryId);
    this.constructionFundingCases = [];
    this.constructionFinancing = [];
    this.operatingMonthReports = [];
    this.infrastructureMaintenancePrograms = [];
    this.operatingResourcePools = [];
    this.trackAccessOpportunities = [];
    this.trackAccessAgreements = [];
    this.throughServices = [];
    this.throughHandoverProjects = [];
    this.vehicleRetrofitPrograms = [];
    this.throughFareAgreements = [];
    this.throughOperatingSettlements = [];
    this.railwayTimetables = [];
    this.newTownDevelopments = [];
    this.newTownRailContributions = [];
    this.newTownDemandIntakes = [];
    this.campaignPrograms = [];
    this.campaignActivations = [];
    this.nextConstructionEventSequence = 1;
    this.nextConstructionChangeOrderSequence = 1;
    this.nextStationDesignChangeSequence = 1;
    this.nextConstructionFundingCaseSequence = 1;
    this.nextConstructionFinanceSequence = 1;
    this.nextInfrastructureMaintenanceSequence = 1;
    this.nextTrackAccessSequence = 1;
    this.nextThroughServiceSequence = 1;
    this.nextThroughHandoverProjectSequence = 1;
    this.nextVehicleRetrofitSequence = 1;
    this.nextThroughFareSequence = 1;
    this.nextRailwayTimetableSequence = 1;
    this.nextNewTownDevelopmentSequence = 1;
    this.nextNewTownRailContributionSequence = 1;
    this.nextNewTownDemandIntakeSequence = 1;
    this.nextCampaignProgramSequence = 1;
    this.nextCampaignActivationSequence = 1;
    this.services = [];
    this.plans = [];
    this._transactionDepth = 0;
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
      constructionCycleReports: structuredClone(this.constructionCycleReports),
      constructionPriceState: structuredClone(this.constructionPriceState),
      constructionFundingCases: structuredClone(this.constructionFundingCases),
      constructionFinancing: structuredClone(this.constructionFinancing),
      operatingMonthReports: structuredClone(this.operatingMonthReports),
      infrastructureMaintenancePrograms: structuredClone(this.infrastructureMaintenancePrograms),
      operatingResourcePools: structuredClone(this.operatingResourcePools),
      trackAccessOpportunities: structuredClone(this.trackAccessOpportunities),
      trackAccessAgreements: structuredClone(this.trackAccessAgreements),
      throughServices: structuredClone(this.throughServices),
      throughHandoverProjects: structuredClone(this.throughHandoverProjects),
      vehicleRetrofitPrograms: structuredClone(this.vehicleRetrofitPrograms),
      throughFareAgreements: structuredClone(this.throughFareAgreements),
      throughOperatingSettlements: structuredClone(this.throughOperatingSettlements),
      railwayTimetables: structuredClone(this.railwayTimetables),
      newTownDevelopments: structuredClone(this.newTownDevelopments),
      newTownRailContributions: structuredClone(this.newTownRailContributions),
      newTownDemandIntakes: structuredClone(this.newTownDemandIntakes),
      campaignPrograms: structuredClone(this.campaignPrograms),
      campaignActivations: structuredClone(this.campaignActivations),
      nextConstructionEventSequence: this.nextConstructionEventSequence,
      nextConstructionChangeOrderSequence: this.nextConstructionChangeOrderSequence,
      nextStationDesignChangeSequence: this.nextStationDesignChangeSequence,
      nextConstructionFundingCaseSequence: this.nextConstructionFundingCaseSequence,
      nextConstructionFinanceSequence: this.nextConstructionFinanceSequence,
      nextInfrastructureMaintenanceSequence: this.nextInfrastructureMaintenanceSequence,
      nextTrackAccessSequence: this.nextTrackAccessSequence,
      nextThroughServiceSequence: this.nextThroughServiceSequence,
      nextThroughHandoverProjectSequence: this.nextThroughHandoverProjectSequence,
      nextVehicleRetrofitSequence: this.nextVehicleRetrofitSequence,
      nextThroughFareSequence: this.nextThroughFareSequence,
      nextRailwayTimetableSequence: this.nextRailwayTimetableSequence,
      nextNewTownDevelopmentSequence: this.nextNewTownDevelopmentSequence,
      nextNewTownRailContributionSequence: this.nextNewTownRailContributionSequence,
      nextNewTownDemandIntakeSequence: this.nextNewTownDemandIntakeSequence,
      nextCampaignProgramSequence: this.nextCampaignProgramSequence,
      nextCampaignActivationSequence: this.nextCampaignActivationSequence,
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
    for (const key of ["player", "competitors", "manufacturers", "stationContractors", "constructionContractors", "opportunities", "contracts", "projects", "stationPackages", "vehicleOrders", "depots", "schedules", "constructionMarkers", "constructionEvents", "constructionCycleReports", "constructionFundingCases", "constructionFinancing", "operatingMonthReports", "infrastructureMaintenancePrograms", "operatingResourcePools", "trackAccessOpportunities", "trackAccessAgreements", "throughServices", "throughHandoverProjects", "vehicleRetrofitPrograms", "throughFareAgreements", "throughOperatingSettlements", "railwayTimetables", "newTownDevelopments", "newTownRailContributions", "newTownDemandIntakes", "campaignPrograms", "campaignActivations", "services", "plans"]) {
      this[key] = structuredClone(snapshot[key] ?? []);
    }
    this.constructionPriceState = structuredClone(snapshot.constructionPriceState ?? createConstructionPriceState(snapshot.countryId));
    if (!snapshot.constructionPriceState) {
      const settledIndices = this.schedules.flatMap((schedule) => (schedule.constructionPackages ?? [])
        .map((deliveryPackage) => deliveryPackage.procurement?.contract?.lastSettledPriceIndex)
        .filter(Number.isFinite));
      this.constructionPriceState.currentIndex = Math.max(100, ...settledIndices);
      this.constructionPriceState.lastAdvancedMonth = Math.floor(this.clock.minute / (30 * 1440));
      this.constructionPriceState.history.push({ id: "construction-price:migrated", type: "migration", month: this.constructionPriceState.lastAdvancedMonth, atMinute: this.clock.minute, fromIndex: 100, toIndex: this.constructionPriceState.currentIndex });
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
    this.nextStationDesignChangeSequence = snapshot.nextStationDesignChangeSequence
      ?? this.stationPackages.flatMap((deliveryPackage) => deliveryPackage.designChanges ?? []).reduce((max, change) => Math.max(max, Number(change.id?.match(/^station-design-change:(\d+)$/)?.[1]) || 0), 0) + 1;
    this.nextConstructionFundingCaseSequence = snapshot.nextConstructionFundingCaseSequence
      ?? this.constructionFundingCases.reduce((max, fundingCase) => Math.max(max, Number(fundingCase.id?.match(/^construction-funding-case:(\d+)$/)?.[1]) || 0), 0) + 1;
    this.nextConstructionFinanceSequence = snapshot.nextConstructionFinanceSequence
      ?? this.constructionFinancing.reduce((max, finance) => Math.max(max, Number(finance.id?.match(/^construction-finance:(\d+)$/)?.[1]) || 0), 0) + 1;
    this.nextInfrastructureMaintenanceSequence = snapshot.nextInfrastructureMaintenanceSequence
      ?? this.infrastructureMaintenancePrograms.reduce((max, program) => Math.max(max, Number(program.id?.match(/^infrastructure-maintenance:(\d+)$/)?.[1]) || 0), 0) + 1;
    this.nextTrackAccessSequence = snapshot.nextTrackAccessSequence
      ?? this.trackAccessOpportunities.reduce((max, opportunity) => Math.max(max, Number(opportunity.id?.match(/^track-access:(\d+)$/)?.[1]) || 0), 0) + 1;
    this.nextThroughServiceSequence = Math.max(
      snapshot.nextThroughServiceSequence ?? 1,
      this.throughServices.reduce((max, service) => Math.max(max, Number(service.throughServiceId?.match(/^through-service:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextThroughHandoverProjectSequence = Math.max(
      snapshot.nextThroughHandoverProjectSequence ?? 1,
      this.throughHandoverProjects.reduce((max, project) => Math.max(max, Number(project.id?.match(/^through-handover-project:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextVehicleRetrofitSequence = Math.max(
      snapshot.nextVehicleRetrofitSequence ?? 1,
      this.vehicleRetrofitPrograms.reduce((max, program) => Math.max(max, Number(program.id?.match(/^vehicle-retrofit:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextThroughFareSequence = Math.max(
      snapshot.nextThroughFareSequence ?? 1,
      this.throughFareAgreements.reduce((max, agreement) => Math.max(max, Number(agreement.id?.match(/^through-fare:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextRailwayTimetableSequence = Math.max(
      snapshot.nextRailwayTimetableSequence ?? 1,
      this.railwayTimetables.reduce((max, timetable) => Math.max(max, Number(timetable.id?.match(/^railway-timetable:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    // ids are never reused: the allocator follows both the saved counter and the highest id that exists
    this.nextNewTownDevelopmentSequence = Math.max(
      snapshot.nextNewTownDevelopmentSequence ?? 1,
      this.newTownDevelopments.reduce((max, development) => Math.max(max, Number(development.id?.match(/^new-town-development:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextNewTownRailContributionSequence = Math.max(
      snapshot.nextNewTownRailContributionSequence ?? 1,
      this.newTownRailContributions.reduce((max, contribution) => Math.max(max, Number(contribution.contributionId?.match(/^new-town-rail-contribution:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextNewTownDemandIntakeSequence = Math.max(
      snapshot.nextNewTownDemandIntakeSequence ?? 1,
      this.newTownDemandIntakes.reduce((max, intake) => Math.max(max, Number(intake.id?.match(/^new-town-demand-intake:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextCampaignProgramSequence = Math.max(
      snapshot.nextCampaignProgramSequence ?? 1,
      this.campaignPrograms.reduce((max, program) => Math.max(max, Number(program.id?.match(/^campaign-program:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
    this.nextCampaignActivationSequence = Math.max(
      snapshot.nextCampaignActivationSequence ?? 1,
      this.campaignActivations.reduce((max, activation) => Math.max(max, Number(activation.activationId?.match(/^campaign-activation:(\d+)$/)?.[1]) || 0), 0) + 1,
    );
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

  // `summarize(result)` (optional) is what the event log keeps instead of the whole result.  The log is part of every snapshot, and every
  // transaction snapshots, so a result that grows with its record (a campaign program with its milestones) would make the log, the save
  // and the cost of each later command grow quadratically over a long campaign.
  transact(type, action, summarize = null) {
    const before = this.snapshot();
    this._transactionDepth += 1;
    try {
      const result = action();
      this.ledger.assertInvariant();
      this.player.cash = this.ledger.cash;
      this.events.record(this.clock.minute, type, summarize ? summarize(result) : result ?? {});
      return result;
    } catch (error) {
      this.restore(before);
      throw error;
    } finally {
      this._transactionDepth -= 1;
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
      if (this.constructionFundingCases.some((entry) => entry.projectId === projectId && ["open", "suspended"].includes(entry.status))) throw new Error("Construction funding gap must be resolved before work can resume");
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

  requestStationDesignChange(packageId, { designEdit, collisionResult = null } = {}) {
    return this.transact("station-design-change-requested", () => {
      const deliveryPackage = this.requireStationPackage(packageId);
      const project = this.projects.find((entry) => entry.stationDeliveryPackages?.some((item) => item.id === packageId));
      if (!project) throw new Error(`Station package ${packageId} is not integrated into a project`);
      const proposal = proposeStationDesignChange({
        id: `station-design-change:${this.nextStationDesignChangeSequence}`,
        deliveryPackage,
        project,
        designEdit,
        collisionResult,
        countryProfile: this.country,
        clock: this.clock,
      });
      this.nextStationDesignChangeSequence++;
      this.syncStationPackageToProject(project, deliveryPackage);
      return proposal;
    });
  }

  approveStationDesignChange(packageId, changeId) {
    return this.transact("station-design-change-approved", () => {
      const deliveryPackage = this.requireStationPackage(packageId);
      const project = this.projects.find((entry) => entry.stationDeliveryPackages?.some((item) => item.id === packageId));
      if (!project) throw new Error(`Station package ${packageId} is not integrated into a project`);
      const proposal = approveStationDesignChange({ deliveryPackage, project, changeId, clock: this.clock });
      this.syncStationPackageToProject(project, deliveryPackage);
      this.adjustConstructionCommitment(project);
      this.refreshProjectSchedules(project.id);
      return proposal;
    });
  }

  rejectStationDesignChange(packageId, changeId, reason) {
    return this.transact("station-design-change-rejected", () => {
      const deliveryPackage = this.requireStationPackage(packageId);
      const project = this.projects.find((entry) => entry.stationDeliveryPackages?.some((item) => item.id === packageId));
      if (!project) throw new Error(`Station package ${packageId} is not integrated into a project`);
      const proposal = rejectStationDesignChange(deliveryPackage, changeId, reason, this.clock);
      this.syncStationPackageToProject(project, deliveryPackage);
      return proposal;
    });
  }

  stationDesignChangeReport(packageId = null) {
    const packages = packageId === null ? this.stationPackages : [this.requireStationPackage(packageId)];
    return packages.flatMap((deliveryPackage) => stationDesignChangeSummary(deliveryPackage));
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
    return this.transact("construction-package-awarded", () => {
      const schedule = this.requireSchedule(scheduleId);
      const awarded = awardConstructionPackage(schedule, constructionSiteId, this.constructionContractors, bidId, this.clock);
      const deliveryPackage = schedule.constructionPackages.find((entry) => entry.constructionSiteId === constructionSiteId);
      const contract = deliveryPackage?.procurement?.contract;
      if (contract) {
        contract.priceIndexBase = this.constructionPriceState.currentIndex;
        contract.lastSettledPriceIndex = this.constructionPriceState.currentIndex;
        awarded.priceIndexBase = contract.priceIndexBase;
        awarded.lastSettledPriceIndex = contract.lastSettledPriceIndex;
      }
      return awarded;
    });
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
      if (priceIndex < this.constructionPriceState.currentIndex) throw new Error("Construction price index cannot move below the current market index");
      if (priceIndex > this.constructionPriceState.currentIndex) {
        const fromIndex = this.constructionPriceState.currentIndex;
        this.constructionPriceState.currentIndex = priceIndex;
        this.constructionPriceState.history.push({
          id: `construction-price:manual:${this.clock.minute}`,
          type: "manual",
          month: Math.floor(this.clock.minute / (30 * 1440)),
          atMinute: this.clock.minute,
          fromIndex,
          toIndex: priceIndex,
          sourceEventId: options.sourceEventId ?? null,
        });
      }
      const schedule = this.requireSchedule(scheduleId);
      const project = this.requireProject(schedule.projectId);
      const settlement = settleConstructionPriceIndex(schedule, project, priceIndex, this.clock, options);
      this.adjustConstructionCommitment(project);
      return settlement;
    });
  }

  constructionFundingReport(projectId = null) {
    return structuredClone(projectId === null ? this.constructionFundingCases : this.constructionFundingCases.filter((entry) => entry.projectId === projectId));
  }

  constructionFinanceReport(projectId = null) {
    return structuredClone(projectId === null ? this.constructionFinancing : this.constructionFinancing.filter((entry) => entry.projectId === projectId));
  }

  constructionFundingOptions(caseId) {
    const fundingCase = this.constructionFundingCases.find((entry) => entry.id === caseId);
    if (!fundingCase) throw new Error(`Unknown construction funding case ${caseId}`);
    return constructionFundingOptions(fundingCase, this.country.id);
  }

  resolveConstructionFundingCase(caseId, optionId) {
    return this.transact("construction-funding-resolved", () => {
      const fundingCase = this.constructionFundingCases.find((entry) => entry.id === caseId);
      if (!fundingCase || !["open", "suspended"].includes(fundingCase.status)) throw new Error(`Construction funding case ${caseId} is not open`);
      const schedule = this.requireSchedule(fundingCase.scheduleId);
      const project = this.requireProject(fundingCase.projectId);
      const preview = this.previewConstructionPriceSettlement(schedule, project, this.constructionPriceState.currentIndex);
      if (preview.ownerAdjustmentJPY <= this.ledger.availableCash + 1e-6) {
        const settlement = settleConstructionPriceIndex(schedule, project, this.constructionPriceState.currentIndex, this.clock, { sourceEventId: fundingCase.sourceEventId ?? null });
        this.adjustConstructionCommitment(project);
        fundingCase.status = "auto-funded";
        fundingCase.resolvedAtMinute = this.clock.minute;
        fundingCase.selectedOptionId = "existing-cash";
        if (fundingCase.suspendedByCase && project.status === "suspended") resumeConstruction(project, this.clock);
        this.syncStationPackageRecords(project);
        this.refreshScheduleRecord(schedule);
        return { fundingCase: structuredClone(fundingCase), option: { id: "existing-cash", label: "기존 가용현금" }, settlement };
      }
      this.updateConstructionFundingCase(fundingCase, schedule, project, preview);
      const option = constructionFundingOptions(fundingCase, this.country.id).find((entry) => entry.id === optionId);
      if (!option) throw new Error(`Unknown construction funding option ${optionId}`);
      if (option.id === "suspend") {
        if (project.status !== "suspended") suspendConstruction(project, "construction-funding-gap", this.clock);
        fundingCase.status = "suspended";
        fundingCase.suspendedByCase = true;
        fundingCase.decisions.push({ optionId, atMinute: this.clock.minute, fundingJPY: 0 });
        this.syncStationPackageRecords(project);
        this.refreshScheduleRecord(schedule);
        return { fundingCase: structuredClone(fundingCase), option: structuredClone(option), settlement: null };
      }

      if (option.id === "construction-loan") {
        this.ledger.post({ atMinute: this.clock.minute, amount: option.debtJPY, category: "construction-finance", reference: fundingCase.id, memo: "Construction loan drawdown" });
        if (option.feeJPY > 0) this.ledger.post({ atMinute: this.clock.minute, amount: -option.feeJPY, category: "construction-finance-fee", reference: fundingCase.id, memo: "Construction loan arrangement fee" });
      } else {
        this.ledger.post({ atMinute: this.clock.minute, amount: option.fundingJPY, category: option.id, reference: fundingCase.id, memo: option.label });
      }
      const finance = createConstructionFinanceRecord({ id: `construction-finance:${this.nextConstructionFinanceSequence++}`, fundingCase, option, atMinute: this.clock.minute });
      this.constructionFinancing.push(finance);
      if (this.scenario) {
        this.scenario.constructionFundingInflowsJPY = (this.scenario.constructionFundingInflowsJPY ?? 0) + finance.raisedJPY;
        if (option.id === "supplementary-budget") this.scenario.supplementaryPublicFundingJPY = (this.scenario.supplementaryPublicFundingJPY ?? 0) + option.fundingJPY;
      }
      if (option.delayMonths > 0) this.delayConstructionForFunding(schedule, option.delayMonths, option.id);
      const settlement = settleConstructionPriceIndex(schedule, project, this.constructionPriceState.currentIndex, this.clock, { sourceEventId: fundingCase.sourceEventId ?? null });
      this.adjustConstructionCommitment(project);
      fundingCase.status = "resolved";
      fundingCase.resolvedAtMinute = this.clock.minute;
      fundingCase.selectedOptionId = option.id;
      fundingCase.financeId = finance.id;
      fundingCase.decisions.push({ optionId: option.id, atMinute: this.clock.minute, fundingJPY: option.fundingJPY, financeId: finance.id });
      if (fundingCase.suspendedByCase && project.status === "suspended") resumeConstruction(project, this.clock);
      this.syncStationPackageRecords(project);
      this.refreshScheduleRecord(schedule);
      return { fundingCase: structuredClone(fundingCase), option: structuredClone(option), finance: structuredClone(finance), settlement };
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
      const cashBeforeJPY = this.ledger.cash;
      this.clock.advance(30 * 1440);
      const infrastructureMaintenance = this.advanceInfrastructureMaintenanceToCurrentDay();
      const operatingFinanceSettlements = [];
      const servicedProjects = new Set();
      for (const service of this.services) {
        if (servicedProjects.has(service.projectId)) continue;
        servicedProjects.add(service.projectId);
        const settlements = settleProjectOperatingFinance({ financing: this.constructionFinancing, projectId: service.projectId, throughMonth: operatingMonthFromMinute(this.clock.minute), ledger: this.ledger, clock: this.clock });
        recordOperatingFinanceSettlements(this.operatingMonthReports, service, settlements);
        this.updateServiceFinancialStatus(service);
        operatingFinanceSettlements.push(...settlements);
      }
      const autoResolvedEvents = this.resolveExpiredConstructionEvents();
      for (const schedule of this.schedules) this.refreshScheduleRecord(schedule);
      const normalPriceChange = advanceConstructionPriceMonth(this.constructionPriceState, this.clock.minute, this.scenario?.difficulty ?? "normal");
      const priceSettlements = this.settleMonthlyConstructionPrices();
      const construction = this.projects.filter((project) => ["contracted", "underConstruction", "inspection", "suspended"].includes(project.status))
        .map((project) => {
          if (project.status === "suspended") return { projectId: project.id, status: project.status, progress: project.progress, progressDelta: 0, payment: 0, blocked: true, reason: "suspended" };
          const fundingCase = this.constructionFundingCases.find((entry) => entry.projectId === project.id && ["open", "suspended"].includes(entry.status));
          if (fundingCase) return { projectId: project.id, status: project.status, progress: project.progress, progressDelta: 0, payment: 0, blocked: true, reason: "construction-funding-gap", fundingCaseId: fundingCase.id };
          const procurement = this.schedules.find((schedule) => schedule.projectId === project.id && schedule.contractorProcurementPrepared && !schedule.contractorProcurementIntegrated);
          if (procurement) return { projectId: project.id, status: project.status, progress: project.progress, progressDelta: 0, payment: 0, blocked: true, reason: "construction-package-procurement" };
          const equipmentBlocked = this.schedules.find((schedule) => schedule.projectId === project.id
            && this.equipmentAssignmentReport(schedule.id).some((assignment) => assignment.status === "assigned" && assignment.placementStatus === "infeasible"));
          if (equipmentBlocked) return { projectId: project.id, status: project.status, progress: project.progress, progressDelta: 0, payment: 0, blocked: true, reason: "equipment-workfront-infeasible" };
          const schedule = this.schedules.find((entry) => entry.projectId === project.id);
          const packageEventsEnabled = Boolean(schedule && (schedule.constructionPackages?.length ?? 0) > 0);
          const gate = integratedConstructionProgressGate(schedule, project);
          const result = advanceConstructionMonth(project, this.ledger, this.clock, this.rng, this.country, { randomRisk: !packageEventsEnabled, progressCap: gate.cap });
          if (project.status === "available") {
            for (const schedule of this.schedules.filter((entry) => entry.projectId === project.id)) {
              for (const deliveryPackage of schedule.constructionPackages ?? []) releaseConstructionPackageContract(deliveryPackage, this.constructionContractors, "completed", this.clock);
            }
          }
          return { projectId: project.id, ...result, gate };
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
      const vehicleRetrofits = this.vehicleRetrofitPrograms
        .filter((program) => ["engineering", "installation", "approval-testing", "retesting"].includes(program.status))
        .map((program) => {
          const result = advanceVehicleRetrofitMonth(program, { ledger: this.ledger, clock: this.clock, rng: this.rng });
          if (result.completed) this.applyApprovedVehicleRetrofit(program.id);
          return { programId: program.id, ...result };
        });
      const throughHandovers = this.throughHandoverProjects
        .filter((project) => ["contracted", "under-construction", "inspection"].includes(project.status))
        .map((project) => {
          const possessionSettlement = project.possessionPlan
            ? settleThroughHandoverPossessionMonth(project.possessionPlan, project, { ledger: this.ledger, clock: this.clock })
            : null;
          const advancement = advanceThroughHandoverProjectMonth(project, {
            ledger: this.ledger,
            clock: this.clock,
            rng: this.rng,
            contractors: this.constructionContractors,
          });
          return { projectId: project.id, possessionSettlement, ...advancement };
        });
      const depots = this.depots.filter((depot) => depot.status === "underConstruction")
        .map((depot) => ({ depotId: depot.id, ...advanceDepotDevelopmentMonth(depot, this.ledger, this.clock, this.rng, this.country) }));
      for (const pool of this.operatingResourcePools) rebalancePool(pool, this.operatingResourceContext());
      let schedules = this.schedules.map((schedule) => integratedScheduleSummary(this.refreshScheduleRecord(schedule)));
      const generatedEvents = [];
      const priceShocks = [];
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
        if (event.kind === "cost-inflation") {
          const points = event.severity === "major" ? 6 : event.severity === "moderate" ? 3 : 1;
          priceShocks.push(applyConstructionPriceShock(this.constructionPriceState, { points, sourceEventId: event.id, atMinute: this.clock.minute }));
        }
        this.refreshScheduleRecord(schedule);
      }
      if (generatedEvents.length) schedules = this.schedules.map((schedule) => integratedScheduleSummary(schedule));
      const cycleReport = createConstructionCycleReport({
        atMinute: this.clock.minute,
        cashBeforeJPY,
        cashAfterJPY: this.ledger.cash,
        construction,
        vehicles,
        depots,
        schedules,
        generatedEvents,
        autoResolvedEvents,
        priceState: this.constructionPriceState,
        normalPriceChange,
        priceShocks,
        priceSettlements,
        fundingCases: this.constructionFundingCases.filter((entry) => ["open", "suspended"].includes(entry.status)),
        operatingFinanceSettlements,
      });
      this.constructionCycleReports.push(cycleReport);
      return { construction, vehicles, vehicleRetrofits, throughHandovers, depots, schedules, generatedEvents, autoResolvedEvents, normalPriceChange, priceShocks, priceSettlements, operatingFinanceSettlements, infrastructureMaintenance, cycleReport: structuredClone(cycleReport) };
    });
  }

  constructionCycleReport(limit = null) {
    const reports = limit === null ? this.constructionCycleReports : this.constructionCycleReports.slice(-Math.max(0, limit));
    return structuredClone(reports);
  }

  startInfrastructureMaintenance(projectId, { assetIds, strategyId } = {}) {
    return this.transact("infrastructure-maintenance-started", () => {
      const project = this.requireProject(projectId);
      if (project.status !== "available") throw new Error("Infrastructure maintenance requires an available project");
      const program = startInfrastructureMaintenance({
        id: `infrastructure-maintenance:${this.nextInfrastructureMaintenanceSequence++}`,
        project,
        assetIds,
        strategyId,
        ledger: this.ledger,
        clock: this.clock,
      });
      this.infrastructureMaintenancePrograms.push(program);
      const service = this.services.find((entry) => entry.projectId === projectId);
      if (service) recordInfrastructureMaintenancePayments(this.operatingMonthReports, service, [{ programId: program.id, projectId, paymentJPY: program.paidJPY, atMinute: this.clock.minute }]);
      return structuredClone(program);
    });
  }

  advanceInfrastructureMaintenanceToCurrentDay() {
    const result = advanceInfrastructureMaintenancePrograms({
      programs: this.infrastructureMaintenancePrograms,
      projects: this.projects,
      throughDay: Math.floor(this.clock.minute / 1440),
      ledger: this.ledger,
      clock: this.clock,
    });
    for (const payment of result.payments) {
      const service = this.services.find((entry) => entry.projectId === payment.projectId);
      if (service) recordInfrastructureMaintenancePayments(this.operatingMonthReports, service, [payment]);
    }
    return structuredClone(result);
  }

  infrastructureMaintenanceImpact(projectId) {
    return infrastructureMaintenanceImpact(this.infrastructureMaintenancePrograms, projectId);
  }

  infrastructureMaintenanceReport(projectId = null) {
    return structuredClone(this.infrastructureMaintenancePrograms.filter((entry) => projectId === null || entry.projectId === projectId));
  }

  operatingResourceContext() {
    return { services: this.services, vehicleOrders: this.vehicleOrders, depots: this.depots };
  }

  createOperatingResourcePool(input) {
    return this.transact("operating-resource-pool-created", () => {
      if (this.operatingResourcePools.some((entry) => entry.id === input.id)) throw new Error(`Duplicate operating resource pool ${input.id}`);
      const pool = buildOperatingResourcePool(input, this.operatingResourceContext());
      this.operatingResourcePools.push(pool);
      rebalancePool(pool, this.operatingResourceContext());
      return structuredClone(pool);
    });
  }

  assignServiceToOperatingResourcePool(serviceId, poolId, options = {}) {
    return this.transact("operating-resource-pool-service-assigned", () => {
      const service = this.services.find((entry) => entry.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const pool = this.operatingResourcePools.find((entry) => entry.id === poolId);
      if (!pool) throw new Error(`Unknown operating resource pool ${poolId}`);
      if (service.resourcePoolId && service.resourcePoolId !== poolId) {
        const previous = this.operatingResourcePools.find((entry) => entry.id === service.resourcePoolId);
        if (previous) removePoolService(previous, serviceId, this.services);
      }
      assignPoolService(pool, service, options, this.operatingResourceContext());
      return buildOperatingResourcePoolReport(pool, this.operatingResourceContext());
    });
  }

  removeServiceFromOperatingResourcePool(serviceId) {
    return this.transact("operating-resource-pool-service-removed", () => {
      const service = this.services.find((entry) => entry.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const pool = this.operatingResourcePools.find((entry) => entry.id === service.resourcePoolId);
      if (!pool) return false;
      const removed = removePoolService(pool, serviceId, this.services);
      rebalancePool(pool, this.operatingResourceContext());
      return removed;
    });
  }

  rebalanceOperatingResourcePool(poolId) {
    return this.transact("operating-resource-pool-rebalanced", () => {
      const pool = this.operatingResourcePools.find((entry) => entry.id === poolId);
      if (!pool) throw new Error(`Unknown operating resource pool ${poolId}`);
      return rebalancePool(pool, this.operatingResourceContext());
    });
  }

  operatingResourcePoolReport(poolId = null) {
    const pools = poolId === null ? this.operatingResourcePools : this.operatingResourcePools.filter((entry) => entry.id === poolId);
    if (poolId !== null && !pools.length) throw new Error(`Unknown operating resource pool ${poolId}`);
    const reports = pools.map((pool) => buildOperatingResourcePoolReport(pool, this.operatingResourceContext()));
    return poolId === null ? reports : reports[0];
  }

  resolveOperatingResources(serviceId) {
    const service = this.services.find((entry) => entry.id === serviceId);
    if (!service) throw new Error(`Unknown service ${serviceId}`);
    const pool = this.operatingResourcePools.find((entry) => entry.id === service.resourcePoolId);
    if (pool) return resolvePoolService(pool, service, this.operatingResourceContext());
    const order = this.vehicleOrders.find((entry) => entry.id === service.vehicleOrderId);
    const depot = this.depots.find((entry) => entry.id === service.depotId);
    if (!depot) throw new Error(`Service ${serviceId} has no depot`);
    return { poolId: null, assignment: null, units: order?.units ?? [], depot, preferredUnitIds: null, maximumStaffedSets: Infinity, warnings: [] };
  }

  announceTrackAccessOpportunity(serviceId, input = {}) {
    return this.transact("track-access-opportunity-announced", () => {
      const service = this.services.find((entry) => entry.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const project = this.requireProject(service.projectId);
      const id = input.id ?? `track-access:${this.nextTrackAccessSequence++}`;
      if (this.trackAccessOpportunities.some((entry) => entry.id === id)) throw new Error(`Duplicate track access opportunity ${id}`);
      const opportunity = buildTrackAccessOpportunity({ ...input, id }, { hostService: service, hostProject: project, atMinute: this.clock.minute });
      this.trackAccessOpportunities.push(opportunity);
      return structuredClone(opportunity);
    });
  }

  solicitTrackAccessOffers(opportunityId) {
    return this.transact("track-access-offers-received", () => {
      const opportunity = this.trackAccessOpportunities.find((entry) => entry.id === opportunityId);
      if (!opportunity) throw new Error(`Unknown track access opportunity ${opportunityId}`);
      return buildTrackAccessOffers(opportunity, this.competitors, this.rng);
    });
  }

  awardTrackAccessOffer(opportunityId, offerId) {
    return this.transact("track-access-agreement-awarded", () => {
      const opportunity = this.trackAccessOpportunities.find((entry) => entry.id === opportunityId);
      if (!opportunity) throw new Error(`Unknown track access opportunity ${opportunityId}`);
      const agreement = buildTrackAccessAgreement(opportunity, offerId, {
        agreements: this.trackAccessAgreements,
        competitors: this.competitors,
        startDay: Math.floor(this.clock.minute / 1440),
        hostTrainsPerHour: this.services.find((entry) => entry.id === opportunity.hostServiceId)?.trainsPerHour,
      });
      this.trackAccessAgreements.push(agreement);
      return structuredClone(agreement);
    });
  }

  setTrackAccessAgreementStatus(agreementId, status) {
    return this.transact(`track-access-agreement-${status}`, () => {
      const agreement = this.trackAccessAgreements.find((entry) => entry.id === agreementId);
      if (!agreement) throw new Error(`Unknown track access agreement ${agreementId}`);
      const changed = changeTrackAccessStatus(agreement, status, this.competitors, Math.floor(this.clock.minute / 1440));
      this.synchronizeThroughServicesForTrackAccess(agreement);
      return changed;
    });
  }

  synchronizeThroughServicesForTrackAccess(agreement) {
    const linked = this.throughServices.filter((service) => (service.trackAccessAgreementIds ?? []).includes(agreement.id));
    for (const service of linked) {
      if (agreement.status === "suspended" && service.status === "approved") {
        service.status = "suspended";
        service.suspendedByTrackAccess = true;
        service.statusChangedAtMinute = this.clock.minute;
      } else if (agreement.status === "active" && service.status === "suspended" && service.suspendedByTrackAccess === true) {
        const everyAgreementActive = service.trackAccessAgreementIds.every((id) => this.trackAccessAgreements.find((entry) => entry.id === id)?.status === "active");
        if (everyAgreementActive) {
          service.status = "approved";
          delete service.suspendedByTrackAccess;
          service.statusChangedAtMinute = this.clock.minute;
        }
      } else if (["terminated", "expired"].includes(agreement.status) && service.status !== "terminated") {
        service.status = "terminated";
        service.terminatedByTrackAccessAgreementId = agreement.id;
        service.statusChangedAtMinute = this.clock.minute;
        service.terminatedAtMinute = this.clock.minute;
        delete service.suspendedByTrackAccess;
      }
    }
  }

  trackAccessImpact(serviceId) {
    const service = this.services.find((entry) => entry.id === serviceId);
    if (!service) throw new Error(`Unknown service ${serviceId}`);
    return calculateTrackAccessImpact(this.trackAccessAgreements, serviceId, service.trainsPerHour);
  }

  trackAccessReport(serviceId = null) {
    return {
      opportunities: structuredClone(this.trackAccessOpportunities.filter((entry) => serviceId === null || entry.hostServiceId === serviceId)),
      agreements: structuredClone(this.trackAccessAgreements.filter((entry) => serviceId === null || entry.hostServiceId === serviceId)),
      impacts: Object.fromEntries(this.services.filter((entry) => serviceId === null || entry.id === serviceId).map((service) => [service.id, this.trackAccessImpact(service.id)])),
    };
  }

  settleTrackAccessForService(serviceId, throughDay, operatingDays = null) {
    if (!(this._transactionDepth > 0)) throw new Error("Track access settlement requires an active game transaction");
    const settlement = settleTrackAccessRevenue(this.trackAccessAgreements, serviceId, throughDay, this.competitors, operatingDays);
    for (const agreement of this.trackAccessAgreements.filter((entry) => entry.hostServiceId === serviceId && entry.status === "expired")) {
      this.synchronizeThroughServicesForTrackAccess(agreement);
    }
    return settlement;
  }

  assessRailwayTimetable(input = {}) {
    return this.transact("railway-timetable-assessed", () => {
      while (this.railwayTimetables.some((entry) => entry.id === `railway-timetable:${this.nextRailwayTimetableSequence}`)) this.nextRailwayTimetableSequence += 1;
      const id = input.id ?? `railway-timetable:${this.nextRailwayTimetableSequence++}`;
      if (this.railwayTimetables.some((entry) => entry.id === id)) throw new Error(`Duplicate railway timetable ${id}`);
      const numericId = Number(String(id).match(/^railway-timetable:(\d+)$/)?.[1]);
      if (Number.isInteger(numericId)) this.nextRailwayTimetableSequence = Math.max(this.nextRailwayTimetableSequence, numericId + 1);
      const timetable = buildRailwayTimetable({ ...input, id, atMinute: this.clock.minute });
      this.railwayTimetables.push(timetable);
      return structuredClone(timetable);
    });
  }

  approveRailwayTimetable(timetableId) {
    return this.transact("railway-timetable-approved", () => approveRailwayTimetable(this.requireRailwayTimetable(timetableId), this.clock.minute));
  }

  activateRailwayTimetable(timetableId) {
    return this.transact("railway-timetable-activated", () => activateRailwayTimetable(
      this.requireRailwayTimetable(timetableId), this.services, this.throughServices, this.railwayTimetables, this.clock.minute,
    ));
  }

  // Assessed or approved timetables that will not be used are withdrawn (a state transition, never a deletion); see withdrawRailwayTimetable.
  withdrawRailwayTimetable(timetableId, input = {}) {
    return this.transact("railway-timetable-withdrawn", () => withdrawRailwayTimetable(this.requireRailwayTimetable(timetableId), this.clock.minute, input?.reason ?? null));
  }

  // --- B19-E1: new-town developments.  Management facts only: no money moves, nothing is drawn from the random generator, and the map's
  // geometry is a read-only plain object handed in by the caller (`geometry`), never stored by reference. ---
  allocateNewTownDevelopmentId() {
    while (this.newTownDevelopments.some((entry) => entry.id === `new-town-development:${this.nextNewTownDevelopmentSequence}`)) this.nextNewTownDevelopmentSequence += 1;
    return `new-town-development:${this.nextNewTownDevelopmentSequence++}`;
  }

  // Read-only: what blocks each step. input: { id?, geometry? }.
  assessNewTownDevelopment(input = {}) {
    const record = input.id === undefined || input.id === null ? null : this.requireNewTownDevelopment(input.id);
    return assessNewTownDevelopmentRecord({ geometry: input.geometry ?? null, record, others: this.newTownDevelopments });
  }

  draftNewTownDevelopment(input = {}) {
    return this.transact("new-town-development-drafted", () => {
      const record = createNewTownDevelopmentDraft({ id: this.allocateNewTownDevelopmentId(), input, atMinute: this.clock.minute, others: this.newTownDevelopments });
      this.newTownDevelopments.push(record);
      return structuredClone(record);
    });
  }

  // input.id names an existing draft; without it a development is drafted and proposed in one step. input.geometry is required.
  proposeNewTownDevelopment(input = {}) {
    return this.transact("new-town-development-proposed", () => {
      let record;
      if (input.id !== undefined && input.id !== null) record = this.requireNewTownDevelopment(input.id);
      else {
        record = createNewTownDevelopmentDraft({ id: this.allocateNewTownDevelopmentId(), input, atMinute: this.clock.minute, others: this.newTownDevelopments });
        this.newTownDevelopments.push(record);
      }
      return proposeNewTownDevelopmentRecord(record, { geometry: input.geometry ?? null, atMinute: this.clock.minute });
    });
  }

  agreeNewTownDevelopment(id, agreement, context = {}) {
    return this.transact("new-town-development-agreed", () => agreeNewTownDevelopmentRecord(this.requireNewTownDevelopment(id), agreement, { geometry: context?.geometry ?? null, atMinute: this.clock.minute }));
  }

  startNewTownServicing(id, context = {}) {
    return this.transact("new-town-development-servicing-started", () => startNewTownServicingRecord(this.requireNewTownDevelopment(id), { geometry: context?.geometry ?? null, phaseIds: context?.phaseIds ?? null, atMinute: this.clock.minute }));
  }

  recordNewTownOccupancy(id, phaseId, facts, context = {}) {
    return this.transact("new-town-development-occupancy-recorded", () => recordNewTownOccupancyRecord(this.requireNewTownDevelopment(id), phaseId, facts, { geometry: context?.geometry ?? null, atMinute: this.clock.minute }));
  }

  delayNewTownDevelopment(id, reason) {
    return this.transact("new-town-development-delayed", () => delayNewTownDevelopmentRecord(this.requireNewTownDevelopment(id), reason, this.clock.minute));
  }

  resumeNewTownDevelopment(id, context = {}) {
    return this.transact("new-town-development-resumed", () => resumeNewTownDevelopmentRecord(this.requireNewTownDevelopment(id), { geometry: context?.geometry ?? null, atMinute: this.clock.minute }));
  }

  cancelNewTownDevelopment(id, reason) {
    return this.transact("new-town-development-cancelled", () => cancelNewTownDevelopmentRecord(this.requireNewTownDevelopment(id), reason, this.clock.minute));
  }

  newTownDevelopmentReport(id = null) {
    return structuredClone(this.newTownDevelopments.filter((entry) => id === null || entry.id === id));
  }

  // stable ids and the stated facts a later demand / event bridge reads (see new-town-development.mjs)
  newTownDevelopmentHooks(id) {
    return buildNewTownDevelopmentHooks(this.requireNewTownDevelopment(id));
  }

  // --- B19-E3: new-town rail contributions.  The amounts, parties, conditions and links are only what the caller states.  An agreement or a
  // payer's confirmed payment moves no cash; only `release` posts to the ledger, once, inside the transaction.  The map's geometry and the
  // host's list of current plans / station sites are read-only plain objects handed in per call (`context.geometry`, `context.currentLinks`). ---
  allocateNewTownRailContributionId() {
    while (this.newTownRailContributions.some((entry) => entry.contributionId === `new-town-rail-contribution:${this.nextNewTownRailContributionSequence}`)) this.nextNewTownRailContributionSequence += 1;
    return `new-town-rail-contribution:${this.nextNewTownRailContributionSequence++}`;
  }

  newTownRailContributionContext(record, context = {}) {
    return {
      development: this.newTownDevelopments.find((entry) => entry.id === record.developmentRecordId) ?? null,
      geometry: context?.geometry ?? null,
      projects: this.projects.map((project) => ({ id: project.id, status: project.status })),
      currentLinks: context?.currentLinks ?? null,
      terms: context?.terms,
      confirmation: context?.confirmation,
      conditionConfirmations: context?.conditionConfirmations,
    };
  }

  // Read-only: what blocks each step and what a release would do to the ledger. input: { id, geometry?, currentLinks?, terms?, confirmation?, conditionConfirmations? }.
  assessNewTownRailContribution(input = {}) {
    const record = this.requireNewTownRailContribution(input?.id);
    return assessContribution(record, this.newTownRailContributionContext(record, input));
  }

  // input: { developmentRecordId, payerKind, payeeKind, statedPurpose, statedAmountYen?, phaseIds?, linkedProjectIds?, linkedPlanIds?, linkedStationSiteIds?, conditions?, name? }
  draftNewTownRailContribution(input = {}) {
    return this.transact("new-town-rail-contribution-drafted", () => {
      const development = this.newTownDevelopments.find((entry) => entry.id === input?.developmentRecordId);
      if (!development) throw new Error(`Unknown new town development ${input?.developmentRecordId}`);
      const record = createContributionDraft({ id: this.allocateNewTownRailContributionId(), input, development, atMinute: this.clock.minute });
      this.newTownRailContributions.push(record);
      return structuredClone(record);
    });
  }

  proposeNewTownRailContribution(id, context = {}) {
    return this.transact("new-town-rail-contribution-proposed", () => {
      const record = this.requireNewTownRailContribution(id);
      return proposeContributionRecord(record, this.newTownRailContributionContext(record, context), this.clock.minute);
    });
  }

  // terms: { statedAmountYen?, conditions? } - what the draft did not state yet; both must be stated by now
  agreeNewTownRailContribution(id, terms = {}, context = {}) {
    return this.transact("new-town-rail-contribution-agreed", () => {
      const record = this.requireNewTownRailContribution(id);
      return agreeContributionRecord(record, terms, this.newTownRailContributionContext(record, context), this.clock.minute);
    });
  }

  // confirmation: { confirmedAmountYen, confirmedBy, reference } - the payer's confirmed payment, recorded as a fact; no cash moves
  fundNewTownRailContribution(id, confirmation, context = {}) {
    return this.transact("new-town-rail-contribution-funded", () => {
      const record = this.requireNewTownRailContribution(id);
      return fundContributionRecord(record, confirmation, this.newTownRailContributionContext(record, context), this.clock.minute);
    });
  }

  // context: { geometry, currentLinks, conditionConfirmations: [{conditionId, note?}] } - the only step that can post to the ledger
  releaseNewTownRailContribution(id, context = {}) {
    return this.transact("new-town-rail-contribution-released", () => {
      const record = this.requireNewTownRailContribution(id);
      const atMinute = this.clock.minute;
      return releaseContributionRecord(record, this.newTownRailContributionContext(record, context), {
        atMinute,
        post: (amount, memo) => {
          if (this.ledger.entries.some((entry) => entry.category === NEW_TOWN_RAIL_CONTRIBUTION_LEDGER_CATEGORY && entry.reference === record.contributionId)) throw new Error(`Contribution ${record.contributionId} already has a ledger entry`);
          return this.ledger.post({ atMinute, amount, category: NEW_TOWN_RAIL_CONTRIBUTION_LEDGER_CATEGORY, reference: record.contributionId, memo }).id;
        },
      });
    });
  }

  delayNewTownRailContribution(id, reason) {
    return this.transact("new-town-rail-contribution-delayed", () => delayContributionRecord(this.requireNewTownRailContribution(id), reason, this.clock.minute));
  }

  resumeNewTownRailContribution(id, context = {}) {
    return this.transact("new-town-rail-contribution-resumed", () => {
      const record = this.requireNewTownRailContribution(id);
      return resumeContributionRecord(record, this.newTownRailContributionContext(record, context), this.clock.minute);
    });
  }

  terminateNewTownRailContribution(id, reason) {
    return this.transact("new-town-rail-contribution-terminated", () => terminateContributionRecord(this.requireNewTownRailContribution(id), reason, this.clock.minute));
  }

  newTownRailContributionReport(id = null) {
    return structuredClone(this.newTownRailContributions.filter((entry) => id === null || entry.contributionId === id));
  }

  newTownRailContributionHooks(id) {
    return buildNewTownRailContributionHooks(this.requireNewTownRailContribution(id));
  }

  // --- B19-E4: the player's decision about a new-town demand candidate (B19-E2).  Only a record of the decision: nothing here reads or changes
  // B15 state, creates a demand node, draws a random number, advances the clock or moves money.  The map's geometry is a read-only plain
  // object handed in per call (`input.geometry`); the lifecycle record named by `developmentRecordId` is the one the candidates are read from. ---
  allocateNewTownDemandIntakeId() {
    while (this.newTownDemandIntakes.some((entry) => entry.id === `new-town-demand-intake:${this.nextNewTownDemandIntakeSequence}`)) this.nextNewTownDemandIntakeSequence += 1;
    return `new-town-demand-intake:${this.nextNewTownDemandIntakeSequence++}`;
  }

  // Read-only: every candidate of the development with its decision state, standing and what blocks each decision.
  // input: { developmentRecordId, geometry?, candidateId?, statedDemandFactIds? }
  assessNewTownDemandIntake(input = {}) {
    return assessNewTownDemandIntakeRecord({
      development: this.requireNewTownDevelopment(input?.developmentRecordId), geometry: input?.geometry ?? null, intakes: this.newTownDemandIntakes,
      candidateId: input?.candidateId ?? null, statedDemandFactIds: input?.statedDemandFactIds,
    });
  }

  // input: { developmentRecordId, candidateId, statedDemandFactIds, geometry, note? }
  acceptNewTownDemandCandidate(input = {}) {
    return this.transact("new-town-demand-candidate-accepted", () => decideNewTownDemandCandidate("accept", {
      development: this.requireNewTownDevelopment(input?.developmentRecordId), geometry: input?.geometry ?? null, intakes: this.newTownDemandIntakes,
      candidateId: input?.candidateId, statedDemandFactIds: input?.statedDemandFactIds, note: input?.note,
      allocateId: () => this.allocateNewTownDemandIntakeId(), atMinute: this.clock.minute,
    }));
  }

  // input: { developmentRecordId, candidateId, reason, geometry? }
  holdNewTownDemandCandidate(input = {}) {
    return this.transact("new-town-demand-candidate-held", () => decideNewTownDemandCandidate("hold", {
      development: this.requireNewTownDevelopment(input?.developmentRecordId), geometry: input?.geometry ?? null, intakes: this.newTownDemandIntakes,
      candidateId: input?.candidateId, reason: input?.reason, allocateId: () => this.allocateNewTownDemandIntakeId(), atMinute: this.clock.minute,
    }));
  }

  rejectNewTownDemandCandidate(input = {}) {
    return this.transact("new-town-demand-candidate-rejected", () => decideNewTownDemandCandidate("reject", {
      development: this.requireNewTownDevelopment(input?.developmentRecordId), geometry: input?.geometry ?? null, intakes: this.newTownDemandIntakes,
      candidateId: input?.candidateId, reason: input?.reason, allocateId: () => this.allocateNewTownDemandIntakeId(), atMinute: this.clock.minute,
    }));
  }

  // id: the intake record's id.  An acceptance can always be withdrawn: the map is not needed.
  revokeNewTownDemandCandidate(id, reason) {
    return this.transact("new-town-demand-candidate-revoked", () => revokeNewTownDemandIntakeRecord(this.requireNewTownDemandIntake(id), reason, this.clock.minute));
  }

  // Read-only copies, each with its `standing` now.  context: { geometry? }; without a geometry an acceptance is at best "unverified".
  newTownDemandIntakeReport(id = null, context = {}) {
    return buildNewTownDemandIntakeReport({ intakes: this.newTownDemandIntakes, developments: this.newTownDevelopments, geometry: context?.geometry ?? null, id });
  }

  // B20-E1. These records are deliberately separate from the map's programId.
  // The map is supplied on each forward transition so a stale drawing cannot be
  // silently adopted, monitored, completed, or used to reach a milestone.
  allocateCampaignProgramId() {
    while (this.campaignPrograms.some((entry) => entry.id === `campaign-program:${this.nextCampaignProgramSequence}`)) this.nextCampaignProgramSequence += 1;
    return `campaign-program:${this.nextCampaignProgramSequence++}`;
  }

  requireCampaignProgram(id) {
    const record = this.campaignPrograms.find((entry) => entry.id === id);
    if (!record) throw new Error(`Unknown campaign program ${id}`);
    return record;
  }

  assessCampaignProgram(input = {}) {
    return assessCampaignProgramRecord({ geometry: input.geometry ?? null, record: input.id ? this.requireCampaignProgram(input.id) : null });
  }

  draftCampaignProgram(input = {}) {
    return this.transact("campaign-program-drafted", () => {
      const record = createCampaignProgramDraft({ id: this.allocateCampaignProgramId(), input, atMinute: this.clock.minute });
      this.campaignPrograms.push(record); return record;
    }, campaignProgramEvent);
  }

  adoptCampaignProgram(id, context = {}) {
    return this.transact("campaign-program-adopted", () => adoptCampaignProgram(this.requireCampaignProgram(id), { geometry: context.geometry ?? null, atMinute: this.clock.minute }), campaignProgramEvent);
  }

  monitorCampaignProgram(id, context = {}) {
    return this.transact("campaign-program-monitoring", () => monitorCampaignProgram(this.requireCampaignProgram(id), { geometry: context.geometry ?? null, atMinute: this.clock.minute }), campaignProgramEvent);
  }

  completeCampaignProgram(id, context = {}) {
    return this.transact("campaign-program-completed", () => completeCampaignProgram(this.requireCampaignProgram(id), { geometry: context.geometry ?? null, atMinute: this.clock.minute }), campaignProgramEvent);
  }

  delayCampaignProgram(id, reason) {
    return this.transact("campaign-program-delayed", () => delayCampaignProgram(this.requireCampaignProgram(id), reason, { atMinute: this.clock.minute }), campaignProgramEvent);
  }

  resumeCampaignProgram(id, context = {}) {
    return this.transact("campaign-program-resumed", () => resumeCampaignProgram(this.requireCampaignProgram(id), { geometry: context.geometry ?? null, atMinute: this.clock.minute }), campaignProgramEvent);
  }

  cancelCampaignProgram(id, reason) {
    return this.transact("campaign-program-cancelled", () => cancelCampaignProgram(this.requireCampaignProgram(id), reason, { atMinute: this.clock.minute }), campaignProgramEvent);
  }

  reachCampaignMilestone(id, milestoneId, observedRefs = [], context = {}) {
    return this.transact("campaign-milestone-reached", () => reachCampaignMilestone(this.requireCampaignProgram(id), milestoneId, observedRefs, { geometry: context.geometry ?? null, atMinute: this.clock.minute }), (record) => ({ ...campaignProgramEvent(record), milestoneId }));
  }

  campaignProgramReport(id = null) {
    return structuredClone(this.campaignPrograms.filter((entry) => id === null || entry.id === id));
  }

  campaignProgramHooks(id) {
    return buildCampaignProgramHooks(this.requireCampaignProgram(id));
  }

  allocateCampaignActivationId() {
    while (this.campaignActivations.some((entry) => entry.activationId === `campaign-activation:${this.nextCampaignActivationSequence}`)) this.nextCampaignActivationSequence += 1;
    return `campaign-activation:${this.nextCampaignActivationSequence++}`;
  }

  assessCampaignActivation(input = {}) {
    const activation = input.activationId ? this.campaignActivations.find((entry) => entry.activationId === input.activationId) ?? null : null;
    const program = input.programId ? this.campaignPrograms.find((entry) => entry.programId === input.programId) ?? null : activation ? this.campaignPrograms.find((entry) => entry.programId === activation.programId) ?? null : null;
    return assessCampaignActivationRecord({ activation, program, geometry: input.geometry ?? null, intakes: input.intakes ?? [], sources: input.sources ?? [] });
  }

  recordCampaignActivation(input = {}) {
    return this.transact("campaign-activation-recorded", () => {
      const program = this.requireCampaignProgram(input.campaignProgramId);
      if (this.campaignActivations.some((entry) => entry.status === "recorded" && entry.programId === program.programId && entry.milestoneId === input.milestoneId && entry.refs.demandSourceId === input.demandSourceId)) throw new Error("Campaign activation already exists for this milestone and demand source");
      const record = createCampaignActivation({ id: this.allocateCampaignActivationId(), program, milestoneId: input.milestoneId, intakeId: input.intakeId, demandSourceId: input.demandSourceId, geometry: input.geometry ?? null, intakes: input.intakes ?? [], sources: input.sources ?? [], atMinute: this.clock.minute });
      this.campaignActivations.push(record); return record;
    }, campaignActivationEvent);
  }

  withdrawCampaignActivation(id, reason) {
    return this.transact("campaign-activation-withdrawn", () => {
      const record = this.campaignActivations.find((entry) => entry.activationId === id);
      if (!record) throw new Error(`Unknown campaign activation ${id}`);
      return withdrawCampaignActivation(record, reason, this.clock.minute);
    }, campaignActivationEvent);
  }

  campaignActivationReport(context = {}) {
    return structuredClone(this.campaignActivations.map((activation) => {
      const program = this.campaignPrograms.find((entry) => entry.programId === activation.programId) ?? null;
      const assessment = assessCampaignActivationRecord({ activation, program, geometry: context.geometry ?? null, intakes: context.intakes ?? [], sources: context.sources ?? [] });
      return { ...activation, standing: assessment };
    }));
  }

  railwayTimetableReport(timetableId = null) {
    return structuredClone(this.railwayTimetables.filter((entry) => timetableId === null || entry.id === timetableId));
  }

  proposeThroughHandoverProject(site, input = {}) {
    return this.transact("through-handover-project-proposed", () => {
      const duplicate = this.throughHandoverProjects.find((entry) => entry.throughRouteId === site?.throughRouteId
        && entry.routeGeometryRevision === site?.routeGeometryRevision
        && entry.handoverId === site?.handoverId
        && !["cancelled"].includes(entry.status));
      if (duplicate) throw new Error(`Through handover ${site.handoverId} already has project ${duplicate.id}`);
      while (this.throughHandoverProjects.some((entry) => entry.id === `through-handover-project:${this.nextThroughHandoverProjectSequence}`)) this.nextThroughHandoverProjectSequence += 1;
      const id = input.id ?? `through-handover-project:${this.nextThroughHandoverProjectSequence++}`;
      if (this.throughHandoverProjects.some((entry) => entry.id === id)) throw new Error(`Duplicate through handover project ${id}`);
      const numericId = Number(String(id).match(/^through-handover-project:(\d+)$/)?.[1]);
      if (Number.isInteger(numericId)) this.nextThroughHandoverProjectSequence = Math.max(this.nextThroughHandoverProjectSequence, numericId + 1);
      const project = createThroughHandoverProject({ ...input, id, site, countryProfile: this.country, atMinute: this.clock.minute });
      this.throughHandoverProjects.push(project);
      return structuredClone(project);
    });
  }

  grantThroughHandoverPermission(projectId, ownerId) {
    return this.transact("through-handover-permission-granted", () => grantThroughHandoverPermission(this.requireThroughHandoverProject(projectId), ownerId, this.clock.minute));
  }

  planThroughHandoverPossession(projectId, input = {}) {
    return this.transact("through-handover-possession-planned", () => {
      const project = this.requireThroughHandoverProject(projectId);
      if (project.possessionPlan) throw new Error(`Through handover project ${projectId} already has a possession plan`);
      const affectedServiceIds = [...new Set((input.affectedServiceIds ?? []).map(String))].sort();
      const baselineDailyRevenueJPYByService = { ...(input.baselineDailyRevenueJPYByService ?? {}) };
      for (const serviceId of affectedServiceIds) {
        const service = this.services.find((entry) => entry.id === serviceId);
        if (!service) throw new Error(`Unknown affected service ${serviceId}`);
        if (Number.isFinite(Number(baselineDailyRevenueJPYByService[serviceId]))) continue;
        const latest = this.operatingMonthReports.filter((entry) => entry.serviceId === serviceId && entry.days > 0).sort((a, b) => b.month - a.month)[0];
        const fromReport = latest ? latest.operatingIncomeJPY / latest.days : null;
        const fromTotals = service.daysOperated > 0 && Number.isFinite(service.totals?.revenue) ? service.totals.revenue / service.daysOperated : null;
        const baseline = Number.isFinite(fromReport) ? fromReport : fromTotals;
        if (!Number.isFinite(baseline)) throw new Error(`No operating revenue baseline is available for ${serviceId}`);
        baselineDailyRevenueJPYByService[serviceId] = baseline;
      }
      project.possessionPlan = createThroughHandoverPossessionPlan({
        id: `through-handover-possession:${project.id}`,
        project,
        strategyId: input.strategyId,
        affectedServiceIds,
        baselineDailyRevenueJPYByService,
        atMinute: this.clock.minute,
      });
      return structuredClone(project.possessionPlan);
    });
  }

  throughHandoverPossessionImpact(serviceId) {
    return calculateThroughHandoverPossessionImpact(this.throughHandoverProjects, serviceId);
  }

  tenderThroughHandoverProject(projectId, options = {}) {
    return this.transact("through-handover-project-tendered", () => tenderThroughHandoverProject(
      this.requireThroughHandoverProject(projectId), this.constructionContractors, this.rng, options, this.clock.minute,
    ));
  }

  awardThroughHandoverProject(projectId, bidId = null) {
    return this.transact("through-handover-project-awarded", () => awardThroughHandoverProject(
      this.requireThroughHandoverProject(projectId), this.constructionContractors, bidId, { ledger: this.ledger, clock: this.clock },
    ));
  }

  cancelThroughHandoverProject(projectId) {
    return this.transact("through-handover-project-cancelled", () => cancelThroughHandoverProject(
      this.requireThroughHandoverProject(projectId), { ledger: this.ledger, clock: this.clock, contractors: this.constructionContractors },
    ));
  }

  throughHandoverProjectReport(throughRouteId = null) {
    return structuredClone(this.throughHandoverProjects.filter((entry) => throughRouteId === null || entry.throughRouteId === throughRouteId));
  }

  createThroughService(route, input = {}, infrastructureCatalog = []) {
    return this.transact("through-service-created", () => {
      const generated = !input.throughServiceId;
      if (generated) while (this.throughServices.some((entry) => entry.throughServiceId === `through-service:${this.nextThroughServiceSequence}`)) this.nextThroughServiceSequence += 1;
      const throughServiceId = input.throughServiceId ?? `through-service:${this.nextThroughServiceSequence}`;
      if (this.throughServices.some((entry) => entry.throughServiceId === throughServiceId)) throw new Error(`Duplicate through service ${throughServiceId}`);
      const service = buildThroughService({ ...input, throughServiceId, status: "assessed", vehicleTechnicalOverrides: {}, approvedRetrofitProgramIds: [] }, {
        route,
        projects: this.projects,
        infrastructureCatalog,
        trackAccessAgreements: this.trackAccessAgreements,
        throughHandoverConfirmations: activeThroughHandoverConfirmations(this.throughHandoverProjects),
        playerOperatorId: this.player.id,
      });
      if (generated) this.nextThroughServiceSequence += 1;
      else {
        const numericId = Number(throughServiceId.match(/^through-service:(\d+)$/)?.[1]);
        if (Number.isInteger(numericId)) this.nextThroughServiceSequence = Math.max(this.nextThroughServiceSequence, numericId + 1);
      }
      this.throughServices.push(service);
      return structuredClone(service);
    });
  }

  reassessThroughService(throughServiceId, route, infrastructureCatalog = []) {
    return this.transact("through-service-reassessed", () => {
      const current = this.requireThroughService(throughServiceId);
      if (route?.throughRouteId !== current.throughRouteId) throw new Error("Through service route identity does not match");
      const sameRevision = route.geometryRevision === current.routeGeometryRevision;
      const reassessed = buildThroughService({
        throughServiceId,
        status: current.status,
        operatorId: current.operatorId,
        guestModelId: current.guestModelId,
        trainsPerHour: current.trainsPerHour,
        trackAccessAgreementIds: current.trackAccessAgreementIds,
        vehicleTechnicalOverrides: current.vehicleTechnicalOverrides,
        approvedRetrofitProgramIds: current.approvedRetrofitProgramIds,
      }, {
        route,
        projects: this.projects,
        infrastructureCatalog,
        trackAccessAgreements: this.trackAccessAgreements,
        throughHandoverConfirmations: activeThroughHandoverConfirmations(this.throughHandoverProjects),
        playerOperatorId: this.player.id,
      });
      const revisionSignature = (service) => JSON.stringify(service.legs.map((leg) => [leg.legId, leg.externalSpecificationId ?? null, leg.externalSpecificationRevision ?? null]));
      const sameSpecificationRevisions = revisionSignature(reassessed) === revisionSignature(current);
      if (current.throughOperatingTotals) reassessed.throughOperatingTotals = structuredClone(current.throughOperatingTotals);
      if (current.lastThroughOperatingDay !== undefined) reassessed.lastThroughOperatingDay = current.lastThroughOperatingDay;
      if (!sameRevision || !sameSpecificationRevisions) reassessed.status = "assessed";
      if (reassessed.status === "approved" && reassessed.assessment.verdict !== "possible") reassessed.status = "assessed";
      if (reassessed.assessment.verdict === "possible") delete reassessed.retrofitReassessmentRequired;
      this.throughServices[this.throughServices.indexOf(current)] = reassessed;
      if (reassessed.status !== "approved") {
        for (const agreement of this.throughFareAgreements.filter((entry) => entry.throughServiceId === throughServiceId && entry.status === "active")) {
          changeThroughFareStatus(agreement, "suspended", this.clock.minute);
          agreement.suspendedByThroughService = true;
        }
      }
      return structuredClone(reassessed);
    });
  }

  approveThroughService(throughServiceId) {
    return this.transact("through-service-approved", () => {
      const service = this.requireThroughService(throughServiceId);
      if (service.status !== "assessed") throw new Error(`Through service cannot be approved from ${service.status}`);
      if (service.assessment.verdict !== "possible") throw new Error(`Through service assessment is ${service.assessment.verdict}`);
      service.status = "approved";
      service.approvedAtMinute = this.clock.minute;
      return structuredClone(service);
    });
  }

  setThroughServiceStatus(throughServiceId, status) {
    return this.transact(`through-service-${status}`, () => {
      const service = this.requireThroughService(throughServiceId);
      const allowed = service.status === "approved"
        ? ["suspended", "terminated"]
        : service.status === "suspended"
          ? ["approved", "terminated"]
          : [];
      if (!allowed.includes(status)) throw new Error(`Through service cannot change from ${service.status} to ${status}`);
      const agreements = service.trackAccessAgreementIds.map((id) => {
        const agreement = this.trackAccessAgreements.find((entry) => entry.id === id);
        if (!agreement) throw new Error(`Unknown linked track access agreement ${id}`);
        return agreement;
      });
      const atDay = Math.floor(this.clock.minute / 1440);
      for (const agreement of agreements) {
        if (status === "suspended") {
          if (agreement.status !== "active") throw new Error(`Track access agreement ${agreement.id} cannot suspend from ${agreement.status}`);
          changeTrackAccessStatus(agreement, "suspended", this.competitors, atDay);
        } else if (status === "approved") {
          if (agreement.status !== "suspended") throw new Error(`Track access agreement ${agreement.id} cannot resume from ${agreement.status}`);
          changeTrackAccessStatus(agreement, "active", this.competitors, atDay);
        } else if (status === "terminated") {
          if (!["active", "suspended"].includes(agreement.status)) throw new Error(`Track access agreement ${agreement.id} cannot terminate from ${agreement.status}`);
          changeTrackAccessStatus(agreement, "terminated", this.competitors, atDay);
        }
        this.synchronizeThroughServicesForTrackAccess(agreement);
      }
      service.status = status;
      service.statusChangedAtMinute = this.clock.minute;
      if (status === "suspended") service.suspendedByTrackAccess = agreements.length > 0;
      else delete service.suspendedByTrackAccess;
      if (status === "terminated") service.terminatedAtMinute = this.clock.minute;
      for (const fareAgreement of this.throughFareAgreements.filter((entry) => entry.throughServiceId === throughServiceId)) {
        if (status === "suspended" && fareAgreement.status === "active") {
          changeThroughFareStatus(fareAgreement, "suspended", this.clock.minute);
          fareAgreement.suspendedByThroughService = true;
        }
        if (status === "approved" && fareAgreement.status === "suspended" && fareAgreement.suspendedByThroughService) {
          activateFareAgreement(fareAgreement, service, this.clock.minute);
          delete fareAgreement.suspendedByThroughService;
        }
        if (status === "terminated" && fareAgreement.status !== "terminated") changeThroughFareStatus(fareAgreement, "terminated", this.clock.minute);
      }
      return structuredClone(service);
    });
  }

  throughServiceReport(throughServiceId = null) {
    return structuredClone(this.throughServices.filter((entry) => throughServiceId === null || entry.throughServiceId === throughServiceId));
  }

  proposeThroughFareAgreement(throughServiceId, input = {}) {
    return this.transact("through-fare-proposed", () => {
      const service = this.requireThroughService(throughServiceId);
      if (service.operatorId !== this.player.id) throw new Error("Only a player-operated through service can negotiate a player fare agreement");
      if (service.status === "terminated") throw new Error("A terminated through service cannot have a fare agreement");
      if (this.throughFareAgreements.some((entry) => entry.throughServiceId === throughServiceId && entry.status !== "terminated")) {
        throw new Error("Through service already has an open fare agreement");
      }
      while (this.throughFareAgreements.some((entry) => entry.id === `through-fare:${this.nextThroughFareSequence}`)) this.nextThroughFareSequence += 1;
      const id = input.id ?? `through-fare:${this.nextThroughFareSequence++}`;
      if (this.throughFareAgreements.some((entry) => entry.id === id)) throw new Error(`Duplicate through fare agreement ${id}`);
      const numericId = Number(String(id).match(/^through-fare:(\d+)$/)?.[1]);
      if (Number.isInteger(numericId)) this.nextThroughFareSequence = Math.max(this.nextThroughFareSequence, numericId + 1);
      const agreement = createThroughFareAgreement({ ...input, id, throughService: service, atMinute: this.clock.minute });
      if (!agreement.participants.some((entry) => entry.operatorId === this.player.id)) throw new Error("Player must be a fare agreement participant");
      this.throughFareAgreements.push(agreement);
      return structuredClone(agreement);
    });
  }

  acceptThroughFareAgreement(agreementId, operatorId) {
    return this.transact("through-fare-party-accepted", () => acceptFareAgreement(this.requireThroughFareAgreement(agreementId), operatorId, this.clock.minute));
  }

  fileThroughFareAgreement(agreementId) {
    return this.transact("through-fare-filed", () => fileFareAgreement(this.requireThroughFareAgreement(agreementId), this.clock.minute));
  }

  activateThroughFareAgreement(agreementId) {
    return this.transact("through-fare-activated", () => {
      const agreement = this.requireThroughFareAgreement(agreementId);
      activateFareAgreement(agreement, this.requireThroughService(agreement.throughServiceId), this.clock.minute);
      delete agreement.suspendedByThroughService;
      return structuredClone(agreement);
    });
  }

  setThroughFareAgreementStatus(agreementId, status) {
    return this.transact(`through-fare-${status}`, () => changeThroughFareStatus(this.requireThroughFareAgreement(agreementId), status, this.clock.minute));
  }

  throughFareAgreementReport(throughServiceId = null) {
    return structuredClone(this.throughFareAgreements.filter((entry) => throughServiceId === null || entry.throughServiceId === throughServiceId));
  }

  settleThroughServiceOperatingDay(throughServiceId, actuals = {}) {
    return this.transact("through-service-operating-day-settled", () => {
      const service = this.requireThroughService(throughServiceId);
      const operatingDay = Number(actuals.operatingDay);
      const previous = this.throughOperatingSettlements.filter((entry) => entry.throughServiceId === throughServiceId)
        .reduce((maximum, entry) => Math.max(maximum, entry.operatingDay), -1);
      if (operatingDay <= previous) throw new Error(`Through service operating day must be later than ${previous}`);
      const fareAgreement = this.throughFareAgreements.find((entry) => entry.throughServiceId === throughServiceId && entry.status === "active");
      if (!fareAgreement) throw new Error("Through service has no active fare agreement");
      const settlement = calculateThroughOperatingSettlement({
        throughService: service,
        fareAgreement,
        trackAccessAgreements: this.trackAccessAgreements,
        actuals,
        playerOperatorId: this.player.id,
      });
      const atMinute = this.clock.minute;
      settlement.settledAtMinute = atMinute;
      if (settlement.money.playerFareRevenueJPY > 0) this.ledger.post({ atMinute, amount: settlement.money.playerFareRevenueJPY, category: "through-fare-income", reference: throughServiceId });
      for (const [category, amount] of [
        ["through-energy-cost", settlement.money.energyJPY],
        ["through-staff-cost", settlement.money.staffJPY],
        ["through-vehicle-maintenance", settlement.money.vehicleMaintenanceJPY],
        ["through-track-access-cost", settlement.money.trackAccessCostJPY],
        ["through-other-operating-cost", settlement.money.otherOperatingCostJPY],
      ]) {
        if (amount > 0) this.ledger.post({ atMinute, amount: -amount, category, reference: throughServiceId });
      }
      for (const usage of settlement.trackAccessUsage) {
        const agreement = this.trackAccessAgreements.find((entry) => entry.id === usage.agreementId);
        agreement.totals ??= { settledDays: 0, accessRevenueJPY: 0 };
        agreement.totals.guestSettledDays = (agreement.totals.guestSettledDays ?? 0) + 1;
        agreement.totals.guestAccessCostJPY = (agreement.totals.guestAccessCostJPY ?? 0) + usage.accessCostJPY;
      }
      service.throughOperatingTotals ??= { days: 0, passengers: 0, trainKm: 0, fareRevenueJPY: 0, operatingCostJPY: 0, operatingProfitJPY: 0 };
      service.throughOperatingTotals.days += 1;
      service.throughOperatingTotals.passengers += settlement.passengers;
      service.throughOperatingTotals.trainKm += settlement.trainKm;
      service.throughOperatingTotals.fareRevenueJPY += settlement.money.playerFareRevenueJPY;
      service.throughOperatingTotals.operatingCostJPY += settlement.money.operatingCostJPY;
      service.throughOperatingTotals.operatingProfitJPY += settlement.money.operatingProfitJPY;
      service.lastThroughOperatingDay = settlement.operatingDay;
      this.throughOperatingSettlements.push(settlement);
      return structuredClone(settlement);
    });
  }

  throughOperatingSettlementReport(throughServiceId = null, limit = null) {
    const rows = this.throughOperatingSettlements.filter((entry) => throughServiceId === null || entry.throughServiceId === throughServiceId);
    return structuredClone(Number.isInteger(limit) && limit >= 0 ? (limit === 0 ? [] : rows.slice(-limit)) : rows);
  }

  proposeVehicleRetrofit(throughServiceId, input = {}) {
    return this.transact("vehicle-retrofit-proposed", () => {
      const service = this.requireThroughService(throughServiceId);
      if (service.operatorId !== this.player.id) throw new Error("Only a player-operated through service can use player retrofit funds");
      if (service.status === "terminated") throw new Error("A terminated through service cannot be retrofitted");
      if (this.vehicleRetrofitPrograms.some((entry) => entry.throughServiceId === throughServiceId && !["approved", "cancelled"].includes(entry.status))) {
        throw new Error("Through service already has an active vehicle retrofit program");
      }
      while (this.vehicleRetrofitPrograms.some((entry) => entry.id === `vehicle-retrofit:${this.nextVehicleRetrofitSequence}`)) this.nextVehicleRetrofitSequence += 1;
      const id = input.id ?? `vehicle-retrofit:${this.nextVehicleRetrofitSequence++}`;
      if (this.vehicleRetrofitPrograms.some((entry) => entry.id === id)) throw new Error(`Duplicate vehicle retrofit ${id}`);
      const numericId = Number(String(id).match(/^vehicle-retrofit:(\d+)$/)?.[1]);
      if (Number.isInteger(numericId)) this.nextVehicleRetrofitSequence = Math.max(this.nextVehicleRetrofitSequence, numericId + 1);
      const program = createVehicleRetrofitProgram({ ...input, id, throughService: service, atMinute: this.clock.minute });
      this.vehicleRetrofitPrograms.push(program);
      return structuredClone(program);
    });
  }

  startVehicleRetrofit(programId) {
    return this.transact("vehicle-retrofit-started", () => {
      const program = this.requireVehicleRetrofit(programId);
      return startVehicleRetrofitProgram(program, { ledger: this.ledger, clock: this.clock });
    });
  }

  authorizeVehicleRetrofitRetest(programId) {
    return this.transact("vehicle-retrofit-retest-authorized", () => {
      const program = this.requireVehicleRetrofit(programId);
      return buildVehicleRetrofitRetest(program, { ledger: this.ledger, clock: this.clock });
    });
  }

  applyApprovedVehicleRetrofit(programId) {
    if (!(this._transactionDepth > 0)) throw new Error("Vehicle retrofit application requires an active game transaction");
    const program = this.requireVehicleRetrofit(programId);
    if (program.status !== "approved") throw new Error(`Vehicle retrofit ${program.id} is not approved`);
    const service = this.requireThroughService(program.throughServiceId);
    const model = VEHICLE_MODELS[service.guestModelId];
    if (!model) throw new Error(`Unknown vehicle model ${service.guestModelId}`);
    const current = Object.keys(service.vehicleTechnicalOverrides ?? {}).length
      ? service.vehicleTechnicalOverrides
      : { supportedPowerSystems: model.supportedPowerSystems, supportedSignalSystemIds: model.supportedSignalSystemIds };
    service.vehicleTechnicalOverrides = mergeVehicleTechnicalOverrides(current, program.capabilityAdditions);
    service.approvedRetrofitProgramIds = [...new Set([...(service.approvedRetrofitProgramIds ?? []), program.id])].sort();
    service.status = "assessed";
    service.retrofitReassessmentRequired = true;
    for (const agreement of this.throughFareAgreements.filter((entry) => entry.throughServiceId === service.throughServiceId && entry.status === "active")) {
      changeThroughFareStatus(agreement, "suspended", this.clock.minute);
      agreement.suspendedByThroughService = true;
    }
    return structuredClone(service);
  }

  vehicleRetrofitReport(throughServiceId = null) {
    return structuredClone(this.vehicleRetrofitPrograms.filter((entry) => throughServiceId === null || entry.throughServiceId === throughServiceId));
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
      service.baseAverageFare = service.baseAverageFare ?? service.averageFare;
      service.baseTrainsPerHour = service.baseTrainsPerHour ?? service.trainsPerHour;
      service.baseDailyDemand = service.baseDailyDemand ?? service.dailyDemand;
      service.staffingPolicyId ??= "balanced";
      service.electricityContractId ??= "spot";
      service.operatingCompetitors ??= [];
      this.services.push(service);
      if (service.status === "open") activateProjectOperatingFinance(this.constructionFinancing, project.id, operatingMonthFromMinute(this.clock.minute));
      return service;
    });
  }

  updateServicePolicy(serviceId, input = {}) {
    return this.transact("service-policy-updated", () => {
      const service = this.services.find((entry) => entry.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const policy = applyServicePolicy(service, input, { atMinute: this.clock.minute });
      service.fleetRequirement = calculateFleetRequirement({
        routeKm: service.routeKm,
        stations: service.stations,
        commercialSpeedKph: service.commercialSpeedKph,
        trainsPerHour: service.trainsPerHour,
        reserveRatio: service.reserveRatio,
      });
      const resourcePool = this.operatingResourcePools.find((entry) => entry.id === service.resourcePoolId);
      if (resourcePool) rebalancePool(resourcePool, this.operatingResourceContext());
      const electricityChanged = policy.previous.electricityContractId !== policy.current.electricityContractId;
      const electricity = ELECTRICITY_CONTRACTS[policy.current.electricityContractId];
      if (electricityChanged && electricity.switchingCostJPY > 0) {
        this.ledger.post({ atMinute: this.clock.minute, amount: -electricity.switchingCostJPY, category: "electricity-contract-change", reference: service.id, memo: electricity.label });
        if (electricity.reputationDelta) this.player.reputation = Math.min(100, this.player.reputation + electricity.reputationDelta);
      }
      const resources = this.resolveOperatingResources(service.id);
      const accessImpact = this.trackAccessImpact(service.id);
      const availableSets = resources.units.filter((unit) => unit.status === "available").length;
      return {
        policy,
        fleetRequirement: structuredClone(service.fleetRequirement),
        warnings: [
          availableSets < service.fleetRequirement.minimumFleet ? "fleet-shortfall" : null,
          resources.poolId === null && resources.depot.capacitySets < service.fleetRequirement.minimumFleet ? "depot-capacity-shortfall" : null,
          accessImpact.capacityExceeded ? "track-access-capacity-exceeded" : null,
          ...resources.warnings,
        ].filter(Boolean),
      };
    });
  }

  addOperatingCompetitor(serviceId, input) {
    return this.transact("operating-competitor-added", () => {
      const service = this.services.find((entry) => entry.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      service.operatingCompetitors ??= [];
      if (service.operatingCompetitors.some((entry) => entry.id === input.id)) throw new Error(`Duplicate operating competitor ${input.id}`);
      const competitor = createOperatingCompetitor(input);
      service.operatingCompetitors.push(competitor);
      return structuredClone(competitor);
    });
  }

  operateDay(serviceId) {
    return this.transact("service-day-operated", () => {
      const service = this.services.find((item) => item.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const contract = this.contracts.find((item) => item.id === service.contractId);
      const infrastructureImpact = this.infrastructureMaintenanceImpact(service.projectId);
      const possessionImpact = this.throughHandoverPossessionImpact(service.id);
      infrastructureImpact.capacityFactor *= possessionImpact.capacityFactor;
      infrastructureImpact.punctualityPenalty += possessionImpact.punctualityPenalty;
      infrastructureImpact.activeProgramIds = [...new Set([...(infrastructureImpact.activeProgramIds ?? []), ...possessionImpact.activePlanIds])];
      this.clock.advance(1440);
      const operatingDay = Math.floor(this.clock.minute / 1440);
      const resources = this.resolveOperatingResources(service.id);
      const accessImpact = this.trackAccessImpact(service.id);
      const accessSettlement = this.settleTrackAccessForService(service.id, operatingDay - 1, 1);
      const settlement = operateServiceDay({
        service,
        units: resources.units,
        depot: resources.depot,
        contract,
        infrastructureImpact,
        resourcePoolId: resources.poolId,
        resourceWarnings: resources.warnings,
        preferredUnitIds: resources.preferredUnitIds,
        maximumStaffedSets: resources.maximumStaffedSets,
        operatingDay,
        trackAccessImpact: accessImpact,
        trackAccessSettlement: accessSettlement,
      }, this.ledger, this.clock, this.rng);
      const maintenanceProgress = this.advanceInfrastructureMaintenanceToCurrentDay();
      return { ...settlement, maintenanceProgress, ...this.applyOperatingSettlement(service, settlement) };
    });
  }

  settleOperatingFinanceCalendar(serviceId) {
    return this.transact("operating-finance-calendar-settled", () => {
      const service = this.services.find((item) => item.id === serviceId);
      if (!service) throw new Error(`Unknown service ${serviceId}`);
      const financeSettlements = settleProjectOperatingFinance({
        financing: this.constructionFinancing,
        projectId: service.projectId,
        throughMonth: operatingMonthFromMinute(this.clock.minute),
        ledger: this.ledger,
        clock: this.clock,
      });
      recordOperatingFinanceSettlements(this.operatingMonthReports, service, financeSettlements);
      this.updateServiceFinancialStatus(service);
      return structuredClone(financeSettlements);
    });
  }

  applyOperatingSettlement(service, settlement) {
    const project = this.requireProject(service.projectId);
    const infrastructure = applyInfrastructureOperatingWear({ project, trainKm: settlement.trainKm ?? 0, days: settlement.days ?? 1 });
    const report = recordOperatingPeriod(this.operatingMonthReports, {
      service,
      atMinute: this.clock.minute,
      days: settlement.days ?? 1,
      passengers: settlement.passengers ?? settlement.boarded ?? 0,
      denied: settlement.denied ?? 0,
      trainKm: settlement.trainKm ?? 0,
      money: settlement.money ?? {},
      vehicle: settlement.vehicle ?? null,
      infrastructure,
      reliability: settlement.reliability ?? null,
      punctuality: settlement.punctuality ?? null,
      market: settlement.market ?? null,
    });
    for (const incident of settlement.reliability?.incidents ?? []) {
      this.events.record(this.clock.minute, "vehicle-failure", incident);
    }
    const financeSettlements = settleProjectOperatingFinance({
      financing: this.constructionFinancing,
      projectId: service.projectId,
      throughMonth: operatingMonthFromMinute(this.clock.minute),
      ledger: this.ledger,
      clock: this.clock,
    });
    recordOperatingFinanceSettlements(this.operatingMonthReports, service, financeSettlements);
    this.updateServiceFinancialStatus(service);
    return { operatingMonth: structuredClone(report), financeSettlements: structuredClone(financeSettlements), financialStatus: service.financialStatus };
  }

  updateServiceFinancialStatus(service) {
    const defaulted = this.constructionFinancing.some((entry) => entry.projectId === service.projectId && entry.status === "default");
    const delinquent = this.constructionFinancing.some((entry) => entry.projectId === service.projectId && entry.status === "delinquent");
    service.financialStatus = defaulted ? "default" : delinquent ? "delinquent" : "current";
    return service.financialStatus;
  }

  operatingMonthReport(serviceId = null, limit = null) {
    return operatingMonthReport(this.operatingMonthReports, serviceId, limit);
  }

  corporateFinancialStatements(options = {}) {
    return corporateFinancialStatements(this, options);
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

  requireThroughService(id) {
    const service = this.throughServices.find((entry) => entry.throughServiceId === id);
    if (!service) throw new Error(`Unknown through service ${id}`);
    return service;
  }

  requireRailwayTimetable(id) {
    const timetable = this.railwayTimetables.find((entry) => entry.id === id);
    if (!timetable) throw new Error(`Unknown railway timetable ${id}`);
    return timetable;
  }

  requireThroughHandoverProject(id) {
    const project = this.throughHandoverProjects.find((entry) => entry.id === id);
    if (!project) throw new Error(`Unknown through handover project ${id}`);
    return project;
  }

  requireNewTownRailContribution(id) {
    const contribution = this.newTownRailContributions.find((entry) => entry.contributionId === id);
    if (!contribution) throw new Error(`Unknown new town rail contribution ${id}`);
    return contribution;
  }

  requireNewTownDemandIntake(id) {
    const intake = this.newTownDemandIntakes.find((entry) => entry.id === id);
    if (!intake) throw new Error(`Unknown new town demand intake ${id}`);
    return intake;
  }

  requireNewTownDevelopment(id) {
    const development = this.newTownDevelopments.find((entry) => entry.id === id);
    if (!development) throw new Error(`Unknown new town development ${id}`);
    return development;
  }

  requireVehicleRetrofit(id) {
    const program = this.vehicleRetrofitPrograms.find((entry) => entry.id === id);
    if (!program) throw new Error(`Unknown vehicle retrofit ${id}`);
    return program;
  }

  requireThroughFareAgreement(id) {
    const agreement = this.throughFareAgreements.find((entry) => entry.id === id);
    if (!agreement) throw new Error(`Unknown through fare agreement ${id}`);
    return agreement;
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

  previewConstructionPriceSettlement(schedule, project, priceIndex = this.constructionPriceState.currentIndex) {
    return settleConstructionPriceIndex(structuredClone(schedule), structuredClone(project), priceIndex, this.clock);
  }

  updateConstructionFundingCase(existing, schedule, project, preview) {
    return createOrUpdateConstructionFundingCase(existing, {
      id: existing?.id ?? `construction-funding-case:${this.nextConstructionFundingCaseSequence++}`,
      scheduleId: schedule.id,
      projectId: project.id,
      planId: project.planId,
      priceIndex: this.constructionPriceState.currentIndex,
      ownerAdjustmentJPY: preview.ownerAdjustmentJPY,
      availableCashJPY: this.ledger.availableCash,
      atMinute: this.clock.minute,
    });
  }

  delayConstructionForFunding(schedule, months, optionId) {
    const entry = schedule.tasks.find((task) => task.critical && !["complete", "cancelled", "missing"].includes(task.status))
      ?? schedule.tasks.find((task) => !["complete", "cancelled", "missing", "opening-readiness"].includes(task.status));
    if (!entry) return null;
    return recordIntegratedTaskDelay(schedule, entry.id, { months, reason: `Construction funding: ${optionId}`, source: "construction-funding" }, this.clock);
  }

  settleMonthlyConstructionPrices() {
    const outcomes = [];
    for (const schedule of this.schedules) {
      if (!schedule.contractorProcurementIntegrated) continue;
      const project = this.requireProject(schedule.projectId);
      if (["available", "cancelled"].includes(project.status)) continue;
      const preview = this.previewConstructionPriceSettlement(schedule, project);
      if (preview.adjustments.length === 0) continue;
      const pending = this.constructionFundingCases.find((entry) => entry.scheduleId === schedule.id && ["open", "suspended"].includes(entry.status));
      if (preview.ownerAdjustmentJPY > this.ledger.availableCash + 1e-6) {
        const fundingCase = this.updateConstructionFundingCase(pending, schedule, project, preview);
        if (!pending) this.constructionFundingCases.push(fundingCase);
        outcomes.push({ scheduleId: schedule.id, projectId: project.id, status: "funding-required", priceIndex: this.constructionPriceState.currentIndex, ownerAdjustmentJPY: preview.ownerAdjustmentJPY, contractorAbsorbedJPY: preview.contractorAbsorbedJPY, fundingCaseId: fundingCase.id, fundingGapJPY: fundingCase.fundingGapJPY });
        continue;
      }
      const settlement = settleConstructionPriceIndex(schedule, project, this.constructionPriceState.currentIndex, this.clock);
      this.adjustConstructionCommitment(project);
      if (pending) {
        pending.status = "auto-funded";
        pending.resolvedAtMinute = this.clock.minute;
        pending.selectedOptionId = "existing-cash";
      }
      outcomes.push({ scheduleId: schedule.id, projectId: project.id, status: "settled", ...structuredClone(settlement) });
    }
    return outcomes;
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

  syncStationPackageToProject(project, deliveryPackage) {
    const embedded = project.stationDeliveryPackages?.find((entry) => entry.id === deliveryPackage.id);
    if (!embedded) throw new Error(`Station package ${deliveryPackage.id} is not embedded in project ${project.id}`);
    Object.assign(embedded, structuredClone(deliveryPackage));
    return embedded;
  }
}
