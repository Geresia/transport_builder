# Transitline

도쿄권 철도망을 직접 계획하고 짓고 운영하는 경영 게임. 작업 이름이라 바꿔도 되고, 이 이름에 의존하는 코드는 없다.

대상 범위는 도쿄도, 사이타마, 지바, 가나가와(1도 3현)다. 경도 138.18~140.87, 위도 34.90~37.15 범위의 `tokyo` 팩이 이걸 덮는다. 서울·부산·대구는 초기에 만든 자료만 남아 있고 더 이어가지 않는다(아래 "한국 자료").

실행 방법은 루트 [`README.md`](../README.md)에 있다.

## 상태

- **포맷.** CityPack 스펙, 스키마, 검증기, 가상 팩 2개. 끝.
- **운행 엔진.** 노선, 열차, 승객 경로, 수단 선택. 1초 고정 틱으로 돌고 배속이나 프레임과 결과가 무관하다.
- **경영 엔진.** 공공 O&M 입찰, 건설, 차량 발주, 차량기지, 개통 판정, 30일·1년 운영, 회계, 저장이 기준 시나리오 하나로 연결돼 있다. 일본과 한국 규칙을 둘 다 갖고 있다. 무엇이 구현됐는지는 [`docs/management-engine-implementation-2026-09-25.md`](./docs/management-engine-implementation-2026-09-25.md).
- **테스트.** `npm test`가 70개를 돌리고 전부 통과한다. 원장 불변식, 저장·복원 일치, 1년 운영, 250역 경로 탐색 시간 예산이 들어 있다.
- **도쿄 팩.** 뷰어로 볼 수 있다. 엔진은 통근·통학 OD와 기존 철도망을 읽는다. 특수 수요, 건물, 지형은 엔진이 아직 안 읽는다.
- **Subway Builder 모드.** [`subway-builder-export/`](./subway-builder-export/README.md)가 도쿄 팩을 게임 파일 형식으로 바꾸고 [`mods/tokyo-citypack/`](./mods/tokyo-citypack/README.md)가 빌드된다. 실제 게임에서 켜 본 적은 없다.

## 폴더 구조가 이렇게 생긴 이유

상용으로 팔면서 실제 지리 데이터도 써야 하는데, 이 둘은 데이터를 물리적으로 분리하지 않으면 충돌한다. 그래서 세 층으로 나눴다.

```
scripts/    개발 때만 쓰고 배포 안 함     GPLv3 도구를 써도 됨
packs/      지도 데이터, 공개 배포        OSM 파생이면 ODbL
engine/     게임, 판매                    독점, 팩에서 아무것도 상속 안 함
```

데이터나 의존성을 건드리기 전에 [`LICENSING.md`](./LICENSING.md)를 먼저 읽는다. 규칙은 두 개고 직관과 좀 어긋난다.

1. 데이터 생성 스크립트는 플레이어에게 가면 안 된다. 게임에 묶어 넣으면 GPLv3 파생물이 된다.
2. 검색 가능한 OSM 지오메트리는 팩에만 두고 엔진에는 두지 않는다.

지도 편집 쪽과 경영 엔진 쪽은 서로의 내부 상태를 건드리지 않는다. 지도는 계획 도형(`PlanGeometry`)을 넘기고 엔진은 판정과 견적을 돌려준다. 계약은 [`docs/plan-geometry-contract-v1.md`](./docs/plan-geometry-contract-v1.md)와 [`docs/map-plan-contract.md`](./docs/map-plan-contract.md).

## 파일

| 경로 | 내용 |
|---|---|
| [`docs/citypack-format.md`](./docs/citypack-format.md) | 팩 포맷 스펙. 데이터와 게임의 경계 |
| [`packs/tokyo/`](./packs/tokyo/) | 도쿄권 실데이터 팩 ([README](./packs/tokyo/README.md)) |
| [`packs/example-radial/`](./packs/example-radial/) | 가상 방사형 도시, `gravity` 모델 |
| [`packs/example-corridor/`](./packs/example-corridor/) | 가상 회랑형 도시, `matrix` 모델과 캘린더 |
| [`engine/`](./engine/) | 운행 엔진, 경영 엔진, 화면 ([README](./engine/README.md)) |
| [`scripts/validate-pack.mjs`](./scripts/validate-pack.mjs) | 팩 검증기. 형식뿐 아니라 라이선스 규칙도 검사 |
| [`scripts/pack-checks.mjs`](./scripts/pack-checks.mjs) | validate-pack이 부르는 데이터 검사. JSON 서식(BOM), `.gz` 사본이 원본과 일치하는지, 파일 간 불변식(시정촌 코드, O/D 행 합계, 町丁 합계와 시정촌 인구, 건물별 종사자 합계), manifest·demand 스키마 대조. 입력 파일의 크기와 수정 시각이 그대로면 결과를 `.cache/`에서 재사용하고, `--no-cache`로 무시한다 |
| [`schemas/`](./schemas/) | manifest, demand JSON 스키마 |
| [`data-raw/`](./data-raw/README.md) | 내려받은 원본과 다시 받는 법 (원본은 git에 없음) |

