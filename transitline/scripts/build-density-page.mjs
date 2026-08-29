// density-map.template.html 에 데이터·지역명을 채워 완성된 HTML 을 뽑는다.
//
//   node build-density-page.mjs <지역명> <metro.json> <출력.html>
//
// 예:  node build-density-page.mjs 부산   ./busan/metro.json  transitline/docs/busan-density.html
//      node build-density-page.mjs 대구권 ./daegu/metro.json  transitline/docs/daegu-density.html
//
// 완성 후 <script> 의 CONFIG.view 만 손으로 조정 (meta.bbox 로 시작).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const [region, jsonPath, outPath] = process.argv.slice(2);
if (!region || !jsonPath || !outPath) {
  console.error("usage: node build-density-page.mjs <지역명> <metro.json> <출력.html>");
  process.exit(1);
}

const tplPath = resolve(dirname(fileURLToPath(import.meta.url)), "density-map.template.html");
let html = readFileSync(tplPath, "utf8");
const data = readFileSync(jsonPath, "utf8");
JSON.parse(data); // metro.json 이 유효 JSON 인지 확인 (아니면 여기서 죽음)

if ((html.match(/__DATA__/g) || []).length !== 1) throw new Error("template 에 __DATA__ 가 1개가 아님");
if (!html.includes("__REGION__")) throw new Error("template 에 __REGION__ 이 없음");

html = html.replaceAll("__REGION__", region).replace("__DATA__", data);

if (html.includes("__DATA__") || html.includes("__REGION__")) throw new Error("자리표시자가 남음");
writeFileSync(outPath, html);
console.log(`${outPath} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, region "${region}"`);
