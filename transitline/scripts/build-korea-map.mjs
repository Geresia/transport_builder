import fs from "fs";

// 전국 지도 조립. node build_korea.mjs <출력경로> [--no-oa] [--no-flow]
// --no-oa   상세 분포 제외.
// --grid    상세를 집계구 대신 **1km 격자**로. 집계구는 비영리 연구 한정이라
//           상업 배포판은 반드시 --grid 로 빌드해야 한다(격자는 이용허락 제한 없음).
// --no-flow 생활이동 제외.
const out = process.argv[2] || "korea-map.html";
const noOA = process.argv.includes("--no-oa");
const useGrid = process.argv.includes("--grid");
const noFlow = process.argv.includes("--no-flow");

const rd = (p) => fs.readFileSync(p, "utf8");
let html = rd("korea-template.html");

const parts = {
  __DATA__: rd("korea/metro.json"),
  __AGE__:  rd("korea_age.json"),
  __SIDO__: rd("korea_sido.json"),
  __OA__:   noOA ? '{"index":{},"names":[],"blob":""}' : rd(useGrid ? "grid_kr_clip.json" : "oa_kr_clip.json"),
  __FLOW__: noFlow ? '{"dests":[],"vb":[1,1],"originList":[],"blob":"","sggFlows":{},"sggOrigins":{}}' : rd("flow2.json"),
};
for (const [k, v] of Object.entries(parts)) {
  if (!html.includes(k)) throw new Error(`템플릿에 ${k} 자리가 없음`);
  html = html.replace(k, () => v);              // $& 같은 치환 패턴 방지
}

fs.writeFileSync(out, html);
const mb = fs.statSync(out).size / 1e6;
console.error(`${out} ${mb.toFixed(2)} MB${noOA ? " (집계구 없음)" : ""}`);
for (const [k, v] of Object.entries(parts)) console.error(`  ${k.padEnd(9)} ${(v.length/1e6).toFixed(2)} MB`);
if (mb > 16) console.error(`  ⚠ 아티팩트 한도 16MB 초과 — 로컬 전용`);
