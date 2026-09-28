// Generated stand-in layers for the synthetic packs (example-radial / example-corridor), so their station-site
// examples can show what the contract looks like when spatial facts ARE known. Pure and deterministic: the same
// centre gives the same layers, and the tests rebuild examples from this file. The layers describe an invented
// district, not any real place, and are labelled so in `source` (license CC0-1.0, like the synthetic packs).
import { polygonLayer, roadLayerFromGeojson } from "../../engine/src/map/spatial.mjs";

const HALF = 0.02; // layers cover ~2.2 km around the centre
const PITCH = 0.0006; // building grid, ~67 m
const SIZE = 0.0003; // building footprint edge, ~33 m
const source = (name) => ({ name: `${name} (generated for the synthetic example packs)`, license: "CC0-1.0" });
const box = ([lon, lat], h) => [lon - h, lat - h, lon + h, lat + h];
const inBox = (b) => ([x, y]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

// only: layer names to include (default all). clearing: no buildings within this many degrees of the centre (0 = buildings everywhere).
// blockedAt: [lon, lat] points that always get a building footprint centred on them.
export function syntheticLayers(center, { only = null, clearing = 0.0012, blockedAt = [] } = {}) {
  const [cx, cy] = center;
  const covers = inBox(box(center, HALF));
  const want = (name) => !only || only.includes(name);
  const layers = {};

  if (want("dem")) {
    // a gentle 1.5 % ground slope, and an escarpment east of the centre
    layers.dem = {
      elevationAt: ([x, y]) => 10 + 1500 * (x - cx) + 600 * (y - cy) + (x > cx + 0.012 ? 40 : 0),
      slopeAt: ([x]) => (x > cx + 0.012 && x < cx + 0.0125 ? 6 : 0.83),
      covers, quality: "medium", source: source("Synthetic terrain"),
    };
  }
  if (want("water")) {
    layers.water = polygonLayer([{ rings: [rect(cx - HALF, cy - 0.0045, cx + HALF, cy - 0.0035)] }], { covers, quality: "medium", source: source("Synthetic river") });
  }
  if (want("roads")) {
    const line = (coordinates, roadClass) => ({ geometry: { coordinates }, properties: { roadClass } });
    layers.roads = roadLayerFromGeojson({ features: [
      line([[cx - HALF, cy + 0.0003], [cx + HALF, cy + 0.0003]], "major"),
      line([[cx + 0.0012, cy - HALF], [cx + 0.0012, cy + HALF]], "minor"),
      line([[cx - HALF, cy + 0.009], [cx + HALF, cy + 0.009]], "highway"),
    ] }, { covers, quality: "medium", source: source("Synthetic roads") });
  }
  if (want("buildings")) {
    const items = [];
    for (let i = -8; i < 8; i++) for (let j = -8; j < 8; j++) {
      const x = cx + (i + 0.5) * PITCH;
      const y = cy + (j + 0.5) * PITCH;
      if (Math.hypot(x - cx, y - cy) < clearing) continue;
      items.push({ rings: [rect(x - SIZE / 2, y - SIZE / 2, x + SIZE / 2, y + SIZE / 2)], kind: (i + j) % 3 === 0 ? "apartments" : "yes" });
    }
    for (const [x, y] of blockedAt) items.push({ rings: [rect(x - SIZE / 2, y - SIZE / 2, x + SIZE / 2, y + SIZE / 2)], kind: "commercial" });
    layers.buildings = polygonLayer(items, { covers, quality: "medium", source: source("Synthetic building footprints") });
  }
  if (want("landuse")) {
    layers.landuse = polygonLayer([{ rings: [rect(cx - 0.0026, cy + 0.0009, cx - 0.0012, cy + 0.0021)], kind: "park" }], { covers, quality: "medium", source: source("Synthetic land use") });
  }
  return layers;
}
