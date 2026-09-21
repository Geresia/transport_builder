// Score a pack's self-assessed data quality (manifest.quality) with scripts/quality-rubric.mjs.
//   node scripts/pack-quality.mjs packs/tokyo            print scores
//   node scripts/pack-quality.mjs packs/tokyo --write    store them in manifest.quality.computed (validate-pack recomputes and compares)
import fs from "node:fs";
import path from "node:path";
import { computeQuality, RUBRIC_VERSION } from "./quality-rubric.mjs";

const dir = process.argv[2], write = process.argv.includes("--write");
if (!dir) throw new Error("usage: pack-quality.mjs <pack dir> [--write]");
const mp = path.join(dir, "manifest.json");
const m = JSON.parse(fs.readFileSync(mp, "utf8"));
if (!m.quality?.answers) throw new Error("manifest.quality.answers is missing");

const show = (label, a) => {
  const c = computeQuality(a);
  console.log(`${label.padEnd(26)} weighted ${c.weighted_score.toFixed(3)}  raw ${c.raw_score.toFixed(3)}  ${c.tier} (${c.grade})   workplace ${c.pillars.workplace.weighted.toFixed(2)}  resident ${c.pillars.resident.weighted.toFixed(2)}  od ${c.pillars.od.weighted.toFixed(2)}`);
  return c;
};
m.quality.rubric_version = RUBRIC_VERSION;
m.quality.computed = show("core", m.quality.answers);
for (const [name, area] of Object.entries(m.quality.areas ?? {})) area.computed = show(name, area.answers);
if (write) { fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n"); console.log("wrote", mp); }
