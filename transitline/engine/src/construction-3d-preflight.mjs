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
  const activeCoordinates = profileProvided ? (coordinateProfile?.status === "stated" ? coordinateProfile.coordinates : null) : coordinates;
  let scene = null; let sceneError = null;
  try { scene = buildConstruction3dSceneManifest({ pack, coordinates: activeCoordinates, sources: sources.sources }); }
  catch (error) { sceneError = error instanceof Error ? error.message : String(error); }
  const session = assessConstruction3dSession({ pack, client, scene, currentSources: sources.sources, selectedSourceIds });
  const audit = buildConstruction3dIntegrationAudit({ pack, client, campaignPrograms, scene, changeSet, review, currentSources: sources.sources });
  return { schema: CONSTRUCTION_3D_PREFLIGHT_SCHEMA, contractVersion: 1, coordinateProfile: profileProvided ? { status: coordinateProfile?.status ?? null, packId: coordinateProfile?.packId ?? null } : null, sources, scene, sceneError, session, audit, readyForOptional3d: session.mode === "3d-available" && audit.applicable, fallback: session.mode === "2d-only" ? "2d-only" : null, notPerformed: ["unity-load", "render", "change-set-apply", "construction-approval", "clock-advance"] };
}
