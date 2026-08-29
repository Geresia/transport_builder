// Validates every pack under packs/. Exits non-zero if any fails.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const packsDir = "packs";
const packs = readdirSync(packsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(packsDir, d.name, "manifest.json")))
  .map((d) => join(packsDir, d.name));

if (packs.length === 0) {
  console.error("no packs found under packs/");
  process.exit(1);
}

let failed = 0;
for (const p of packs) {
  const r = spawnSync(process.execPath, ["scripts/validate-pack.mjs", p], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(`\n${packs.length - failed}/${packs.length} packs valid`);
process.exit(failed ? 1 : 0);
