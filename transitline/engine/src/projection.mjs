// lon/lat (WGS84, as CityPacks store them) -> local metres -> canvas pixels.
// The format doc leaves projection to the engine; an equirectangular
// approximation is plenty accurate at CityPack scale (tens of km).

const R_EARTH_M = 6371000;

export function haversineMetres([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(a));
}

export function makeProjection(bbox, origin) {
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);
  const toMetres = ([lon, lat]) => [
    (lon - origin[0]) * (Math.PI / 180) * R_EARTH_M * cosLat,
    (lat - origin[1]) * (Math.PI / 180) * R_EARTH_M,
  ];

  const [minX, minY] = toMetres([bbox[0], bbox[1]]);
  const [maxX, maxY] = toMetres([bbox[2], bbox[3]]);
  const worldCenter = [(minX + maxX) / 2, (minY + maxY) / 2];
  const worldWidth = Math.max(maxX - minX, 1);
  const worldHeight = Math.max(maxY - minY, 1);

  let scale = 1;

  return {
    // Static fit-to-bbox camera — no pan/zoom in Phase 1. The whole pack
    // extent fits on screen at once, matching how the abstract-geometry
    // format is meant to render (docs/citypack-format.md).
    fitToCanvas(width, height, padding = 48) {
      scale = Math.min((width - padding * 2) / worldWidth, (height - padding * 2) / worldHeight);
    },
    toScreen([lon, lat], width, height) {
      const [x, y] = toMetres([lon, lat]);
      return [
        (x - worldCenter[0]) * scale + width / 2,
        -(y - worldCenter[1]) * scale + height / 2, // screen y grows down, lat grows north
      ];
    },
    get scale() {
      return scale;
    },
  };
}
