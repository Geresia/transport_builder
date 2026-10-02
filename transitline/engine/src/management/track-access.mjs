import { TECHNICAL_PROFILES } from "./construction.mjs";
import { VEHICLE_MODELS } from "./rolling-stock.mjs";

export const TRACK_ACCESS_OPPORTUNITY_SCHEMA = "transitline.track-access-opportunity/1";
export const TRACK_ACCESS_AGREEMENT_SCHEMA = "transitline.track-access-agreement/1";

const clone = (value) => structuredClone(value);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function technicalCompatibility(hostProject, guestModelId) {
  const vehicle = VEHICLE_MODELS[guestModelId];
  const profile = TECHNICAL_PROFILES[hostProject?.technicalProfileId];
  const reasons = [];
  if (!vehicle) reasons.push(`Unknown guest vehicle model ${guestModelId}`);
  if (!profile) reasons.push("Host infrastructure profile is unknown");
  if (vehicle && hostProject && vehicle.profileId !== hostProject.technicalProfileId) reasons.push("Guest running system does not match host infrastructure");
  return { compatible: reasons.length === 0, reasons, hostProfileId: hostProject?.technicalProfileId ?? null, guestProfileId: vehicle?.profileId ?? null };
}

export function createTrackAccessOpportunity(input, { hostService, hostProject, atMinute = 0 } = {}) {
  if (!input?.id) throw new Error("Track access opportunity requires an id");
  if (!hostService || hostService.status !== "open") throw new Error("Track access requires an open host service");
  if (!hostProject || hostProject.status !== "available") throw new Error("Track access requires available host infrastructure");
  const guestModelId = input.guestModelId ?? hostService.modelId;
  const compatibility = technicalCompatibility(hostProject, guestModelId);
  if (!compatibility.compatible) throw new Error(compatibility.reasons.join("; "));
  const hostCapacityTrainsPerHour = Number(input.hostCapacityTrainsPerHour ?? 24);
  const minimumGuestTrainsPerHour = Number(input.minimumGuestTrainsPerHour ?? 1);
  const maximumGuestTrainsPerHour = Number(input.maximumGuestTrainsPerHour ?? 4);
  if (!(hostCapacityTrainsPerHour > hostService.trainsPerHour)) throw new Error("Host line has no access capacity");
  if (!(minimumGuestTrainsPerHour > 0) || !(maximumGuestTrainsPerHour >= minimumGuestTrainsPerHour)) throw new Error("Invalid guest train frequency range");
  if (hostService.trainsPerHour + minimumGuestTrainsPerHour > hostCapacityTrainsPerHour) throw new Error("Minimum guest service exceeds host capacity");
  const routeKm = Number(input.accessRouteKm ?? hostService.routeKm);
  const stationsServed = Math.max(1, Math.floor(input.stationsServed ?? hostService.stations));
  if (!(routeKm > 0)) throw new Error("Track access route must be positive");
  return {
    schema: TRACK_ACCESS_OPPORTUNITY_SCHEMA,
    contractVersion: 1,
    id: String(input.id),
    name: input.name ?? `${hostService.name ?? hostService.id} 선로사용 공모`,
    hostServiceId: hostService.id,
    hostProjectId: hostProject.id,
    infrastructureOwnerId: input.infrastructureOwnerId ?? "player",
    guestModelId,
    compatibility,
    hostCapacityTrainsPerHour,
    hostTrainsPerHourAtAnnouncement: hostService.trainsPerHour,
    minimumGuestTrainsPerHour,
    maximumGuestTrainsPerHour: Math.min(maximumGuestTrainsPerHour, hostCapacityTrainsPerHour - hostService.trainsPerHour),
    accessRouteKm: routeKm,
    stationsServed,
    operatingHoursPerDay: clamp(Number(input.operatingHoursPerDay ?? 18), 1, 24),
    baselineAccessFeeJPYPerTrainKm: Math.max(1, Number(input.baselineAccessFeeJPYPerTrainKm ?? 1_250)),
    baselineStationFeeJPYPerStop: Math.max(0, Number(input.baselineStationFeeJPYPerStop ?? 18_000)),
    minimumTechnicalScore: clamp(Number(input.minimumTechnicalScore ?? 70), 0, 100),
    contractYears: Math.max(1, Math.floor(input.contractYears ?? 10)),
    status: "announced",
    announcedAtMinute: atMinute,
    offers: [],
    ranking: [],
  };
}

