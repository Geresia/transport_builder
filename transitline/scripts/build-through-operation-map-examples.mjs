// Dev-time generator for the through-operation map view examples in packs/<id>/through-operation-map-examples/.
//   node scripts/build-through-operation-map-examples.mjs [packId]   (npm run through-operation-map-examples)
//
// Each example runs over a real through-route example of the same pack (packs/<id>/through-route-examples/). The
// management reports that go with it — the through service, its recent operating settlements and the live trains —
// are SYNTHETIC: written by hand here to exercise the view, not produced by the management engine, and they carry no
// money at all. Every example file says so in `source.synthetic` / `source.note`.
// No clock or RNG is involved: re-running the script rewrites every file byte for byte.
import fs from "node:fs";
import path from "node:path";
import { buildThroughOperationView } from "../engine/src/map/through-operation-view.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";

const GENERATED_BY = "scripts/build-through-operation-map-examples.mjs";
const NOTE = "Synthetic management report written by hand for this example. It was not produced by the management engine, and the through route it runs over is a real through-route example of this pack.";
const EXTERNAL = "operator:synthetic-external";

// A through service as the management engine returns it (transitline.through-service/1), filled in by hand.
// spec.leg(leg, index) gives the per-leg findings; spec.issues(route) the assessment's violation/condition/missing lists.
function syntheticService(route, spec) {
  const legs = route.legs.map((leg, index) => ({
    legId: leg.legId,
    sourceKind: leg.sourceKind,
    infrastructureOwnerId: "player",
    operatorId: spec.operatorId ?? "player",
    compatibility: "compatible",
    technicalCompatibility: { verdict: "possible" },
    infrastructureStatus: "available",
    capacityTrainsPerHour: 12,
    trackAccessAgreementId: null,
    ...(spec.leg?.(leg, index) ?? {}),
  }));
  const issues = spec.issues?.(route) ?? {};
  return {
    schema: "transitline.through-service/1",
    contractVersion: 1,
    throughServiceId: spec.id,
    throughRouteId: route.throughRouteId,
    routeGeometryRevision: route.geometryRevision,
    status: spec.status,
    guestModelId: "medium_4car",
    trainsPerHour: 4,
    operatorId: spec.operatorId ?? "player",
    legs,
    handoverIds: route.handovers.map((h) => h.handoverId),
    trackAccessAgreementIds: [...new Set(legs.map((l) => l.trackAccessAgreementId).filter(Boolean))].sort(),
    approvedRetrofitProgramIds: [],
    assessment: { verdict: spec.verdict, violations: issues.violations ?? [], conditions: issues.conditions ?? [], missingInputs: issues.missingInputs ?? [] },
    ...(spec.totals ? { throughOperatingTotals: spec.totals, lastThroughOperatingDay: spec.lastDay } : {}),
  };
}

// A through operating settlement as the engine returns it, with the money left out on purpose.
const settlement = (serviceId, operatingDay, passengers, trainKm, usage = []) => ({
  schema: "transitline.through-operating-settlement/1",
  contractVersion: 1,
  settlementId: `through-operation:${serviceId}:${operatingDay}`,
  throughServiceId: serviceId,
  settledAtMinute: operatingDay * 1440 + 1440,
  operatingDay,
  passengers,
  trainKm,
  carKm: trainKm * 4,
  trackAccessUsage: usage,
});

const legIdOf = (route, index) => route.legs[index].legId;
const sid = (name) => `through-service:synthetic-${name}`;

