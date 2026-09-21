// Build packs/tokyo/bathymetry.json from GEBCO_2026 sub-ice topography/bathymetry (15 arc-second grid,
// ~460 m x 370 m at Tokyo), read over OPeNDAP for the pack bbox. Values are metres relative to sea level
// (negative = below sea level, positive = land elevation), Int16 as published by GEBCO.
// Usage: node scripts/tokyo-bathymetry.mjs
import fs from "fs";
import zlib from "zlib";
import { fileURLToPath } from "url";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const URL_NC = "https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2026/sub_ice_topography_bathymetry/netcdf/GEBCO_2026_sub_ice.nc";
const STEP = 1 / 240, LON0 = -180 + STEP / 2, LAT0 = -90 + STEP / 2; // GEBCO cell centres
const manifest = JSON.parse(fs.readFileSync(T + "manifest.json", "utf8"));
const [w, s, e, n] = manifest.bbox;
const i0 = Math.floor((w - LON0) / STEP) - 1, i1 = Math.ceil((e - LON0) / STEP) + 1;
const j0 = Math.floor((s - LAT0) / STEP) - 1, j1 = Math.ceil((n - LAT0) / STEP) + 1;
const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
console.log({ rows, cols });
const res = await fetch(`${URL_NC}.ascii?elevation.elevation[${j0}:${j1}][${i0}:${i1}]`);
if (!res.ok) throw new Error("OPeNDAP HTTP " + res.status);
const text = await res.text();
const data = new Int16Array(rows * cols);
let k = 0;
for (const line of text.split("\n")) {
  const m = line.match(/^elevation\.elevation\[(\d+)\]\[(\d+)\], (.*)$/) ?? line.match(/^\[(\d+)\], (.*)$/);
  if (!m) continue;
  // ASCII rows look like "[jrow], v0, v1, ..." (row index then cols values) or "[j][i], v"
  const vals = (m.length === 4 ? m[3] : m[2]).split(",").map((v) => Number(v.trim()));
  for (const v of vals) data[k++] = v;
}
if (k !== rows * cols) throw new Error(`parsed ${k} values, expected ${rows * cols}; first lines:\n` + text.slice(0, 400));
let sea = 0, min = 0;
for (const v of data) { if (v < 0) sea++; if (v < min) min = v; }
const out = {
  formatVersion: 1,
  source: "GEBCO_2026 sub-ice topography/bathymetry grid (GEBCO Compilation Group), 15 arc-second, via BODC/CEDA OPeNDAP",
  units: "metres relative to sea level (negative = below sea level)",
  grid: { lon0: LON0 + i0 * STEP, lat0: LAT0 + j0 * STEP, step: STEP, cols, rows, order: "row-major, south to north, west to east; cell centres" },
  seaCells: sea, minDepth: min,
  values: Array.from(data),
};
fs.writeFileSync(T + "bathymetry.json", JSON.stringify(out));
console.log({ cells: data.length, seaCells: sea, minDepth: min, lon0: out.grid.lon0, lat0: out.grid.lat0 });
