# 지도 쪽 출력 계약 (지도 → 경영 엔진)

엔진이 받는 입력 형식은 [plan-geometry-contract-v1.md](plan-geometry-contract-v1.md)가 정한다. 이 문서는 **지도 쪽이 그 입력을 어떻게 채워 보내는지**, 결측·ID·라이선스 규칙을 적는다. 코드는 `engine/src/map/`에 있고 `engine/src/management/**`는 수정하지 않는다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `engine/src/map/plan-geometry.mjs` | 그린 노선 → PlanGeometry, 기존망 → ExternalNetwork, 수요지점 → 접근 링크. 진입점 `buildMapExport()` |
| `engine/src/map/spatial.mjs` | 주입된 레이어로 고도·경사·교차 계산. 자체 데이터 없음 |
| `engine/src/map/overlay.mjs` | 엔진 보고서 → 공사 단계 색·진단 표시(읽기 전용) |
| `scripts/build-plan-examples.mjs` | 개발 시점에 DEM·팩 데이터를 읽어 `packs/<id>/plan-examples/*.plan.json` 생성 (`npm run plan-examples`) |

## 출력

`buildMapExport({ pack, mode, drawnLines, spatial })` → `{ schema, packId, packVersion, mode, demandNodes, externalNetworks, plans[], demandCoverage, warnings }`

- 두 시작 모드(`existing` 기존망 / `scratch` 완전 신설)가 **같은 키 구성**을 낸다. `scratch`는 `externalNetworks: []`, 환승 대상 없음.
- 팩에 기존망이 없는데 `existing`을 요청하면 `scratch`로 처리하고 `warnings`에 `no-existing-network`를 남긴다.
- 수요지점(`demandNodes`)은 역과 분리되어 있다. 역이 없는 수요지점도 오류가 아니며 `demandCoverage.withoutStations`로 센다.

## ID 규칙 (같은 입력 = 같은 ID)

- 시계·난수·그린 순서·노선 번호를 쓰지 않는다. 좌표는 소수 6자리로 반올림해 해시한다.
- `planId` = `key`가 있으면 팩ID+`key`, 없으면 팩ID+정점 좌표. 노선 이름을 바꿔도 ID는 그대로다.
- 편집하면서도 ID를 유지하려면 그린 노선에 `key`를 저장해 둔다. (`state.lines[].key`, 기본 `null`)
- 역 ID = 팩ID+좌표, 구간 ID = 두 역 ID, 접근 링크 ID = 수요지점+역. 팩 **버전**은 ID에 넣지 않는다(팩이 갱신돼도 ID 유지, 버전은 `sourcePackVersion`).

## 결측 규칙

값을 못 구하면 **0으로 채우지 않고 `null`**, 이름을 `unknown[]`에 적는다. 추정한 값은 `inferred[]`와 `…Basis`에 근거를 적는다.

- 예외: `platformLengthM`은 엔진이 `null`을 0으로 읽어 "승강장 짧음"으로 오판하므로 **키를 생략**하고 `unknown[]`에만 적는다.
- `dataQuality`는 `high|medium|low`만 낸다(`unknown`은 내지 않음). 지반 자료(지하수·연약지반)가 어떤 팩에도 없어서 `constraintUnknown`이 항상 있고, 그래서 현재는 `high`가 나오지 않는다.
- 레이어가 구간을 덮지 못하면(예: 건물 자료는 신주쿠 등 4개 구역뿐) 그 교차 값은 0이 아니라 `null`.
- 예외 하나: `scratch` 모드의 `crossings.railway`는 0이다. 그 세계에는 외부 철도망이 없다는 것이 사실이기 때문.

## 채우는 값

- **역**: `id, location, name(+nameSource), structure(+structureBasis), depthMeters, platformType(island|side|null), groundElevationMeters, transferTargets[]`. 환승 대상은 반경 500 m 안의 외부망 역.
- **구간**: `from, to, lengthMeters, elevationStartMeters, elevationEndMeters, gradientPermille, maxSlopeDegrees, steepShare, minCurveRadiusMeters, structureHint(+Basis), constraintFlags[], crossings{river, road{highway,major,minor}, railway, building, utility}`.
  - 곡선반경은 그린 선형이 허용하는 값(꼭짓점 접선길이 ≤ 짧은 변의 절반). 직선은 상한 `100000`.
  - `steep-slope` 플래그는 구간의 25% 이상이 3° 이상 지형일 때(제방 같은 얇은 급경사 셀 때문에 최댓값이 아니라 비율을 쓴다).
  - `utility` 교차는 자료가 없어 항상 `null`.
