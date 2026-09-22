# registry 학습 → 적용 보고서 (2026-09-21)

`Subway-Builder-Modded/registry`(GPL-3.0)를 읽고 우리 Tokyo CityPack에 적용한 작업의 기록입니다. 코드는 복사하지 않고 **문서화된 규칙과 아이디어만** 가져와 직접 구현했습니다.

## 1. 한눈에 보기

| | 시작 | 끝 |
|---|---|---|
| 23구 데이터 품질 (registry 루브릭, 자기 채점) | 0.588 중간 (C) | **0.813 매우 높음 (A)** |
| 외곽 3개 현 (가나가와·사이타마·지바) | 채점 안 함 | 0.438 낮음 (D) |
| 매니페스트 `quality` 값 | 10개 중 4개가 루브릭에 없는 값 | 전부 유효, 저장된 점수를 검증기가 재계산해 대조 |
| 23구 건물 레이어 | OSM 1,119,872개 (북동부 4개 구 듬성) | 공식 조사 1,790,011개, 용도·층수 실측 |
| 거주 측 수요 근거 | 총인구 | 취업자(통근자) |
| 통근 흐름 | gravity 추정 (Tokyo에서는 목적지 선택이 사실상 불가) | 국세조사 전수 OD |
| `validate-pack` 검사 | 형식·라이선스 | + 서식, gzip 최신성, 파일 간 불변식, 스키마, 품질 재계산, PMTiles 무결성 |

점수는 registry가 공개한 계산식을 그대로 구현한 것이고, 그 구현은 registry 문서의 일본(JP) 예시(raw 0.76 / weighted 0.81)를 재현하는지 테스트합니다. **자기 채점이라 registry 검토를 받은 등급은 아닙니다.**

## 2. 무엇을 읽었나

**읽고 활용**: `ARCHITECTURE.md`, `README.md`, `docs/data-quality.md`, `schemas/src/data-quality-ladders.ts`(등급표), `schemas/src/data-quality.ts`, `scripts/lib/data-quality.ts`(점수 계산), 도쿄 맵 2개의 매니페스트, `analytics/maps_statistics.csv`, `KNOWN_INCIDENTS.md`, `RELEASING.md`, 지도 분석 모듈(`map-analytics-grid.ts`, `map-demand-stats/*`의 수요 데이터 형식), 무결성 검사(`integrity.ts`).

**훑기만 함**: `map-playable-area`, `map-detail-metrics`, `map-basemap`, `scripts/intake`·`ops`·`downloads`.

**읽지 않음(우리와 무관)**: 워크플로 파일, `workers/scheduler`, 모드 73개, `security-rules.json`, 다운로드 집계·귀속 원장, 디스코드·텔레메트리. `map-polycentrism.ts`는 코드 주석에 "재미로 만든 것, 앱에 연결 안 됨"이라 제외했습니다.

## 3. 적용한 것과 결과

### 3.1 품질 루브릭 (`quality-rubric.mjs`, `pack-quality.mjs`)
- 우리 `quality.answers`의 `workplace_resolution`·`workplace_intensity`·`resident_resolution`·`resident_intensity`가 registry 열거값에 없다는 것을 등급표 코드에서 확인하고 유효한 값으로 교체했습니다.
- `validate-pack`이 (a) 모든 답이 루브릭 값인지, (b) 저장된 `computed` 점수·등급이 답으로 다시 계산한 결과와 같은지, (c) `rubric_version`이 일치하는지 검사합니다. 답만 바꾸고 재채점을 잊으면 실패합니다.
- 테스트 11개 통과 (JP 예시 재현, 값 검증 등).

### 3.2 취업자 데이터 (`employed.json`)
- 국세조사 소지역 집계 제16-2표(町丁目별 취업자 15세 이상), 4개 현 CSV. 町丁目 20,186개 전부를 채웠고 **모든 시정촌 합계가 국세조사 시정촌 값과 정확히 일치**합니다.
- 비공개 처리(秘匿) 셀 358개(1.8%)는 국세청이 이웃 町丁이나 町 단위 집계에 합산해 둔 값을 주민 수 비례로 나눴고 `estimated`로 표시했습니다.
- **독립 교차검증**: 242개 시정촌 전부에서 `취업자 = OD 근무자(제3표) + 종업지 불명`이 정확히 성립합니다. 서로 다른 두 국세조사 표가 맞물립니다.
- 엔진이 출발 수요를 총인구 대신 통근자 비례로 씁니다(전체 발생량은 그대로).