export function generateTrackAccessOffers(opportunity, competitors, rng) {
  if (opportunity.status !== "announced") throw new Error("Track access opportunity is not open");
  if (!rng?.next) throw new Error("Track access offers require a deterministic RNG");
  const offers = [];
  for (const company of [...competitors].sort((a, b) => a.id.localeCompare(b.id))) {
    if (company.operatingScore < opportunity.minimumTechnicalScore || company.cash <= 0) continue;
    const participation = 0.45 + company.strategy.riskTolerance * 0.35 - (company.accessCommitments ?? 0) * 0.08;
    if (rng.next() > participation) continue;
    const span = opportunity.maximumGuestTrainsPerHour - opportunity.minimumGuestTrainsPerHour;
    const trainsPerHour = opportunity.minimumGuestTrainsPerHour + Math.floor(rng.next() * (span + 1));
    const feeFactor = 0.88 + company.operatingScore / 500 + rng.next() * 0.08;
    const accessFeeJPYPerTrainKm = Math.round(opportunity.baselineAccessFeeJPYPerTrainKm * feeFactor);
    const stationFeeJPYPerStop = Math.round(opportunity.baselineStationFeeJPYPerStop * (0.92 + rng.next() * 0.12));
    const technicalScore = clamp(company.operatingScore + (rng.next() - 0.5) * 8, 0, 100);
    const dailyOneWayTrips = trainsPerHour * opportunity.operatingHoursPerDay;
    const dailyTrainKm = dailyOneWayTrips * opportunity.accessRouteKm;
    const dailyStationStops = dailyOneWayTrips * opportunity.stationsServed;
    const projectedAnnualHostRevenueJPY = Math.round((dailyTrainKm * accessFeeJPYPerTrainKm + dailyStationStops * stationFeeJPYPerStop) * 365);
    offers.push({
      id: `track-access-offer:${opportunity.id}:${company.id}`,
      opportunityId: opportunity.id,
      bidderId: company.id,
      bidderName: company.name,
      guestModelId: opportunity.guestModelId,
      trainsPerHour,
      accessFeeJPYPerTrainKm,
      stationFeeJPYPerStop,
      technicalScore,
      promisedPunctuality: clamp(0.93 + technicalScore / 2_000, 0.93, 0.985),
      dailyTrainKm,
      dailyStationStops,
      projectedAnnualHostRevenueJPY,
    });
  }
  opportunity.offers = offers;
  const highestRevenue = Math.max(1, ...offers.map((offer) => offer.projectedAnnualHostRevenueJPY));
  opportunity.ranking = offers.map((offer) => ({
    ...offer,
    revenueScore: offer.projectedAnnualHostRevenueJPY / highestRevenue * 100,
    capacityScore: (1 - offer.trainsPerHour / opportunity.hostCapacityTrainsPerHour) * 100,
    totalScore: offer.projectedAnnualHostRevenueJPY / highestRevenue * 55 + offer.technicalScore * 0.35 + (1 - offer.trainsPerHour / opportunity.hostCapacityTrainsPerHour) * 100 * 0.1,
  })).sort((a, b) => b.totalScore - a.totalScore || b.projectedAnnualHostRevenueJPY - a.projectedAnnualHostRevenueJPY || a.bidderId.localeCompare(b.bidderId));
  opportunity.status = offers.length ? "offers-received" : "failed-no-offers";
  return clone(opportunity.ranking);
}

export function awardTrackAccessOffer(opportunity, offerId, { agreements = [], competitors = [], startDay = 0, hostTrainsPerHour = opportunity.hostTrainsPerHourAtAnnouncement } = {}) {
  if (opportunity.status !== "offers-received") throw new Error("Track access offers are not ready for award");
  const offer = opportunity.offers.find((entry) => entry.id === offerId);
  if (!offer) throw new Error(`Unknown track access offer ${offerId}`);
  if (offer.technicalScore < opportunity.minimumTechnicalScore) throw new Error("Selected operator fails the technical threshold");
  const reserved = agreements.filter((entry) => entry.hostServiceId === opportunity.hostServiceId && entry.status === "active").reduce((sum, entry) => sum + entry.trainsPerHour, 0);
  if (hostTrainsPerHour + reserved + offer.trainsPerHour > opportunity.hostCapacityTrainsPerHour) throw new Error("Award would exceed host line capacity");
  const agreement = {
    schema: TRACK_ACCESS_AGREEMENT_SCHEMA,
    contractVersion: 1,
    id: `track-access-agreement:${opportunity.id}`,
    opportunityId: opportunity.id,
    kind: "competitor-track-access",
    infrastructureOwnerId: opportunity.infrastructureOwnerId,
    hostServiceId: opportunity.hostServiceId,
    hostProjectId: opportunity.hostProjectId,
    guestOperatorId: offer.bidderId,
    guestOperatorName: offer.bidderName,
    guestModelId: offer.guestModelId,
    trainsPerHour: offer.trainsPerHour,
    accessFeeJPYPerTrainKm: offer.accessFeeJPYPerTrainKm,
    stationFeeJPYPerStop: offer.stationFeeJPYPerStop,
    technicalScore: offer.technicalScore,
    promisedPunctuality: offer.promisedPunctuality,
    dailyTrainKm: offer.dailyTrainKm,
    dailyStationStops: offer.dailyStationStops,
    hostCapacityTrainsPerHour: opportunity.hostCapacityTrainsPerHour,
    startDay,
    endDay: startDay + opportunity.contractYears * 365,
    lastSettledDay: startDay - 1,
    status: "active",
    totals: { settledDays: 0, accessRevenueJPY: 0 },
  };
  opportunity.status = "awarded";
  opportunity.selectedOfferId = offer.id;
  opportunity.agreementId = agreement.id;
  const company = competitors.find((entry) => entry.id === offer.bidderId);
  if (company) company.accessCommitments = (company.accessCommitments ?? 0) + 1;
  return agreement;
}

