export const THROUGH_FARE_AGREEMENT_SCHEMA = "transitline.through-fare-agreement/1";
export const THROUGH_FARE_PRICE_BASE_YEAR = 2026;

const clone = (value) => structuredClone(value);
const uniqueText = (values) => [...new Set((values ?? []).filter((value) => typeof value === "string" && value))].sort();

function integerJPY(value, label, { allowZero = true } = {}) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} integer JPY amount`);
  return amount;
}

function normalizeParticipants(throughService, terms) {
  if (!Array.isArray(terms) || !terms.length) throw new Error("Through fare agreement requires participant terms");
  const expectedLegIds = uniqueText((throughService.legs ?? []).map((leg) => leg.legId));
  if (!expectedLegIds.length) throw new Error("Through service has no fare-settlement legs");
  const operatorIds = new Set();
  const coveredLegIds = new Set();
  const participants = terms.map((term) => {
    const operatorId = String(term?.operatorId ?? "").trim();
    if (!operatorId) throw new Error("Fare participant requires an operatorId");
    if (operatorIds.has(operatorId)) throw new Error(`Duplicate fare participant ${operatorId}`);
    operatorIds.add(operatorId);
    const legIds = uniqueText(term.legIds);
    if (!legIds.length) throw new Error(`Fare participant ${operatorId} requires at least one leg`);
    for (const legId of legIds) {
      if (!expectedLegIds.includes(legId)) throw new Error(`Unknown fare leg ${legId}`);
      if (coveredLegIds.has(legId)) throw new Error(`Fare leg ${legId} is assigned more than once`);
      coveredLegIds.add(legId);
    }
    const discountShareBps = term.discountShareBps === undefined || term.discountShareBps === null
      ? null
      : integerJPY(term.discountShareBps, `Discount share for ${operatorId}`);
    if (discountShareBps !== null && discountShareBps > 10_000) throw new Error(`Discount share for ${operatorId} cannot exceed 10000 basis points`);
    return {
      operatorId,
      legIds,
      sectionFareJPY: integerJPY(term.sectionFareJPY, `Section fare for ${operatorId}`),
      discountShareBps,
    };
  }).sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  const missing = expectedLegIds.filter((legId) => !coveredLegIds.has(legId));
  if (missing.length) throw new Error(`Fare agreement does not cover legs: ${missing.join(", ")}`);
  return participants;
}

function allocateInteger(total, weighted, weightOf) {
  if (total === 0) return new Map(weighted.map((item) => [item.operatorId, 0]));
  const denominator = weighted.reduce((sum, item) => sum + weightOf(item), 0);
  if (!(denominator > 0)) throw new Error("Fare allocation weights must total more than zero");
  const rows = weighted.map((item) => {
    const numerator = total * weightOf(item);
    const floor = Math.floor(numerator / denominator);
    return { operatorId: item.operatorId, amount: floor, remainder: numerator % denominator };
  });
  let residual = total - rows.reduce((sum, row) => sum + row.amount, 0);
  rows.sort((a, b) => b.remainder - a.remainder || a.operatorId.localeCompare(b.operatorId));
  for (let index = 0; index < residual; index++) rows[index % rows.length].amount += 1;
  return new Map(rows.map((row) => [row.operatorId, row.amount]));
}

function priceParticipants(participants, jointDiscountJPY, discountAllocationMethod) {
  const grossFareJPY = participants.reduce((sum, entry) => sum + entry.sectionFareJPY, 0);
  if (jointDiscountJPY > grossFareJPY) throw new Error("Joint fare discount cannot exceed the gross section fare");
  let burdens;
  if (discountAllocationMethod === "proportional-section-fare") {
    burdens = allocateInteger(jointDiscountJPY, participants, (entry) => entry.sectionFareJPY);
  } else if (discountAllocationMethod === "fixed-share") {
    if (participants.some((entry) => entry.discountShareBps === null)) {
      throw new Error("Fixed discount allocation requires every participant share in basis points");
    }
    if (participants.reduce((sum, entry) => sum + entry.discountShareBps, 0) !== 10_000) {
      throw new Error("Fixed discount shares must total 10000 basis points");
    }
    burdens = allocateInteger(jointDiscountJPY, participants, (entry) => entry.discountShareBps);
  } else {
    throw new Error(`Unknown through fare discount allocation ${discountAllocationMethod}`);
  }
  const priced = participants.map((entry) => {
    const discountBurdenJPY = burdens.get(entry.operatorId) ?? 0;
    if (discountBurdenJPY > entry.sectionFareJPY) throw new Error(`Discount burden exceeds ${entry.operatorId}'s section fare`);
    return { ...entry, discountBurdenJPY, netFareJPY: entry.sectionFareJPY - discountBurdenJPY };
  });
  return { participants: priced, grossFareJPY, passengerFareJPY: grossFareJPY - jointDiscountJPY };
}