- **접근 링크**: 수요지점당 800 m 안 가까운 역 최대 3개, `walkMinutes = 직선거리 × 1.3 / 80 m/분`, 최소 1분(엔진이 0분을 거절).

## 엔진 계약 v1 문서와 다른 점

| 항목 | v1 문서 | 지도 출력 |
|---|---|---|
| 자료 없음 | 필드 생략 | `null` + `unknown[]` (예외: `platformLengthM`은 생략) |
| 곡선반경 | `curveRadiusMeters` | `minCurveRadiusMeters` (엔진이 `?? curveRadiusMeters`로 둘 다 읽음) |
| `dataQuality` | `unknown` 허용 | `high/medium/low`만 |
| 추가 필드 | — | `crossings`, `steepShare`, `unknown/inferred`, `sources` 등. 엔진은 무시 |

`null`과 생략 중 무엇이 맞는지는 엔진 쪽 합의가 필요하다. 현재 `engine/test/map-contract.test.mjs`는 `null`을 기대한다.

## 공사 상태 표시 (엔진 → 지도)

지도는 엔진 보고서 `{ plans[], projects[], assessments{planId} }`를 읽어 표시만 한다.

| 엔진 상태 | 지도 표시 |
|---|---|
| 기록 없음, `needs-information`, `rejected` | 계획 |
| `assessed`, `approved`, `in-project`, 프로젝트 `estimated` | 심사 중 |
| 프로젝트 `contracted`, `underConstruction` | 공사 중 (`delayMonths>0`이면 지연 표시) |
| 프로젝트 `cancelled`, `suspended`, `halted` | 공사 중단 |
| 프로젝트 `inspection` | 검사 중 |
| 프로젝트 `available`, 기록 `assets-available`, `commissioned` | 사용 가능 |
| 그 외 | 상태 불명 (추정하지 않고 경고) |

- 엔진에는 전용 "공사 중단" 상태가 아직 없어 취소(`cancelled`)를 그렇게 표시한다. 전용 상태가 생기면 `PROJECT_PHASE`만 고치면 된다.
- 위반은 오류, 누락 입력·조건부 판정은 경고, 지도 쪽 미상·추정은 정보로 표시하며, 엔진 메시지의 `Segment N`, `Station <id>`, `stationCandidates.<id>.…`로 대상 구간·역을 찾는다(못 찾으면 계획 전체).
- 편집 화면에서는 `window.transitlineMap.setEngineReport(report)`로 보고서를 넘긴다. 지도 코드는 원장·계약·공사 상태를 쓰지 않고 `management`를 import하지 않는다(테스트가 검사).

## 라이선스와 경계

- `engine/src/map/`은 **데이터를 담지 않는다.** OSM 유래 건물·도로·수역은 CityPack 안에 있고(ODbL, `LICENSING.md` rule 2), 호출하는 쪽이 레이어로 주입한다.
- 각 PlanGeometry의 `sources`에 팩 라이선스·출처와 실제로 쓴 레이어별 이름·라이선스를 남긴다. 예제 생성 스크립트가 쓴 자료: 국토지리원 DEM(출처 표기), 국토교통성 국토수치정보 수역(MLIT), OSM 건물·도로(ODbL-1.0).
- 로컬 전용 자료(DEM, 23구 도로)가 없는 환경에서 예제를 다시 만들면 해당 값이 `null`이 된다. 스크립트가 어떤 레이어를 썼는지 출력하니 확인할 것.

## 알려진 한계

- 도로 자료는 23구만, 건물 자료는 4개 구역만 있어 그 밖은 `null`.
- 기존 철도망의 역은 시구정촌 중심점으로 뭉쳐져 있어 철도 교차·환승 대상은 거칠다(`quality: low`).
- 구조 형식 힌트는 그리기 전에는 추정이다(수역 교차 → 교량, 건물 관통 → 실드, 그 외 고가). `structureHintBasis`로 구분된다.
