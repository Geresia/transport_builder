// node engine/test/od-demand.test.mjs - measured O/D destination choice on the real tokyo pack (no browser needed).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { odRowsByStation } from "../src/od-flows.mjs";
const P = fileURLToPath(new URL("../../packs/tokyo/", import.meta.url));
const demand = JSON.parse(fs.readFileSync(P + "demand.json", "utf8"));
const od = JSON.parse(fs.readFileSync(P + "od.json", "utf8"));
const stations = new Map(demand.points.map((p) => [p.id, { id: p.id, location: p.location, residents: p.residents, jobs: p.residents * 0.4 }]));
const state = { stations, attractors: [], calendar: null, simMinutes: 0 };
let fail = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fail++; };

// 1. rows: every origin present, no self flow, weights equal the od.json destination counts
const rows = odRowsByStation(demand, od);
check(rows.size === demand.points.length, `every demand point has an O/D row (${rows.size}/${demand.points.length})`);
const idOf = (code) => demand.points.find((p) => (p.jisCode !== undefined ? String(p.jisCode).slice(0, 5) : p.code) === code).id;
const chiyoda = rows.get(idOf("13101"));
check(!chiyoda.row.some((x) => x.id === idOf("13101")), "no self flow in a row");
check(chiyoda.total === Object.values(od.origins["13101"].dest).reduce((a, b) => a + b, 0), "Chiyoda row total == sum of od.json dest");

// 2. sampled destinations follow the measured shares (Chiyoda -> Minato/Chuo/Shinjuku are the top three)
const model = buildDemandModel(state, demand, od);
check(model.measuredOrigins === demand.points.length, "model reports all origins measured");
let seed = 7; const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const N = 200000, cnt = new Map();
for (let i = 0; i < N; i++) { const d = model.pick(state, idOf("13101"), rand); cnt.set(d, (cnt.get(d) ?? 0) + 1); }
let maxErr = 0;
for (const { id, weight } of chiyoda.row) maxErr = Math.max(maxErr, Math.abs((cnt.get(id) ?? 0) / N - weight / chiyoda.total));
check(maxErr < 0.005, `sampled shares within 0.5 pt of measured (max error ${(maxErr * 100).toFixed(3)} pt)`);
const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
check(top.join() === ["13103", "13102", "13104"].map(idOf).join(), "top destinations for Chiyoda: Minato, Chuo, Shinjuku");

// 3. volume is unchanged versus gravity; without od the model is plain gravity
const grav = buildDemandModel(state, demand, null);
check(demand.points.every((p) => model.rate(state, p.id) === grav.rate(state, p.id)), "spawn rate per origin identical to gravity");
check(grav.measuredOrigins === undefined, "no od -> plain gravity model");

// 4. destinations that are not stations are dropped, and an origin left without any falls back to gravity
const few = new Map([...stations].filter(([id]) => id === idOf("13101") || id === idOf("13103")));
const m2 = buildDemandModel({ ...state, stations: few }, demand, od);
check([...Array(200)].every(() => m2.pick(state, idOf("13101"), rand) === idOf("13103")), "only-station destination is always picked");
process.exit(fail ? 1 : 0);