const EXAMPLES = {
  tokyo: () => ({
    "01-approved-normal-split-joined": {
      case: ["approved-normal", "recent-settlement", "live-train-reported"], routeFile: "04-station-variants-split-joined",
      service: { id: sid("tokyo-approved"), status: "approved", verdict: "possible", totals: { days: 3, passengers: 36_000, trainKm: 1_460 }, lastDay: 42 },
      settlements: (id) => [settlement(id, 40, 11_800, 480), settlement(id, 42, 12_400, 492), settlement(id, 41, 12_000, 488)],
      live: (r) => ({ operatingDay: 43, serviceMinute: 615, passengers: 3_100, trainKm: 121.5, trackAccessUsage: [], trains: [
        { trainRunId: "run:1", throughServiceId: sid("tokyo-approved"), legId: legIdOf(r, 0), progress: 0.4, location: r.legs[0].alignment[1], direction: "forward", delayMinutes: 0 },
      ] }),
    },
    "02-external-connection-unknown": {
      case: ["external-included", "connection-unknown"], routeFile: "02-east-river-koto-line-external",
      service: {
        id: sid("tokyo-external"), status: "assessed", verdict: "unknown",
        leg: (leg) => (leg.sourceKind === "external" ? { infrastructureOwnerId: EXTERNAL, compatibility: "unknown", technicalCompatibility: { verdict: "unknown" }, infrastructureStatus: null, capacityTrainsPerHour: null } : {}),
        issues: (r) => ({ conditions: [`leg:${r.legs[1].legId}:track-access-agreement-required`], missingInputs: [`handover:${r.handovers[0].handoverId}:physicalConnection`, `leg:${r.legs[1].legId}:technicalProfileId`] }),
      },
    },
    "03-external-no-alignment-no-train-position": {
      case: ["external-included", "connection-unknown", "external-no-alignment-and-no-train-position", "live-train-interpolated"], routeFile: "03-east-river-koto-shinjuku-three-legs",
      service: {
        id: sid("tokyo-three-legs"), status: "assessed", verdict: "unknown",
        // the planned leg after the external one cannot be judged either: a drawn leg whose own verdict is unknown
        leg: (leg, index) => (leg.sourceKind === "external" ? { infrastructureOwnerId: EXTERNAL, compatibility: "unknown", technicalCompatibility: { verdict: "unknown" } } : index === 2 ? { compatibility: "unknown", technicalCompatibility: { verdict: "unknown" } } : {}),
        issues: (r) => ({ missingInputs: r.handovers.map((h) => `handover:${h.handoverId}:physicalConnection`) }),
      },
      live: (r) => ({ operatingDay: 7, serviceMinute: 480, passengers: null, trainKm: null, trackAccessUsage: [], trains: [
        { trainRunId: "run:ext", throughServiceId: sid("tokyo-three-legs"), legId: legIdOf(r, 1), progress: null, location: null, direction: "forward", delayMinutes: null },
        { trainRunId: "run:planned", throughServiceId: sid("tokyo-three-legs"), legId: legIdOf(r, 0), progress: 0.5, location: null, direction: "forward", delayMinutes: 2 },
      ] }),
    },
    "04-physically-separated": {
      case: ["physically-separated"], routeFile: "01-bay-spine-east-river-separated",
      service: { id: sid("tokyo-separated"), status: "assessed", verdict: "impossible", issues: (r) => ({ violations: [`handover:${r.handovers[0].handoverId}:physically-separated`] }) },
    },
  }),
  "example-radial": () => ({
    "01-approved-recent-settlement": {
      case: ["approved-normal", "recent-settlement"], routeFile: "01-spoke-to-ring-joined",
      service: { id: sid("radial-approved"), status: "approved", verdict: "possible", totals: { days: 3, passengers: 9_300, trainKm: 960 }, lastDay: 12 },
      settlements: (id) => [settlement(id, 10, 3_000, 320), settlement(id, 12, 3_300, 330), settlement(id, 11, 3_000, 310)],
    },
    "02-track-access-condition-unmet": {
      case: ["track-access-condition-unmet"], routeFile: "02-spoke-to-cross-city-joined",
      service: {
        id: sid("radial-access"), status: "assessed", verdict: "conditional",
        leg: (leg, index) => (index === 1 ? { infrastructureOwnerId: EXTERNAL } : {}),
        issues: (r) => ({ conditions: [`leg:${r.legs[1].legId}:track-access-agreement-required`] }),
      },
    },
    "03-physically-separated": {
      case: ["physically-separated"], routeFile: "03-ring-arc-to-transfer-stub-separated",
      service: { id: sid("radial-separated"), status: "assessed", verdict: "impossible", issues: (r) => ({ violations: [`handover:${r.handovers[0].handoverId}:physically-separated`] }) },
    },
    "04-live-trains-reported-and-interpolated": {
      case: ["approved-normal", "live-train-reported", "live-train-interpolated"], routeFile: "01-spoke-to-ring-joined",
      service: { id: sid("radial-live"), status: "approved", verdict: "possible" },
      live: (r) => ({ operatingDay: 5, serviceMinute: 540, passengers: 1_200, trainKm: 96, trackAccessUsage: [], trains: [
        { trainRunId: "run:a", throughServiceId: sid("radial-live"), legId: legIdOf(r, 0), progress: null, location: r.legs[0].alignment[0], direction: "forward", delayMinutes: 0 },
        { trainRunId: "run:b", throughServiceId: sid("radial-live"), legId: legIdOf(r, 1), progress: 0.25, location: null, direction: "reverse", delayMinutes: 4 },
      ] }),
    },
  }),
  "example-corridor": () => ({
    "01-technically-incompatible": {
      case: ["technically-impossible"], routeFile: "01-corridor-trunk-split",
      service: {
        id: sid("corridor-incompatible"), status: "assessed", verdict: "impossible",
        leg: (leg, index) => (index === 1 ? { compatibility: "incompatible", technicalCompatibility: { verdict: "impossible" } } : {}),
        issues: (r) => ({ violations: [`leg:${r.legs[1].legId}:running-system-incompatible`, `leg:${r.legs[1].legId}:technical:gauge-not-supported`] }),
      },
    },
    "02-suspended": { case: ["suspended"], routeFile: "01-corridor-trunk-split", service: { id: sid("corridor-suspended"), status: "suspended", verdict: "possible", totals: { days: 2, passengers: 4_000, trainKm: 400 }, lastDay: 8 } },
    "03-terminated": { case: ["terminated"], routeFile: "01-corridor-trunk-split", service: { id: sid("corridor-terminated"), status: "terminated", verdict: "possible", totals: { days: 30, passengers: 61_000, trainKm: 6_100 }, lastDay: 29 } },
  }),
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const outDir = path.join(root, pack.dir, "through-operation-map-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, def] of Object.entries(EXAMPLES[id]())) {
    const route = readJson(`${pack.dir}/through-route-examples/${def.routeFile}.through-route.json`);
    const { source: _drop, ...routeBody } = route;
    const service = syntheticService(routeBody, def.service);
    const settlements = def.settlements ? def.settlements(service.throughServiceId) : [];
    const liveActuals = def.live ? def.live(routeBody) : null;
    const view = buildThroughOperationView({ route: routeBody, service, settlements, liveActuals });
    const body = { ...view, source: { case: def.case, synthetic: true, note: NOTE, throughRouteExample: def.routeFile, input: { service, settlements, liveActuals, playerOperatorId: "player" }, generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, `${file}.view.json`), `${JSON.stringify(body, null, 2)}\n`);
    console.log(`[${id}] ${file}: status=${view.status} verdict=${view.assessmentVerdict} legs=[${view.legs.map((l) => l.style.key).join(", ")}] handovers=[${view.handovers.map((h) => h.connectionState)}] trains=${view.trainMarkers.map((t) => `${t.trainRunId}:${t.locationBasis ?? "none"}`).join(",") || "-"} warnings=${view.warnings.length}`);
  }
}
