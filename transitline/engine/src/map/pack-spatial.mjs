// Turns optional CityPack gameplay geometry into the shared read-only spatial context.
// Missing files stay missing: downstream contracts report null/unknown instead of inventing safety.
import { buildingLayerFromObstacles, makeSpatialContext, waterLayerFromBarriers } from "./spatial.mjs";

const source = (name, pack) => ({
  name,
  license: pack.manifest?.data?.license ?? null,
});

export function spatialContextFromPack(pack) {
  const layers = {};
  if (Array.isArray(pack?.obstacles?.obstacles)) {
    layers.buildings = buildingLayerFromObstacles(pack.obstacles, {
      quality: "medium",
      source: source("CityPack building collision footprints", pack),
    });
  }
  if (Array.isArray(pack?.barriers?.barriers)) {
    layers.water = waterLayerFromBarriers(pack.barriers, {
      quality: "medium",
      source: source("CityPack water barriers", pack),
    });
  }
  return makeSpatialContext(layers);
}