export function createThroughFareAgreement({
  id,
  throughService,
  collectingOperatorId = throughService?.operatorId,
  participantTerms,
  jointDiscountJPY = 0,
  discountAllocationMethod = "proportional-section-fare",
  atMinute = 0,
} = {}) {
  if (!id) throw new Error("Through fare agreement requires an id");
  if (throughService?.schema !== "transitline.through-service/1" || throughService.contractVersion !== 1) throw new Error("ThroughService v1 is required");
  if (!throughService.throughServiceId) throw new Error("Through fare agreement requires a through service id");
  const participants = normalizeParticipants(throughService, participantTerms);
  const collector = String(collectingOperatorId ?? "").trim();
  if (!participants.some((entry) => entry.operatorId === collector)) throw new Error("Collecting operator must be a fare participant");
  const discount = integerJPY(jointDiscountJPY, "Joint fare discount");
  const priced = priceParticipants(participants, discount, discountAllocationMethod);
  return {
    schema: THROUGH_FARE_AGREEMENT_SCHEMA,
    contractVersion: 1,
    id: String(id),
    throughServiceId: throughService.throughServiceId,
    collectingOperatorId: collector,
    currency: "JPY",
    priceBaseYear: THROUGH_FARE_PRICE_BASE_YEAR,
    discountAllocationMethod,
    jointDiscountJPY: discount,
    grossFareJPY: priced.grossFareJPY,
    passengerFareJPY: priced.passengerFareJPY,
    participants: priced.participants,
    status: "draft",
    acceptedOperatorIds: [],
    createdAtMinute: Number(atMinute) || 0,
    fullyAcceptedAtMinute: null,
    filedAtMinute: null,
    activatedAtMinute: null,
    suspendedAtMinute: null,
    terminatedAtMinute: null,
  };
}

function requireAgreement(agreement) {
  if (agreement?.schema !== THROUGH_FARE_AGREEMENT_SCHEMA || agreement.contractVersion !== 1) throw new Error("ThroughFareAgreement v1 is required");
  return agreement;
}

export function acceptThroughFareAgreement(agreement, operatorId, atMinute = 0) {
  requireAgreement(agreement);
  if (!["draft", "accepted"].includes(agreement.status)) throw new Error(`Through fare agreement cannot accept from ${agreement.status}`);
  const id = String(operatorId ?? "");
  if (!agreement.participants.some((entry) => entry.operatorId === id)) throw new Error(`Unknown fare participant ${id}`);
  agreement.acceptedOperatorIds = uniqueText([...agreement.acceptedOperatorIds, id]);
  if (agreement.acceptedOperatorIds.length === agreement.participants.length) {
    agreement.status = "accepted";
    agreement.fullyAcceptedAtMinute ??= Number(atMinute) || 0;
  }
  return clone(agreement);
}

export function fileThroughFareAgreement(agreement, atMinute = 0) {
  requireAgreement(agreement);
  if (agreement.status !== "accepted") throw new Error(`Through fare agreement cannot be filed from ${agreement.status}`);
  agreement.status = "filed";
  agreement.filedAtMinute = Number(atMinute) || 0;
  return clone(agreement);
}

export function activateThroughFareAgreement(agreement, throughService, atMinute = 0) {
  requireAgreement(agreement);
  if (!["filed", "suspended"].includes(agreement.status)) throw new Error(`Through fare agreement cannot activate from ${agreement.status}`);
  const resuming = agreement.status === "suspended";
  if (throughService?.throughServiceId !== agreement.throughServiceId) throw new Error("Through fare agreement service identity does not match");
  if (throughService.status !== "approved") throw new Error("Through fare agreement requires an approved through service");
  agreement.status = "active";
  agreement.activatedAtMinute ??= Number(atMinute) || 0;
  if (resuming) agreement.resumedAtMinute = Number(atMinute) || 0;
  agreement.suspendedAtMinute = null;
  return clone(agreement);
}

export function setThroughFareAgreementStatus(agreement, status, atMinute = 0) {
  requireAgreement(agreement);
  if (status === "suspended" && agreement.status === "active") {
    agreement.status = status;
    agreement.suspendedAtMinute = Number(atMinute) || 0;
  } else if (status === "terminated" && ["draft", "accepted", "filed", "active", "suspended"].includes(agreement.status)) {
    agreement.status = status;
    agreement.terminatedAtMinute = Number(atMinute) || 0;
  } else {
    throw new Error(`Through fare agreement cannot change from ${agreement.status} to ${status}`);
  }
  return clone(agreement);
}

export function calculateThroughFareSettlement(agreement, { passengers, settlementId = null } = {}) {
  requireAgreement(agreement);
  if (agreement.status !== "active") throw new Error("Through fare settlement requires an active agreement");
  if (!Number.isSafeInteger(passengers) || passengers < 0) throw new Error("Through fare passengers must be a non-negative integer");
  const allocations = agreement.participants.map((entry) => ({
    operatorId: entry.operatorId,
    passengers,
    sectionRevenueJPY: entry.sectionFareJPY * passengers,
    discountBurdenJPY: entry.discountBurdenJPY * passengers,
    netRevenueJPY: entry.netFareJPY * passengers,
  }));
  const grossSectionFareJPY = agreement.grossFareJPY * passengers;
  const jointDiscountJPY = agreement.jointDiscountJPY * passengers;
  const passengerRevenueJPY = agreement.passengerFareJPY * passengers;
  if (allocations.reduce((sum, entry) => sum + entry.netRevenueJPY, 0) !== passengerRevenueJPY) throw new Error("Through fare allocation does not reconcile");
  return {
    schema: "transitline.through-fare-settlement/1",
    contractVersion: 1,
    settlementId,
    agreementId: agreement.id,
    throughServiceId: agreement.throughServiceId,
    passengers,
    currency: agreement.currency,
    grossSectionFareJPY,
    jointDiscountJPY,
    passengerRevenueJPY,
    allocations,
  };
}
