// B21-P3 persisted coordinate statement. Values are explicit host/player facts;
// this module never infers a datum or origin from a map pack.
import { normalizeConstruction3dCoordinates } from "./construction-3d-exchange.mjs";
export const CONSTRUCTION_3D_COORDINATE_PROFILE_SCHEMA = "transitline.construction-3d-coordinate-profile/1";
const clone = (value) => structuredClone(value);
const packId = (pack) => pack?.manifest?.id ?? pack?.id ?? null;
const packVersion = (pack) => pack?.manifest?.version ?? pack?.version ?? null;
export function createConstruction3dCoordinateProfile({ pack, coordinates = null } = {}) {
  const id = packId(pack); if (typeof id !== "string" || !id) throw new Error("coordinate profile needs a pack id");
  if (coordinates === null || coordinates === undefined) return { schema: CONSTRUCTION_3D_COORDINATE_PROFILE_SCHEMA, contractVersion: 1, packId: id, packVersion: packVersion(pack), coordinates: null, status: "not-stated", reasons: ["coordinates-not-stated"] };
  try { return { schema: CONSTRUCTION_3D_COORDINATE_PROFILE_SCHEMA, contractVersion: 1, packId: id, packVersion: packVersion(pack), coordinates: normalizeConstruction3dCoordinates(coordinates), status: "stated", reasons: [] }; }
  catch (error) { return { schema: CONSTRUCTION_3D_COORDINATE_PROFILE_SCHEMA, contractVersion: 1, packId: id, packVersion: packVersion(pack), coordinates: null, status: "invalid", reasons: [error instanceof Error ? error.message : String(error)] }; }
}
export function serializeConstruction3dCoordinateProfile(profile) { return JSON.stringify(profile); }
export function restoreConstruction3dCoordinateProfile(text, pack, { current = null } = {}) {
  if (text === null || text === undefined) return { profile: current ?? createConstruction3dCoordinateProfile({ pack }), rejected: false, warnings: [] };
  let parsed; try { parsed = JSON.parse(text); } catch { return { profile: current ?? createConstruction3dCoordinateProfile({ pack }), rejected: true, warnings: ["coordinate-profile-unreadable"] }; }
  if (parsed?.schema !== CONSTRUCTION_3D_COORDINATE_PROFILE_SCHEMA || parsed?.contractVersion !== 1 || parsed.packId !== packId(pack)) return { profile: current ?? createConstruction3dCoordinateProfile({ pack }), rejected: true, warnings: ["coordinate-profile-other-pack-or-invalid"] };
  const restored = createConstruction3dCoordinateProfile({ pack, coordinates: parsed.coordinates });
  return { profile: restored, rejected: false, warnings: parsed.packVersion !== packVersion(pack) ? ["coordinate-profile-pack-version-changed"] : [] };
}
export const detachedConstruction3dCoordinateProfile = (profile) => clone(profile);
