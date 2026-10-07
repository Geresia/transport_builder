// B15-E2 persistence boundary.  The map export is immutable evidence; the
// application below is engine state and can safely survive an integrated save.
import { stableId } from "./map/ids.mjs";
import { assessStationDemandAccess } from "./station-demand-access-assessment.mjs";
import { markStationDemandAllocationStale } from "./station-demand-allocation-integration.mjs";

export const STATION_DEMAND_ACCESS_APPLICATION_SCHEMA = "transitline.station-demand-access-application/1";

const clone = (value) => structuredClone(value);
const byText = (a, b) => String(a).localeCompare(String(b));

function revisionKey(assessment) {
  return assessment.sites.map((site) => `${site.stationAccessId}@${site.stationAccessRevision}`).sort(byText).join("|");
}

// The map document itself belongs to its editor and is stored by that editor's
// UI envelope.  The runtime accepts only its validated export, keeping both
// the immutable spatial facts and the engine-owned assessment for B15-E3.
export function applyStationDemandAccess(state, { stationDemandAccess, pack, demand } = {}) {
  if (!state) throw new Error("Operational state is required");
  const assessment = assessStationDemandAccess({ stationDemandAccess, pack, demand: demand ?? pack?.demand });
  const application = {
    schema: STATION_DEMAND_ACCESS_APPLICATION_SCHEMA,
    contractVersion: 1,
    applicationId: stableId("station-demand-access-application", assessment.sourcePackId, assessment.sourcePackVersion, revisionKey(assessment)),
    sourcePackId: assessment.sourcePackId,
    sourcePackVersion: assessment.sourcePackVersion,
    appliedAtSimMinute: Number.isFinite(state.simMinutes) ? state.simMinutes : null,
    access: clone(stationDemandAccess),
    assessment,
  };
  state.stationDemandAccessApplication = application;
  markStationDemandAllocationStale(state);
  return clone(application);
}

export function stationDemandAccessApplicationReport(state) {
  const application = state?.stationDemandAccessApplication ?? null;
  return application === null ? null : clone(application);
}
