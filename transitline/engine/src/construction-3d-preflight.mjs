// B24 preflight composition. It makes one deterministic 2D -> B21 scene ->
// B24 audit result without loading a renderer or mutating any owner state.
import { buildConstruction3dSceneManifest } from "./construction-3d-exchange.mjs";
import { construction3dSourcesFrom2d } from "./construction-3d-source-adapters.mjs";
import { assessConstruction3dSession } from "./construction-3d-session-coordinator.mjs";
import { buildConstruction3dIntegrationAudit } from "./construction-3d-integration-audit.mjs";

export const CONSTRUCTION_3D_PREFLIGHT_SCHEMA = "transitline.construction-3d-preflight/1";
export function buildConstruction3dPreflight({ pack, coordinates, coordinateProfile = null, client = null, campaignPrograms = [], railGeometries, stationSites, depotSites, developments, changeSet = null, review = null, selectedSourceIds = null } = {}) {
  const sources = construction3dSourcesFrom2d({ railGeometries, stationSites, depotSites, developments });
  const profileProvided = coordinateProfile !== null && coordinateProfile !== undefined;
  const packId = pack?.manifest?.id ?? pack?.id ?? null;
  const profileStatus = !profileProvided ? null
    : coordinateProfile?.status === "stated" && coordinateProfile?.packId !== packId ? "other-pack"
      : coordinateProfile?.status ?? null;
  // A persisted coordinate profile is a fact about one map pack. It must not
  // make a different pack appear 3D-ready merely because its numbers parse.
  const activeCoordinates = profileProvided ? (profileStatus === "stated" ? coordinateProfile.coordinates : null) : coordinates;
  let scene = null; let sceneError = null;
  try { scene = buildConstruction3dSceneManifest({ pack, coordinates: activeCoordinates, sources: sources.sources }); }
  catch (error) { sceneError = error instanceof Error ? error.message : String(error); }
  const session = assessConstruction3dSession({ pack, client, scene, currentSources: sources.sources, selectedSourceIds });
  const audit = buildConstruction3dIntegrationAudit({ pack, client, campaignPrograms, scene, changeSet, review, currentSources: sources.sources });
  return { schema: CONSTRUCTION_3D_PREFLIGHT_SCHEMA, contractVersion: 1, coordinateProfile: profileProvided ? { status: profileStatus, packId: coordinateProfile?.packId ?? null, reason: profileStatus === "other-pack" ? "coordinate-profile-other-pack" : null } : null, sources, scene, sceneError, session, audit, readyForOptional3d: session.mode === "3d-available" && audit.applicable, fallback: session.mode === "2d-only" ? "2d-only" : null, notPerformed: ["unity-load", "render", "change-set-apply", "construction-approval", "clock-advance"] };
}