### 3.3 공식 조사 건물 레이어 (`tokyo-survey-buildings.pmtiles`)
- 도쿄도 토지이용현황조사(R03) 건물 폴리곤을 평면직각좌표 IX계에서 WGS84로 변환(왕복 오차 0.05mm, 원본 `AREA`와 평균 0.47% 차이)해 건물 레이어로 직접 사용했습니다.
- 건물 1,790,011개(OSM 1,119,872개), 실제 용도·층수, 건물별 추정 인구·일자리·취업자 포함. 44.9MB.
- 배분율: 인구 99.99%, 일자리 99.97%, 취업자 99.98% (OSM은 99.85% / 99.95%, 건물 없는 町丁 10곳 → 1곳).
- 이전에 알려 둔 **북동부 4개 구(에도가와·가쓰시카·아다치·이타바시)의 OSM 공백이 해소**됩니다.
- CC BY 데이터 기반이라 이 레이어는 ODbL 동일조건 공유 의무가 없습니다(팩 전체는 다른 레이어가 OSM을 써서 ODbL 유지).

### 3.4 방어 장치
- `pack-checks`: JSON 서식(BOM), gzip 최신성, 파일 간 불변식(인구·취업자·OD·건물별 합계), 스키마 적용(내장 최소 검증기, 모르는 키워드는 조용히 넘기지 않고 실패), 품질 재계산, PMTiles 무결성(매직 넘버·필수 필드).
- `safe-write`: 재생성 스크립트가 결과를 기존의 90% 미만으로 줄여 덮어쓰지 못하게 함(`ALLOW_SHRINK=1`로 해제). registry 사고 기록의 "데이터 통째 유실" 사례에서 가져온 교훈입니다.
- 지문 캐시로 변경 없는 검사는 생략(0.09초).

## 4. 그 과정에서 찾은 버그

| 버그 | 결과 |
|---|---|
| 매니페스트 스키마가 유효한 JSON이 아니었음 (`\d` 이스케이프) | 수정, 스키마를 실제 사용 키에 맞춰 갱신 |
| `demand.json`이 국세조사와 추정치가 섞임 (242개 중 35개만 일치) | 전부 국세조사 원값으로 교체 |
| `od.json`이 "종업지 불명·외국" 근무자를 빠뜨림 | `unknown` 필드로 보존, 행 합계 항등식 강제 |
| `validate-pack`이 `files` 값이 문자열이 아니면 스택 트레이스로 종료 | 방어 처리 |
| Tokyo 포인트에 `jobs`가 없어 기존 gravity가 목적지를 못 고름 | OD 도입으로 우회 (아래 미해결 참고) |
| 제가 만든 첫 `quality` 값 4개가 무효 | 수정, 이후 검증기가 방지 |

새 검사는 모두 일부러 어긋나게 만든 팩으로 **실제로 실패하는지** 확인했습니다(품질 5종, 취업자 4종, PMTiles 2종, 스키마 6종 등).

## 5. 하지 않은 것과 이유

- **게임 맵 ZIP 내보내기**: 게임의 `demand_data.json`(점 + 거주지→직장 쌍) 형식을 확인했지만, 호환을 목표로 할지는 제품 방향 결정이 필요하고 registry가 GPL이라 형식만 참고해야 합니다. 결정 후 진행 가능합니다.
- **외곽 3개 현 개선**: 다른 세션이 PLATEAU 건물 데이터로 작업 중이라 손대지 않았습니다. 현재 0.438(D)이며 그쪽이 끝나면 다시 채점하면 됩니다.
- **viewer의 취업자 토글**: `emp` 값은 타일에 있고 팝업에 표시되지만, 거주/일자리 토글에 세 번째 항목을 넣는 UI 작업은 하지 않았습니다(다른 세션이 같은 파일을 수정 중).

## 6. 남은 한계 (2026-09-22 추가 확인)

