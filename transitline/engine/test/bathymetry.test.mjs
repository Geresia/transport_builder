// node engine/test/bathymetry.test.mjs — spot checks of the Tokyo-pack bathymetry grid.
import fs from "fs";
import { Bathymetry } from "../src/bathymetry.mjs";
const b = new Bathymetry(JSON.parse(fs.readFileSync(new URL("../../packs/tokyo/bathymetry.json", import.meta.url), "utf8")));
const checks = [
  ["Tokyo Station (land)", [139.767, 35.681], (d) => d > -1],
  ["Mt Fuji summit area (high land)", [138.7274, 35.3606], (d) => d > 3000],
  ["central Tokyo Bay", [139.85, 35.5], (d) => d < -5 && d > -60],
  ["Sagami Bay deep", [139.4, 34.95], (d) => d < -300],
  ["outside grid", [100, 10], (d) => d === null],
];
let bad = 0;
for (const [name, p, ok] of checks) { const d = b.depthAt(p); const pass = ok(d); if (!pass) bad++; console.log(pass ? "ok  " : "FAIL", name, d === null ? null : Math.round(d) + " m"); }
if (bad) process.exit(1);
