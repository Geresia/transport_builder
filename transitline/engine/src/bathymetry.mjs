// Sea/land elevation lookup over the pack's bathymetry.json (GEBCO grid, see scripts/tokyo-bathymetry.mjs).
// depthAt() returns metres relative to sea level (negative = below sea level); null outside the grid.
// Pure module (no DOM) so it can be tested under plain node.
export class Bathymetry {
  constructor(json) {
    this.grid = json.grid;
    this.values = json.values instanceof Int16Array ? json.values : Int16Array.from(json.values);
  }

  _at(i, j) {
    const { cols, rows } = this.grid;
    return i < 0 || j < 0 || i >= cols || j >= rows ? null : this.values[j * cols + i];
  }

  // Bilinear between the four surrounding cell centres.
  depthAt([lon, lat]) {
    const { lon0, lat0, step } = this.grid;
    const x = (lon - lon0) / step, y = (lat - lat0) / step;
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const a = this._at(i, j), b = this._at(i + 1, j), c = this._at(i, j + 1), d = this._at(i + 1, j + 1);
    if (a === null || b === null || c === null || d === null) return null;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  isSea(location) {
    const d = this.depthAt(location);
    return d !== null && d < 0;
  }
}