export function trackAccessImpact(agreements, serviceId, hostTrainsPerHour = 0) {
  const active = agreements.filter((entry) => entry.hostServiceId === serviceId && entry.status === "active");
  const guestTrainsPerHour = active.reduce((sum, entry) => sum + entry.trainsPerHour, 0);
  const capacity = active.length ? Math.min(...active.map((entry) => entry.hostCapacityTrainsPerHour)) : null;
  const utilisation = capacity ? (hostTrainsPerHour + guestTrainsPerHour) / capacity : 0;
  return {
    agreementIds: active.map((entry) => entry.id),
    guestTrainsPerHour,
    hostCapacityTrainsPerHour: capacity,
    utilisation,
    punctualityPenalty: utilisation <= 0.8 ? 0 : Math.min(0.06, (utilisation - 0.8) * 0.15),
    capacityExceeded: capacity !== null && hostTrainsPerHour + guestTrainsPerHour > capacity,
  };
}

export function settleTrackAccessRevenue(agreements, serviceId, throughDay, competitors = [], operatingDays = null) {
  const boundedOperatingDays = operatingDays === null ? null : Math.max(0, Math.floor(operatingDays));
  const settlements = [];
  for (const agreement of agreements.filter((entry) => entry.hostServiceId === serviceId && entry.status === "active")) {
    const finalDay = Math.min(Math.floor(throughDay), agreement.endDay);
    const operatingWindowStart = boundedOperatingDays === null ? -Infinity : Math.floor(throughDay) - boundedOperatingDays + 1;
    const firstDay = Math.max(agreement.startDay, (agreement.lastSettledDay ?? agreement.startDay - 1) + 1, operatingWindowStart);
    const days = Math.max(0, finalDay - firstDay + 1);
    const accessRevenueJPY = Math.round((agreement.dailyTrainKm * agreement.accessFeeJPYPerTrainKm + agreement.dailyStationStops * agreement.stationFeeJPYPerStop) * days);
    if (days) {
      agreement.totals.settledDays += days;
      agreement.totals.accessRevenueJPY += accessRevenueJPY;
      settlements.push({ agreementId: agreement.id, hostServiceId: serviceId, guestOperatorId: agreement.guestOperatorId, fromDay: firstDay, throughDay: finalDay, days, accessRevenueJPY });
    }
    // When the caller supplies an operating window, calendar days with no actual service are deliberately
    // skipped instead of being back-billed on the next run. The agreement is still advanced/expired on
    // calendar time, because its start and end dates are contractual dates rather than service counters.
    if (boundedOperatingDays !== null && throughDay >= agreement.startDay) {
      agreement.lastSettledDay = Math.max(agreement.lastSettledDay ?? agreement.startDay - 1, Math.min(Math.floor(throughDay), agreement.endDay));
    } else if (days) agreement.lastSettledDay = finalDay;
    if (Math.floor(throughDay) >= agreement.endDay) {
      agreement.status = "expired";
      const company = competitors.find((entry) => entry.id === agreement.guestOperatorId);
      if (company) company.accessCommitments = Math.max(0, (company.accessCommitments ?? 1) - 1);
    }
  }
  return { settlements, accessRevenueJPY: settlements.reduce((sum, entry) => sum + entry.accessRevenueJPY, 0) };
}

export function setTrackAccessAgreementStatus(agreement, status, competitors = [], atDay = null) {
  if (!["active", "suspended", "terminated"].includes(status)) throw new Error(`Invalid track access status ${status}`);
  if (agreement.status === "terminated" || agreement.status === "expired") throw new Error("Closed track access agreement cannot change status");
  if (status === "active" && agreement.status !== "suspended") throw new Error("Only a suspended agreement can resume");
  if (status === "suspended" && agreement.status !== "active") throw new Error("Only an active agreement can be suspended");
  const wasOpen = ["active", "suspended"].includes(agreement.status);
  if (status === "suspended") agreement.suspendedAtDay = atDay;
  if (status === "active") {
    if (!Number.isFinite(atDay)) throw new Error("Resuming track access requires the current operating day");
    agreement.lastSettledDay = Math.max(agreement.lastSettledDay, Math.floor(atDay) - 1);
    agreement.resumedAtDay = Math.floor(atDay);
    delete agreement.suspendedAtDay;
  }
  agreement.status = status;
  if (status === "terminated" && wasOpen) {
    const company = competitors.find((entry) => entry.id === agreement.guestOperatorId);
    if (company) company.accessCommitments = Math.max(0, (company.accessCommitments ?? 1) - 1);
  }
  return clone(agreement);
}
