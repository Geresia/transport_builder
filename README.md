# Transport Builder

도쿄권(도쿄·사이타마·지바·가나가와) 철도망을 직접 계획하고, 짓고, 운영하는 경영 게임을 만드는 저장소다. 게임 엔진, 실제 통계로 만든 지도 데이터 팩, 팩을 만드는 스크립트, 데이터를 Subway Builder 모드 형식으로 바꾸는 변환기가 같이 들어 있다.

처음에는 서울·부산·대구로 시작했다. 지금은 도쿄만 다루고, 한국 쪽 자료는 지우지 않고 남겨만 뒀다.

## 지금 상태

| | 상태 |
|---|---|
| CityPack 포맷과 검증기 | 끝. 스펙은 `transitline/docs/citypack-format.md` |
| 운행 엔진 (노선, 열차, 승객 경로, 수단 선택) | 동작. 알려진 버그 E-01~E-07은 9월 25일에 고치고 회귀 테스트를 붙였다 |
| 경영 엔진 (입찰, 건설, 차량, 차량기지, 개통, 정산, 저장) | 기준 시나리오 하나가 끝까지 돈다. 한일 규칙 두 벌, 30일·1년 운영 포함. 콘텐츠 종류는 아직 적다 |
| 엔진 테스트 | `npm test`, 70개 통과 |
| 도쿄 팩 뷰어 | 동작. 3D 보기, 町丁 단위 인구·종사자, 건물 단위 추정치 |
| 도쿄 팩에서 엔진으로 | 일부만. 통근·통학 OD와 기존 철도망은 읽고, 특수 수요·건물·지형은 아직 안 읽는다 |
| Subway Builder 모드 | 변환과 빌드까지 됐다. 실제 게임에서 켜 본 적은 없다 |
| 서울·부산·대구 | 중단 |

자유 모드(`?play=sandbox`)에서는 역이 지금도 수요 점(시정촌 242곳)에 묶여 있다. 시나리오 모드는 수요 노드와 물리 역을 나눠 놨고, 완공 때 역·승강장·선로가 생기고 보행 접근 링크로 수요와 이어진다. 다만 이 흐름을 도쿄 팩으로 끝까지 돌려 본 적은 없다.

## 폴더

```
transitline/
  engine/               운행 엔진, 경영 엔진, 화면 (바닐라 JS + Canvas, 의존성 없음)
  packs/                지도 데이터 팩 (tokyo, example-radial, example-corridor)
  scripts/              팩 생성과 검증 스크립트
  schemas/              manifest, demand JSON 스키마
  docs/                 포맷 스펙, 설계 문서, 데이터 조사, 개발 서버
  data-raw/             내려받은 원본 (git에 없음, README만 있음)
  subway-builder-export/  Subway Builder용 변환 결과와 설명
  mods/tokyo-citypack/  변환 결과를 게임에 등록하는 모드 소스
```

루트의 `bot/`, `depot/`, `monorepo/`, `registry/`, `template-mod/`는 Subway Builder 커뮤니티 저장소를 읽으려고 받아 둔 참고용 클론이다. `.gitignore`에 들어 있고 이 저장소의 코드가 아니다. 읽고 정리한 내용은 `subway-builder-modded.md`와 `transitline/docs/subway-builder-reference.md`에 있다.

## 실행

설치할 게 없다. 브라우저가 `fetch`로 파일을 읽어서 `file://`로는 안 열리고, 정적 서버가 필요하다. `transitline/docs/serve.ps1`이 `.pmtiles`용 HTTP Range 요청까지 처리한다.

```powershell
# 도쿄 팩 뷰어: http://localhost:8020/viewer.html
powershell -NoProfile -File transitline\docs\serve.ps1 -Port 8020 -Root transitline\packs\tokyo -Index viewer.html

# 엔진: http://localhost:8000/engine/index.html
#       경영 시나리오 화면: http://localhost:8000/engine/management.html
powershell -NoProfile -File transitline\docs\serve.ps1 -Port 8000 -Root transitline -Index engine/index.html
```

엔진은 기본으로 `example-radial`을 건설 시나리오로 연다. 돈과 시간이 들지 않는 자유 모드는 `?play=sandbox`, 다른 팩은 `?pack=../packs/tokyo`처럼 고른다. 시나리오 옵션(`country=JP|KR`, `network=existing|scratch` 등)은 [`transitline/engine/README.md`](./transitline/engine/README.md)에 있다.

