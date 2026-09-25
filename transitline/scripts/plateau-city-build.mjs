// Build one PLATEAU city end to end: download the 3D Tiles zip (resumable, retried), extract the LOD1 building tiles,
// read their attributes (plateau-buildings.mjs), compute per-building workers (plateau-city-jobs.mjs), clean up.
// Usage: node scripts/plateau-city-build.mjs <slug> [--keep]     (cities are defined in plateau-cities.json)
//   --keep  leave the extracted tiles and intermediate plateau-<slug>.json in data-raw/plateau/work/ for inspection.
// Needs: `tar` (Windows 10+ bsdtar is fine), network, and the draco3d decoder for newer (2022+) exports - installed
// automatically into data-raw/plateau/deps on first use (`npm install draco3d`). All of data-raw/plateau/ is git-ignored.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(HERE, "../data-raw/plateau");
const [slug, ...flags] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "plateau-cities.json"), "utf8")).cities.find((c) => c.slug === slug);
if (!cfg) throw new Error(`no city '${slug}' in plateau-cities.json`);
const keep = flags.includes("--keep");
fs.mkdirSync(RAW, { recursive: true });
const zipPath = path.join(RAW, `${slug}-3dtiles-etc.zip`), work = path.join(RAW, "work", slug);
const log = (...a) => console.log(`[${slug}]`, ...a);

async function download() {
  const head = await fetch(cfg.zip, { method: "HEAD", redirect: "follow" });
  const total = Number(head.headers.get("content-length"));
  if (!total) throw new Error("no content-length for " + cfg.zip);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const have = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    if (have === total) return total;
    if (have > total) fs.rmSync(zipPath);
    try {
      log(`download attempt ${attempt}: ${(have / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
      const res = await fetch(cfg.zip, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
      if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status);
      if (have && res.status !== 206) fs.rmSync(zipPath); // server ignored Range: restart
      const out = fs.createWriteStream(zipPath, { flags: have && res.status === 206 ? "a" : "w" });
      for await (const chunk of res.body) if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      await new Promise((r) => out.end(r));
    } catch (e) { log("download interrupted:", e.message); await new Promise((r) => setTimeout(r, 4000 * attempt)); }
  }
  if (fs.statSync(zipPath).size !== total) throw new Error(`incomplete download: ${fs.statSync(zipPath).size} of ${total} bytes`);
  return total;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed:\n${(r.stderr || "") + (r.stdout || "")}`.slice(0, 1500));
  return r.stdout;
}

function ensureDraco() {
  const deps = path.join(RAW, "deps");
  if (!fs.existsSync(path.join(deps, "node_modules", "draco3d"))) {
    log("installing draco3d decoder ...");
    fs.mkdirSync(deps, { recursive: true });
    if (!fs.existsSync(path.join(deps, "package.json"))) fs.writeFileSync(path.join(deps, "package.json"), '{"name":"plateau-deps","private":true}');
    run("npm", ["install", "draco3d"], { cwd: deps, shell: true });
  }
  return deps;
}

log("zip:", cfg.zip);
await download();
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
log("extracting tiles", cfg.tiles);
// On Windows use the bundled bsdtar explicitly: a GNU tar earlier on PATH (Git Bash) reads "C:" as a remote host.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe") : "tar";
run(TAR, ["-xf", zipPath, cfg.tiles], { cwd: work });
const json = path.join(work, `plateau-${slug}.json`);
log("reading building attributes ...");
const extract = run("node", ["--max-old-space-size=8000", path.join(HERE, "plateau-buildings.mjs"), work, json], { env: { ...process.env, DEPS: ensureDraco() } });
log(extract.split("\n").slice(0, 10).join(" ").replace(/\s+/g, " "));
log("computing per-building workers ...");
const res = run("node", ["--max-old-space-size=8000", path.join(HERE, "plateau-city-jobs.mjs"), slug, json]);
console.log(res.trim().split("\n").pop());
if (!keep) { fs.rmSync(work, { recursive: true, force: true }); log("cleaned up work dir (zip kept in data-raw/plateau/)"); }
