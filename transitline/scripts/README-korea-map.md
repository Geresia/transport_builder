# 대한민국 인구 지도 — 빌드

전국 → 시도 → 행정동 3단 드릴다운. 동을 누르면 인구 피라미드 · 동 내부 인구분포 · 생활이동이 나온다.

## 두 벌을 만든다

| | 빌드 | 크기 | 상세분포 | 배포 |
|---|---|---|---|---|
| **배포판** | `--grid` | 11.5MB | 1km 격자 | 상용 게임 OK |
| **연구판** | 플래그 없음 | 22.5MB | 집계구 | **로컬 전용** |

```bash
node build-korea-map.mjs ../docs/korea-density-game.html --grid   # 배포판
node build-korea-map.mjs ../docs/korea-density.html               # 연구판
```

## ⚠️ 배포판은 반드시 `--grid`

**SGIS 집계구는 비영리 연구·교육 목적으로 승인받은 자료다.** 상용 게임에 넣거나 재배포하면
승인 조건 위반이다. 배포판에는 절대 들어가면 안 된다.

`--grid` 가 쓰는 1km 격자는 공공데이터포털 15141768, **이용허락범위 제한 없음** → 상업 사용 가능.
정밀도는 집계구보다 낮다 (남사읍 유효밀도: 단순 400 → 격자 5,437 → 집계구 30,146).

같은 이유로 **250m 정밀판(OSM 건물 dasymetric)도 배포판에 못 쓴다** — OSM 은 ODbL 이라
파생 DB 에 동일조건 배포 의무가 붙는다.

## 데이터 준비

빌드 입력은 저장소에 없다. 용량이 크고 일부는 승인자료라서다. 스크래치패드에서 만든다.

| 파일 | 만드는 법 | 출처 |
|---|---|---|
| `korea/metro.json` | `build-metro-demand.mjs` | 행안부 주민등록 + admdongkor 경계 |
| `korea_age.json` | 연령·성별 5세 버킷 | data.go.kr 15097972 |
| `korea_sido.json` | `build-sido-union.mjs` | 위 경계를 시도로 union |
| `grid_kr_clip.json` | `build-korea-grid.mjs` | data.go.kr 15141768 (1km 격자) |
| `oa_kr_clip.json` | `build-korea-oa-parse.mjs` → `build-korea-oa-clip.mjs` | SGIS 집계구 (**승인자료**) |
| `flow2.json` | `build_flow2.mjs` | 서울 열린데이터광장 OA-22300 |

## 플래그

- `--grid` 상세분포를 집계구 대신 1km 격자로 (배포판 필수)
- `--no-oa` 상세분포 아예 제외
- `--no-flow` 생활이동 제외

## 갈래가 둘이다 — 헷갈리지 말 것

같은 데이터로 만드는 지도가 두 종류다. **서로 독립이고, 고쳐도 상대에 안 옮는다.**

| | SVG 판 | 베이스맵 판 |
|---|---|---|
| 파일 | `docs/korea-density*.html` | `docs/korea-basemap.html` |
| 원본 | `scripts/korea-map.template.html` | 그 HTML 자체 (템플릿 없음) |
| 배경 | 없음 (경계선만) | **OSM 도로·건물** (MapLibre + pmtiles) |
| 여는 법 | 더블클릭 | **HTTP 필요** (`py -m http.server`) |
| 데이터 | HTML 안에 인라인 | 옆 파일들을 fetch |
| 아티팩트 | 가능 (16MB 한도) | **불가** — CSP 가 타일 fetch 를 막음 |
| 배포 | claude.ai / git | 자체 호스팅 (Cloudflare R2) |

### 베이스맵 판 (`docs/korea-basemap.html`)

**이 파일이 유일한 원본이다.** 복사본을 따로 만들지 말 것 — 한 번 갈라지면 고친 게 서로 안 옮는다.

기능: 시도 레이어(z8 미만) → 행정동 → 동 클릭 시 오른쪽 패널(인구 피라미드 · 1km 격자 상세 ·
생활이동). 격자와 이동선은 **실제 지도 위에** 그린다.

```bash
node build-r2-bundle.mjs        # 업로드 묶음을 transitline/r2/ 에 모은다
cd ../r2 && py -m http.server 8099
```

R2 버킷에 `transitline/r2/` 내용을 올리면 배포된다. `korea.pmtiles`(720MB)는 한 번만 올리면 된다.

**⚠️ R2 는 공개 버킷이라 집계구를 올리면 공개 재배포가 된다.** 상세분포는 1km 격자만 쓴다.

없는 데이터 파일은 그 기능만 조용히 빠지므로, 일부만 올려도 지도는 뜬다.

## 아티팩트 한도

claude.ai 아티팩트는 **16MB**. 배포판(11.5MB)은 들어가고 연구판(22.5MB)은 못 들어간다.
로컬 파일·git·게임 번들에는 이 제한이 없다.