- **품질 등급은 여전히 자기 채점입니다.** 조사 폴리곤을 `exact_footprints`로, 적합한 용도별 계수를 `fine_types_calibrated`로 본 것은 검토자가 다르게 볼 수 있습니다. 이 두 해석이 A 등급을 좌우합니다(`exact_footprints` 대신 `osm_footprints`면 0.683 B). 이건 해석의 문제라 추가 조사로 해소되지 않습니다.
- **[해결] 비건물 코드 18,283개.** 정의서(データベース定義書 PDF)를 직접 읽었습니다. 이전에 "읽을 수 없다"고 한 게 틀렸습니다 — 인코딩이 깨진 텍스트 추출만 실패했을 뿐, PDF 자체는 정상적으로 읽혔습니다. 배제한 코드(210·220·300·400·510·520·611-613·700·800·900)는 정의서의 **토지이용코드표**에 속하는 공원·도로·철도항만·농지·수면·원야·산림·불명 코드이고, 건물 코드는 정의서의 별도 **건물용도코드표**에 있는 111-150뿐이라는 게 확인됐습니다. 우리가 111-150만 건물로 남긴 판단이 정확했습니다.
- **[해결] BV_4(지하층수) 필드 의미.** 이전에는 "정의서 라벨을 읽을 수 없어 추정했다"고 적었는데, 정의서에 `BV_4 建物地下階数 (지하 층수, 단위: 층)`이라고 명시돼 있습니다. 상관관계로 추정한 값이 정확했다는 뜻이고, 이제 추정이 아니라 확인된 사실로 문서를 고쳤습니다.
- **[해결] Tokyo 포인트의 `jobs` 누락.** `demand.json` 242개 전부에 OD 전수표 기반 "이 시정촌에서 근무하는 사람 수"를 채웠습니다(`scripts/tokyo-demand-jobs.mjs`). 경제센서스(`jobs.json`)는 다마 지역 30개 시정촌을 커버하지 않아 쓸 수 없었고, 섞어 쓰면 다마 경계에서 값이 뚝 끊기므로 242개 전부 OD 기준으로 통일했습니다. `?od=0`(순수 gravity)이 이제 Tokyo에서도 실제로 목적지를 고릅니다(이전에는 5,000번 뽑아 전부 null이었습니다). 회귀 테스트 2개 추가.
- **[결정] OSM 기반 `tokyo-buildings.pmtiles`(28.5MB)를 유지하기로 정했습니다.** viewer는 더 이상 읽지 않지만, 실측을 다시 모으려면 Overpass 재수집이 필요해 되돌리기 어려운 데이터라 삭제하지 않았습니다. README에 "레거시/비교용" 레이어로 명시했습니다.
- 건물별 인구·일자리·취업자는 모두 추정이며 실측이 아닙니다. (변동 없음, 근본적으로 해소되지 않는 한계)

## 7. 파일과 상태

**커밋하지 않았습니다.** 마지막 커밋은 `3c1ea66`입니다. 아래는 이번 작업에서 제가 만들거나 바꾼 파일입니다.

- 새 파일: `scripts/quality-rubric.mjs`, `pack-quality.mjs`, `test-quality-rubric.mjs`, `tokyo-employed.mjs`, `tokyo-building-emp-lu.mjs`, `tokyo-survey-buildings.mjs`, `jp-plane-ix.mjs`, `safe-write.mjs`, `packs/tokyo/employed.json`, `tokyo-survey-buildings.pmtiles`
- 수정: `scripts/pack-checks.mjs`, `tokyo-od.mjs`, `muni-pop-2020.mjs`, `tokyo-job-coefficients.mjs`, `engine/src/demand-engine.mjs`, `od-flows.mjs`, `engine/test/od-demand.test.mjs`, `engine/README.md`, `schemas/citypack-manifest.schema.json`, `packs/tokyo/manifest.json`, `viewer.html`(건물 소스·팝업·안내문), `README.md`, `ATTRIBUTION.md`, `tokyo-buildings.pmtiles`(`emp` 추가), `.gitignore`
- 다른 세션 작업(건드리지 않음): `areas.pmtiles`, `labels.pmtiles`, `plateau-*`, `saitama-job-coefficients`, `tokyo-terrain`, `tokyo-dem-download`, `tokyo-korean-labels`, `docs/data-sources-kanto-3pref.md` 등. `manifest`·`viewer`·`README`·`ATTRIBUTION`은 두 세션의 수정이 같은 파일에 섞여 있어, 커밋할 때 제 hunk만 골라야 합니다.

**검증 요약**: `validate-all` 3/3, 품질 루브릭 테스트 11/11, 엔진 OD 테스트 13/13.

## 8. 2026-09-22 후속: "확인이 필요한 점" 처리

앞서 6번에 적은 4가지 중 3가지를 실제로 해결했고, 1가지(자기 채점의 해석 문제)는 성격상 조사로 해소되지 않는다는 걸 확인했습니다. 새 파일: `scripts/tokyo-demand-jobs.mjs`. 수정: `scripts/pack-checks.mjs`(jobs==OD 항등식 추가), `packs/tokyo/demand.json`, `packs/tokyo/README.md`, `scripts/tokyo-survey-buildings.mjs`(주석), `engine/README.md`, `engine/test/od-demand.test.mjs`(테스트 2개 추가). 여기도 커밋하지 않았습니다.
