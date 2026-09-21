// Write gzip siblings (`x.json.gz`) for a pack's large JSON files and record them in manifest.compressed.
// Originals are NOT touched or deleted: other scripts still read the plain files, and loaders
// (viewer.html loadJSON, engine/src/pack.mjs) prefer the .gz sibling and fall back to plain.
// Once nothing else needs the plain copies, delete them to shrink the pack (they stay in git history).
// Usage: node scripts/pack-compress.mjs <pack dir> [--min-kb 1024] [--dry]
import fs from "fs";
import path from "path";
import zlib from "zlib";
const dir = process.argv[2];
if (!dir) throw new Error("usage: pack-compress.mjs <pack dir> [--min-kb N] [--dry]");
const minKb = Number(process.argv[process.argv.indexOf("--min-kb") + 1]) || 1024, dry = process.argv.includes("--dry");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json" && fs.statSync(path.join(dir, f)).size >= minKb * 1024);
const compressed = {};
let before = 0, after = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f));
  const gz = zlib.gzipSync(raw, { level: 9 });
  if (!zlib.gunzipSync(gz).equals(raw)) throw new Error(`round-trip mismatch: ${f}`);
  if (!dry) fs.writeFileSync(path.join(dir, f + ".gz"), gz);
  compressed[f] = { file: f + ".gz", encoding: "gzip", bytes: raw.length, gzBytes: gz.length };
  before += raw.length; after += gz.length;
  console.log(f.padEnd(28), (raw.length / 1e6).toFixed(2) + " MB ->", (gz.length / 1e6).toFixed(2) + " MB", (100 * gz.length / raw.length).toFixed(1) + "%");
}
console.log("total", (before / 1e6).toFixed(1), "MB ->", (after / 1e6).toFixed(1), "MB", (100 * after / before).toFixed(1) + "%");
if (!dry) {
  const mp = path.join(dir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  m.compressed = compressed;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
}