Range 요청을 못 하는 서버(예전 `serve.ps1` 인스턴스 등)에서는 `.pmtiles`가 안 뜬다. 건물이 안 보이면 서버부터 확인한다.

검증과 테스트는 Node가 필요하다(개발은 v24).

```powershell
cd transitline
npm test                                        # 엔진 회귀 테스트
npm run validate                                # 팩 전체 검증
node scripts/validate-pack.mjs packs/tokyo      # 팩 하나만
```

## 도쿄 팩

`transitline/packs/tokyo/`. 어디까지가 통계이고 어디부터가 추정인지가 이 팩에서 제일 중요하다.

**출처가 있는 통계**

- 시정촌 242곳의 인구. 2020년 국세조사가 기본이고 일부는 추계라서 점마다 `popDate`가 있다.
- 町丁 단위 인구와 경계. 23구와 다마 지역, 사이타마·지바·가나가와 (e-Stat 소지역, NII Geoshape).
- 町丁별 종사자 수(2021 경제센서스)와 취업자 수(2020 국세조사).
- 시정촌 간 통근 OD 38,805쌍과 통학 OD (2020 국세조사).
- 건물 윤곽. 23구는 도쿄도 토지이용현황조사와 OSM, 나머지 3현은 OSM 5.12M동.
- 도로·보행로, 베이스맵, 지형, 수심(GEBCO), 실제 철도망(OSM).
- 특수 수요 위치. 대학 465곳, 병원 1,047곳 (국토수치정보).
- 관광객 수(도쿄도 관광 데이터, 2025)와 신칸센·특급 유입 수(2015 조사).

**모델 (추정치)**

- 건물별 거주자 수. 町丁의 실제 인구를 토지이용조사의 용도와 층수로 가중해 건물에 나눈 값이다. 계수는 町丁 3,114곳에 비음수 최소제곱을 걸어 맞췄고 R²는 0.74다.
- 건물별 종사자 수. 같은 방식으로 경제센서스 총량을 나눴다. 23구는 R² 0.85. 3현은 PLATEAU 건물 자료로 사이타마, 가와사키, 사가미하라, 요코스카, 아쓰기, 후지사와, 가마쿠라, 야치요 8개 시만 했고, R²는 0.60~0.94로 도시마다 다르다. 연면적이 없는 자료는 다른 도시들의 층별 연면적/바닥면적 비율로 보정했다(이것도 추정).
- 특수 수요의 `capacity`. 병원은 병상 수 x 3, 대학은 종류별 고정값이다.
- 도쿄역 도착객 분산 경로. 뷰어에 그려지지만 데이터가 아니라 가정이다.
- 통근 OD를 町丁 단위로 쪼갠 값(Subway Builder 변환용). 시정촌 쌍 합계는 실측과 200명 안쪽으로 맞는다.

뷰어의 건물 팝업에는 전부 "모델 추정치 — 실측 아님"이 붙는다. 이 문구는 빼면 안 된다.

**알려진 구멍**

- OSM 건물이 에도가와, 가쓰시카, 아다치, 이타바시에 적다. 이 구에서는 지도가 성기게 보이고 건물 수 기반 값이 부풀려진다.
- 3현 건물 타일에는 윤곽과 OSM 태그 기반 거주자 추정만 있다. 건물별 종사자는 위 8개 시뿐이고, 요코하마와 지바 쪽 대부분은 없다.
- 다마 지역은 町丁 데이터는 있지만 건물 데이터는 없다.
- 특수 수요에 공항, 항만, 경기장, 신사·사찰이 없다.
- 경제센서스(사업소 기준)와 국세조사(거주지 기준) 합계가 도심 구에서 맞지 않는다. 맞추지 않았다.

자세한 내용은 [`transitline/packs/tokyo/README.md`](./transitline/packs/tokyo/README.md), 출처 표기는 [`ATTRIBUTION.md`](./transitline/packs/tokyo/ATTRIBUTION.md)에 있다.

## 저장소에 없는 것

`transitline/data-raw/`에 원본 다운로드가 약 3GB 있다(지형 타일, PLATEAU, e-Stat 파일 등). git에는 올리지 않는다. 어디서 어떻게 다시 받는지는 [`transitline/data-raw/README.md`](./transitline/data-raw/README.md)에 적어 뒀다. 다른 컴퓨터에서 작업하려면 이 폴더를 따로 옮기거나 다시 받아야 한다.

