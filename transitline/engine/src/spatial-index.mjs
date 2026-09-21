// Uniform-grid spatial index over lon/lat points. Cells are ~100 m: a fixed
// latitude step, and a longitude step widened by 1/cos(lat) so cells stay
// roughly square away from the equator (Tokyo: 1 deg lon ~ 90 km, 1 deg lat ~ 111 km).
// Pure module (no DOM) so it can be tested under plain node.
import { haversineMetres } from "./projection.mjs";

const M_PER_DEG_LAT = 111320;

export class GridIndex {
  // refLat picks the longitude correction; use the pack's origin/center latitude.
  constructor(refLat, cellMetres = 100) {
    this.cellLat = cellMetres / M_PER_DEG_LAT;
    this.cellLon = cellMetres / (M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180));
    this.cellMetres = cellMetres;
    this.cells = new Map(); // "cx,cy" -> [{ id, location }]
    this.size = 0;
  }

  _cell([lon, lat]) {
    return [Math.floor(lon / this.cellLon), Math.floor(lat / this.cellLat)];
  }

  insert(id, location) {
    const [cx, cy] = this._cell(location);
    const key = `${cx},${cy}`;
    let bucket = this.cells.get(key);
    if (!bucket) this.cells.set(key, (bucket = []));
    bucket.push({ id, location });
    this.size++;
  }

  // Every entry within radiusMetres of `location`, nearest first: [{ id, location, distance }].
  within(location, radiusMetres) {
    const [cx, cy] = this._cell(location);
    const rx = Math.ceil(radiusMetres / this.cellMetres) + 1;
    const out = [];
    for (let x = cx - rx; x <= cx + rx; x++) {
      for (let y = cy - rx; y <= cy + rx; y++) {
        for (const e of this.cells.get(`${x},${y}`) ?? []) {
          const distance = haversineMetres(location, e.location);
          if (distance <= radiusMetres) out.push({ ...e, distance });
        }
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // Nearest entry, or null when empty / nothing within maxRadiusMetres. Searches square rings
  // outward and stops once no unvisited ring can hold something closer.
  nearest(location, maxRadiusMetres = Infinity) {
    if (this.size === 0) return null;
    const [cx, cy] = this._cell(location);
    // A point in ring r is at least (r - 1) cells away along one axis; use the smaller axis length.
    const cellMinM = Math.min(this.cellMetres, this.cellLon * M_PER_DEG_LAT * Math.cos((location[1] * Math.PI) / 180));
    let best = null;
    const maxRing = Number.isFinite(maxRadiusMetres) ? Math.ceil(maxRadiusMetres / cellMinM) + 1 : Infinity;
    for (let r = 0; r <= maxRing; r++) {
      if (best && (r - 1) * cellMinM > best.distance) break;
      // Unbounded search on a sparse grid: fall back to a full scan instead of walking huge rings.
      if (r > 64 && !Number.isFinite(maxRadiusMetres)) return this._scan(location);
      for (let x = cx - r; x <= cx + r; x++) {
        for (let y = cy - r; y <= cy + r; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // ring only
          for (const e of this.cells.get(`${x},${y}`) ?? []) {
            const distance = haversineMetres(location, e.location);
            if (!best || distance < best.distance) best = { ...e, distance };
          }
        }
      }
    }
    return best && best.distance <= maxRadiusMetres ? best : null;
  }

  _scan(location) {
    let best = null;
    for (const bucket of this.cells.values()) {
      for (const e of bucket) {
        const distance = haversineMetres(location, e.location);
        if (!best || distance < best.distance) best = { ...e, distance };
      }
    }
    return best;
  }
}
