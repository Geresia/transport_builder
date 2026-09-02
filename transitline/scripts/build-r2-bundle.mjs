import fs from "fs";
import path from "path";

// R2 업로드 묶음을 한 곳에 모은다.  node build-r2-bundle.mjs [스크래치패드경로]
//
// 세션마다 다른 스크래치패드에 데이터가 흩어져 있으면 두 사람이 같은 걸 보고 작업할 수
// 없다. 그래서 산출물은 항상 transitline/r2/ 로 모은다 (gitignore 됨 — 파생물이라).
// HTML 만 git 에 있고, 그게 유일한 원본이다.

const SCRATCH = process.argv[2] ||
  "C:/Users/SJL/AppData/Local/Temp/claude/c--Users-SJL-subway-builder-modded/97c82ded-dfd7-4b0a-9d44-0a7a7fcbfef9/scratchpad";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const OUT = path.join(HERE, "..", "r2");
const DOCS = path.join(HERE, "..", "docs");

fs.mkdirSync(OUT, { recursive: true });

// [출력이름, 원본경로] — 원본이 없으면 건너뛰고 알려준다. 없는 파일은 페이지에서
// 그 기능만 빠지므로, 일부만 있어도 배포는 된다.
const FILES = [
  ["korea-basemap.html",    path.join(DOCS, "korea-basemap.html")],
  ["korea-demand.geojson",  path.join(DOCS, "korea-demand.geojson")],
  ["korea-sido.geojson",    path.join(OUT,  "korea-sido.geojson")],      // 아래에서 생성
  ["korea-age.json",        path.join(SCRATCH, "korea_age.json")],
  ["korea-grid.json",       path.join(SCRATCH, "grid_kr_clip.json")],
  ["korea-flow.json",       path.join(SCRATCH, "flow2.json")],
];

// 시도 경계는 배열 형식이라 GeoJSON 으로 바꿔서 내보낸다.
const sidoSrc = path.join(SCRATCH, "korea_sido.json");
if (fs.existsSync(sidoSrc)) {
  const S = JSON.parse(fs.readFileSync(sidoSrc, "utf8"));
  fs.writeFileSync(path.join(OUT, "korea-sido.geojson"), JSON.stringify({
    type: "FeatureCollection",
    features: S.map((s) => ({ type: "Feature",
      properties: { sd: s.sd, n: s.n, p: s.p, med: s.med },
      geometry: { type: "MultiPolygon", coordinates: s.g } })),
  }));
}

let total = 0, missing = [];
for (const [name, src] of FILES) {
  const dst = path.join(OUT, name);
  if (path.resolve(src) === path.resolve(dst)) {                 // 이미 제자리
    if (fs.existsSync(dst)) total += fs.statSync(dst).size; else missing.push(name);
    continue;
  }
  if (!fs.existsSync(src)) { missing.push(name); continue; }
  fs.copyFileSync(src, dst);
  total += fs.statSync(dst).size;
}

console.error(`transitline/r2/ ${(total / 1e6).toFixed(1)} MB`);
for (const f of fs.readdirSync(OUT).sort())
  console.error(`  ${f.padEnd(24)} ${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2)} MB`);
if (missing.length) console.error("\n빠짐(그 기능만 안 나옴):", missing.join(", "));
console.error("\nkorea.pmtiles(720MB)는 여기 안 둔다 — 한 번 올리면 바뀔 일이 없다.");
console.error("로컬 확인:  cd ../r2 && py -m http.server 8099");