`subway-builder-export/`의 큰 변환 결과(건물 588MB 등)도 git에 없고 스크립트로 다시 만든다.

## 라이선스 구조

상용 판매와 실제 지리 데이터를 같이 하려고 세 층으로 나눴다.

| 층 | 라이선스 | 비고 |
|---|---|---|
| 데이터 생성 스크립트 | GPL 도구를 써도 됨 | 개발 때만 쓰고 플레이어에게 배포하지 않는다 |
| 지도 데이터 팩 | OSM 파생이면 ODbL | 공개해서 share-alike를 여기서 끝낸다 |
| 엔진 | 독점 | 팩을 포맷 문서대로만 읽는다 |

OSM 지오메트리(벡터 타일, 건물 인덱스, 도로 그래프)는 엔진이 아니라 팩 안에만 둔다. 한국 공공데이터는 공공누리 제1유형만 쓸 수 있고, 제3유형(변경금지)은 가공이 안 돼서 걸렀다. 자세한 건 [`transitline/LICENSING.md`](./transitline/LICENSING.md)이고, 법률 자문이 아니라 작업 메모다.

## 문서

| | |
|---|---|
| [`transitline/README.md`](./transitline/README.md) | 구조, 로드맵, 남은 문제 |
| [`transitline/docs/citypack-format.md`](./transitline/docs/citypack-format.md) | 팩 포맷 스펙 |
| [`transitline/engine/README.md`](./transitline/engine/README.md) | 엔진 구조, 실행 옵션, 의도적으로 뺀 것 |
| [`transitline/docs/management-engine-implementation-2026-09-25.md`](./transitline/docs/management-engine-implementation-2026-09-25.md) | 경영 엔진이 뭘 구현했고 어떻게 검증했는지 |
| [`transitline/docs/system-implementation-roadmap-2026-09-25.md`](./transitline/docs/system-implementation-roadmap-2026-09-25.md) | 건설·경제 엔진 단계별 계획(I0~I8) |
| [`transitline/docs/plan-geometry-contract-v1.md`](./transitline/docs/plan-geometry-contract-v1.md), [`map-plan-contract.md`](./transitline/docs/map-plan-contract.md) | 지도 편집기와 엔진 사이의 계획 입력 계약 |
| [`transitline/docs/railway-construction-master-report-kr-jp-2026.md`](./transitline/docs/railway-construction-master-report-kr-jp-2026.md) | 철도 규격, 역, 공사비, 차량, 차량기지 설계 (세부 문서는 같은 폴더의 `railway-*.md`) |
| [`transitline/docs/transport-business-award-economics-competition-kr-jp-2026.md`](./transitline/docs/transport-business-award-economics-competition-kr-jp-2026.md) | 사업 수주, 사업성, 경쟁 회사 설계 |
| [`transitline/docs/code-review-2026-09-22.md`](./transitline/docs/code-review-2026-09-22.md) | 코드 검토 결과와 수정 상태 |
| [`transitline/docs/data-sources-kanto-3pref.md`](./transitline/docs/data-sources-kanto-3pref.md) | 3현 건물 용도·층수 자료 조사 |
| [`transitline/subway-builder-export/README.md`](./transitline/subway-builder-export/README.md) | Subway Builder 변환 결과와 검증 |
| [`transitline/docs/subway-builder-mechanics-study.md`](./transitline/docs/subway-builder-mechanics-study.md), [`subway-builder-reference.md`](./transitline/docs/subway-builder-reference.md) | Subway Builder 참고 노트 |
| [`transitline/data-raw/README.md`](./transitline/data-raw/README.md) | 원본 데이터 출처와 다시 받는 법 |
| [`transitline/docs/data-sources-kr.md`](./transitline/docs/data-sources-kr.md), [`region-map-playbook.md`](./transitline/docs/region-map-playbook.md) | 한국 자료. 중단했지만 남겨 둠 |

## 참고

장르는 Subway Builder 쪽이다. 게임 이름, 로고, `SubwayBuilderAPI` 같은 식별자, GPL 저장소의 코드는 가져오지 않는다. 게임 메커니즘 자체는 저작권 대상이 아니라서 문제 삼지 않는다.
