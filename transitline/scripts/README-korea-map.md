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

## 아티팩트 한도

claude.ai 아티팩트는 **16MB**. 배포판(11.5MB)은 들어가고 연구판(22.5MB)은 못 들어간다.
로컬 파일·git·게임 번들에는 이 제한이 없다.