설계 문서는 `docs/`에 있다. 철도 규격, 역, 공사비, 차량, 차량기지는 `railway-*.md`, 사업 수주와 경제성은 `transport-business-award-economics-competition-kr-jp-2026.md`, 단계별 계획은 [`system-implementation-roadmap-2026-09-25.md`](./docs/system-implementation-roadmap-2026-09-25.md)다.

## 쓰는 법

```powershell
npm test                                     # 엔진 회귀 테스트
npm run validate                             # 팩 전체 검증
node scripts/validate-pack.mjs packs/tokyo   # 팩 하나 검증
npm run regen                                # 가상 팩 수요 데이터 재생성
npm run plan-examples                        # 계획 도형 예시 파일 생성
```

설치 단계는 없다. 검증기가 의존성 없이 돌게 만든 건 CI에서 아무것도 설치하기 전에 돌아야 하고, JSON 모양만 보는 게 아니라 라이선스 경계를 강제해야 해서다.

`pack-checks.mjs`는 의존성 없는 최소 검증기로 `manifest.json`을 `schemas/citypack-manifest.schema.json`에, `demand.json`을 `schemas/citypack-demand.schema.json`에 대조한다. 스키마가 쓰는 키워드만 지원하고, 모르는 키워드를 만나면 넘어가지 않고 실패한다. 팩이 `files`에 새 키를 쓰면 스키마에도 선언해야 한다(`additionalProperties: false`). 라이선스 경계 같은 규칙은 `validate-pack.mjs`가 직접 검사한다.

## 로드맵

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | CityPack 포맷, 스키마, 검증기 | 끝 |
| 1 | 손으로 만든 팩에서 역, 노선, 승객 경로 | 끝. 엔진 버그 7건도 고침 |
| 2 | 도쿄 팩을 엔진에 연결 | 일부. OD와 기존망은 연결됨. 역 후보, 특수 수요, 건물, 지형은 아직 |
| 3 | 수주, 건설, 차량, 기지, 경제 | 기준 시나리오 구현. 콘텐츠(차량 종류, 공법, 경쟁사 등) 확장 여지 있음 |
| 4 | Subway Builder 모드로 실제 로드 | 아직 |

Phase 1은 일부러 가상 팩으로 돌렸다. 실데이터를 붙이는 비용을 내기 전에 게임이 재밌는지 먼저 보려는 것이었다.

## 남은 문제

수요 데이터는 도쿄에서 대부분 해결됐다. 거주 인구와 취업자는 町丁 단위 국세조사, 종사자는 町丁 단위 경제센서스, 통근과 통학은 시정촌 간 OD 행렬이 팩 안에 있고 모두 재사용 조건이 맞다. 건물 단위 값은 실측이 아니라 이 통계를 토지이용조사와 PLATEAU 자료로 나눈 모델이다.

- 통근 OD가 시정촌 단위라서 역세권 수준의 수요는 모델이 채운다.
- 경제센서스와 국세조사 합계가 도심 구에서 맞지 않는다. 맞추지 않았다.
- 시간대·요일별 승하차 데이터가 없다. `calendar`를 포맷의 1급 개념으로 두고 요일 유형과 시간대를 모델로 만든다. 평일과 토요일·휴일 계수는 실제 JR 시각표로 채웠다.
- OSM 건물이 에도가와, 가쓰시카, 아다치, 이타바시에 적다.
- 건물별 종사자는 8개 시(PLATEAU 자료가 되는 곳)만 있다.
- 자유 모드에서는 역이 수요 점 242곳에 고정이다. 시나리오 모드는 수요 노드와 물리 역을 나눠서 완공 때 역·승강장·선로를 만들지만, 이 흐름을 도쿄 팩으로 끝까지 돌려 본 적은 없다.
- Subway Builder 모드를 게임에서 로드해 본 적이 없다. 파일 구조는 게임 내장 도쿄 데이터와 읽기 전용으로 비교해 맞춰 놨다.

## 한국 자료

서울·부산·대구용으로 만든 조사와 스크립트는 지우지 않고 남겨 뒀고, 새로 손대지 않는다. 데이터 라이선스 판단(공공누리 유형별 사용 가능 여부 등)은 한국으로 돌아오면 그대로 쓸 수 있다.

- [`docs/data-sources-kr.md`](./docs/data-sources-kr.md): 한국 수요 데이터 출처 조사
- [`docs/region-map-playbook.md`](./docs/region-map-playbook.md): 지역 지도 제작 절차. 지역과 무관하게 재사용할 수 있다
- [`docs/seoul-map-coverage-gap.md`](./docs/seoul-map-coverage-gap.md), [`docs/data-download-howto.md`](./docs/data-download-howto.md), [`scripts/README-korea-map.md`](./scripts/README-korea-map.md)
- `scripts/build-metro-demand.mjs`: 수도권 1,187개 행정동 인구밀도
