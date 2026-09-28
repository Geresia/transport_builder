// Stages the Greater Tokyo city files under the names Subway Builder v1.7.1 looks for, and (with --install) copies
// them into the game's own city-data folder, where its local data server serves `/data/TYOTL/...` from.
//
//   stage:   subway-builder-export/city-TYOTL/{demand_data.json, roads.geojson, buildings_index.bin, tiles.pmtiles}
//              demand_data.json  <- demand_data.chome.json                  (export-subway-builder-demand-chome.mjs)
//              roads.geojson     <- roads.all.geojson + roads.outer.geojson  (23 wards + rest of Kanto, merged -
//                                     export-subway-builder-roads.mjs + export-subway-builder-roads-outer.mjs)
//              buildings_index.bin                                           (export-subway-builder-buildings-bin.mjs)
//              tiles.pmtiles     <- copied as-is, if already built           (export-subway-builder-tiles.mjs)
//   install: %APPDATA%\metro-maker4\cities\data\TYOTL\      (a NEW folder; nothing else in the game's data is touched)
//
// Undo: delete that TYOTL folder. Optional files the game also reads, not produced yet: runways_taxiways.geojson,
// ocean_depth_index.json, foundations.pmtiles.
//
// Usage: node scripts/install-subway-builder-city.mjs [--install]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPORT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
const STAGE = path.join(EXPORT, "city-TYOTL");
const install = process.argv.includes("--install");
fs.mkdirSync(STAGE, { recursive: true });

fs.copyFileSync(path.join(EXPORT, "demand_data.chome.json"), path.join(STAGE, "demand_data.json"));

// roads: merge the 23-ward file (real names, from Overpass) with the rest-of-Kanto file (no names - see that
// script's header) rather than a plain copy, so driving demand outside the 23 wards has roads to route on.
const inner = JSON.parse(fs.readFileSync(path.join(EXPORT, "roads.all.geojson"), "utf8"));
const outerPath = path.join(EXPORT, "roads.outer.geojson");
const outer = fs.existsSync(outerPath) ? JSON.parse(fs.readFileSync(outerPath, "utf8")) : null;
if (!outer) console.log("note: roads.outer.geojson not found - roads will stop at the 23-ward border (run scripts/export-subway-builder-roads-outer.mjs)");
fs.writeFileSync(path.join(STAGE, "roads.geojson"), JSON.stringify({ type: "FeatureCollection", features: [...inner.features, ...(outer?.features ?? [])] }));

if (!fs.existsSync(path.join(STAGE, "buildings_index.bin"))) throw new Error("missing buildings_index.bin - run scripts/export-subway-builder-buildings-bin.mjs first");
// tiles.pmtiles is written straight into STAGE by export-subway-builder-tiles.mjs (nothing to copy here).
if (!fs.existsSync(path.join(STAGE, "tiles.pmtiles"))) console.log("note: tiles.pmtiles not found - the map background will be empty (run scripts/export-subway-builder-tiles.mjs)");

const files = fs.readdirSync(STAGE).filter((f) => fs.statSync(path.join(STAGE, f)).isFile());
for (const f of files) console.log(`staged  ${f}  ${(fs.statSync(path.join(STAGE, f)).size / 1e6).toFixed(1)} MB`);

if (!install) { console.log("\nstaged only. Re-run with --install to copy into the game's cities\\data\\TYOTL folder."); process.exit(0); }

if (!process.env.APPDATA) throw new Error("APPDATA is not set - cannot locate the game's data folder");
const games = path.join(process.env.APPDATA, "metro-maker4", "cities", "data");
if (!fs.existsSync(games)) throw new Error(`${games} does not exist - is Subway Builder installed and run at least once?`);
const dest = path.join(games, "TYOTL");
fs.mkdirSync(dest, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(STAGE, f), path.join(dest, f));
console.log(`\ninstalled ${files.length} files into ${dest}`);
