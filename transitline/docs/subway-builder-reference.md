# Subway Builder 참고 노트 (학습용)

조사일 2026-09-20. **개념 참고용**이며 코드나 타입 정의를 복사하지 않는다 (`../LICENSING.md`: 이름·식별자 금지, GPL 코드 금지). 출처는 공개 저장소 3곳이다.

| 출처 | 읽은 범위 | 라이선스 |
|---|---|---|
| `Subway-Builder-Modded/template-mod` `src/types/*.d.ts` (21개, 2280줄) | 전부. Modding API **v1.0.0** 타입 | LICENSE 파일 없음, package.json에 MIT. 게임 API를 기술한 타입이라 재사용 권한이 불명확 → **읽기만** |
| `.../monorepo` `foundry/schemas` | 특수 수요 스키마 3종과 타입 정의 JSON | 확인 안 함 |
| `.../depot` `src/depot/demand.py` | 클래스 개요, `DemandData` 메서드 목록, 일부 docstring | GPL-3.0 → **엔진에 코드 금지**, 개념만 |

게임 본체 소스는 비공개라 모르는 부분이 많다. 아래는 타입 정의와 문서가 말하는 것이고, 실제 동작은 검증하지 못했다.

## 1. 게임 엔티티 모델

**건설은 2단계**다. `blueprint`로 배치한 뒤 `constructed`로 짓는다 (`BuildType`). 배치 시점에 비용이 계산된다 (`calculateBlueprintCost`).

| 엔티티 | 핵심 필드 |
|---|---|
| Track | coords[], length, startElevation/endElevation, type(`station`/`track`/`scissors-crossover`/`express-station`), trackType(예: heavy-metro), waterIntersectionPercentage |
| TrackGroup | trackIds, centerLine, `single`/`parallel`/`quad` |
| Station | coords, trackIds, trackGroupId, stNodeIds, routeIds, nearbyStations[{stationId, walkingTime}] |
| StNode | 노선이 정차하는 "정차 노드" (center, trackIds) |
| Route | name, **bullet**(A, 1), color, **textColor**, **shape**(circle/pill/diamond/square), carsPerTrain, **idealTrainCount**, trainType, **trainSchedule**, stNodes[], stCombos[], stComboTimings[] |
| StCombo | 연속한 두 정차 노드 사이 구간: path[{trackId, reversed, length, signals}], distance |
| StComboTiming | stNodeId별 arrivalTime/departureTime |
| Train | routeId, cars, length, motion{speed, acceleration}, currentStComboInfo{timeAtStop, gapFromHeadToEndOfRoute…}, 선로 점유 window(train/warning) |

- **`TrainSchedule`은 3개 등급뿐**이다: `highDemand`, `mediumDemand`, `lowDemand`. 영상 화면에는 Very Low Demand까지 4개가 있었으므로, 이 타입 정의(v1.0.0)보다 게임 최신 버전이 더 진행된 것으로 보인다.
- 신호(signal)와 폐색: 열차마다 `windows.train`/`windows.warning`이 트랙 위 점유 구간을 나타내고, 분기점 신호창 길이 상수가 따로 있다 (V-merge 200m, diamond 10m).
- 선로 종류와 열차 종류는 별개다. 열차 타입은 `compatibleTrackTypes`로 달릴 수 있는 선로를 지정한다.

## 2. 수요·인구 모델

우리 엔진(gravity 확률 스폰)과 가장 다른 부분이다.

- `DemandPoint`: location, jobs, residents, popIds[], **residentMode/workerModeShare {walking, driving, transit, unknown}**
- **`Pop` = 출퇴근 집단**: size, residenceId(집 포인트), jobId(직장 포인트), drivingSeconds, drivingDistance, drivingPath, **homeDepartureTime, workDepartureTime**, lastCommute
- 게임 안에서 각 pop이 운전/도보/대중교통 중 하나를 고른다 (`modeChoice`). 대중교통이면 `transitPaths[]`에 구간별(도착·출발 시각, 노선, 승하차 정류장, 걷기/운전 구간 여부)이 남는다.
- **출퇴근 시간대 기본값**: 7-9시, 17-19시 (`CommuteTimeRange`). 모드에서 바꿀 수 있다.
- **정류장 이용권**: 도보 반경 기본 1800초(30분), 환승 반경 600초(10분), 도보 속도 1 m/s (정밀 경로 1.5 m/s). 정거장 타입별로 배율/절대값을 조정한다.
- 특수 수요(공항, 대학, 경기장 등)는 별도 파일에 `point_id`로 연결되고, **유형별 거리 감쇠 지수**(`special_demand_exp`)로 pop 배정 시 멀리서 오는 정도를 조절한다 (`depot.get_exponent`, 기본 1.0).
- 통계: 완료된 통근을 24시간 보관(`TIME_TO_KEEP_COMMUTE_DATA`), 15분 단위 통근 구간(`COMMUTE_INTERVAL_LENGTH` 900초), 열차 스케줄 전환 창 30분.

**함의**: 실제 게임은 "확률로 승객을 뿌리는" 방식이 아니라 "집→직장 집단이 출발 시각을 갖고 모드를 고르는" 방식이다. gravity는 **맵 제작 시점**(depot)에 pops를 만드는 데 쓰이고, 런타임 시뮬레이션은 pops를 소비한다.

## 3. 경제·운영 상수 (기본값)

- 시작 자금 3,000,000,000, 기본 요금 3, 운영비는 900초(15분)마다 청구, `FARE_MULTIPLIER` 365(요금 수입에 곱하는 값이라고만 문서화돼 있고 의미는 미확인).
- 시작 열차 차량 수 30 → **차량은 구매하는 자원**이다 (`buyTrains`, 차량 세트 단위 `carsPerCarSet`).
- 열차 타입 통계: 최대 가속/감속/속도, `maxSpeedLocalStation`, 차량당 정원, 차량 길이, 최소·최대 편성 수, 차량 비용, 열차/차량당 시간당 운영비, 선로·정거장 기본 비용, 승강장 길이 제한.
- 정차 시간 20초, 시간당 최대 운행 120대(`TPH_LIMIT`), 최대 경사 4%, 최소 곡선 반경 29m, 가속도 변화율 0.3 m/s³, 횡가속도 0.8 m/s².
- **고도 5단계와 비용 배율**: DEEP_BORE(-30m 아래), STANDARD_TUNNEL(-30~-8), CUT_AND_COVER(-8~-3), AT_GRADE(-3~4.5), ELEVATED(4.5 위). 물 위 배율은 따로 있다. 건물 기초 깊이(foundation)와 3m 간격을 두어 건물 밑을 지날 수 있다.
- 채권(Bond): principal, interestRate, termDays. 발행·상환 가능.
- 커리어 미션: 도시별, 티어 3단계(starter 0★ / growth 4★ / mega 10★), 별 1~3개, 지표는 정거장·열차·노선 수, 승객 수, 승객 비율, 일일 이익, 지역 간 승객 수 등 16종.
- 콘텐츠: 신문/트윗 템플릿(`{{STATIONS}}` 등 변수, 게임 상태 조건, 가중치).

## 4. 특수 수요 분류 (일본 데이터 기반)

`foundry/schemas`: 24개 필수 타입 + `events`. 각 타입은 `id`, 2~4자 `code`(demand 포인트 ID 접두사, 예 AIR/SCH/HOS), 다국어 라벨(`__default__` + BCP47), lucide 아이콘, 선택적 하위 타입.

airport, amusement_park, aquarium, bathhouse, convention_center, cultural_center, custom, government_facility, heritage_site, hospital, library, military_base, museum, natural_feature, outside_connection, park, port, religious_institution, resort, school, shopping_center, sports_facility, university, zoo (+ events)

**일본 공공데이터 출처가 스키마에 명시돼 있다** (도쿄 CityPack의 `jobs`·attractors 갭과 직결):
- MLIT `P04-20`(병원) + 병원 통계 CSV, `P27`(문화시설 03001 미술관, 03002 박물관, 03005 동물원/식물원), `P29`(학교: 16001 초등 / 16002 중학 / 16004 고등 / 16005 고전 / 16006 단대 / 16007 대학 / 16012 특수지원), MLIT 공항 CSV, 항만 CSV.
- 수작업 분류 CSV(`custom_attractions.csv`)로 신사·사찰·세계유산·스타디움 등을 보강.
- 스키마는 조직이 소유하는 고정 부분(`x-template-locked`)과 지도 제작자가 확장하는 부분(`sub_types`, `metadata`)을 구분한다.
- 인접 학교를 하나의 포인트로 합치는 규칙("consolidated")과 `sibling_point_ids`(같은 실체의 여러 포인트, 예: 공항 터미널)가 있다.

> 이 MLIT 데이터셋(국토수치정보)의 이용약관은 **확인하지 않았다**. 우리가 쓰려면 상업 이용·가공 가능 여부를 먼저 확인해야 한다 (`data-sources-kr.md`의 KOGL 검토와 같은 절차).

## 5. depot의 수요 가공 절차 (개념만)

`sanitize` → `scale_demand`(일반 직장 수요만 배율 조정, 특수 수요는 제외) → `enforce_max_pop_size`(큰 pop 분할) → `consolidate_pops`(작은 pop을 같은 집/직장의 근처 pop에 병합) → `merge_identical_commutes` → `agglomerate_pops`(기본 100명 미만 pop을 "슈퍼 출발지"로 묶기, CBD와 비CBD의 거리 임계값이 다름) → `cluster_points` → `calculate_routes`(osmnx 또는 OSRM으로 운전 시간·거리). 목적은 **런타임에 다룰 pop 수를 줄이는 것**이다.

## 6. 우리 엔진과의 차이, 반영 후보

| 영역 | 지금(engine/) | Subway Builder | 반영 난이도·제안 |
|---|---|---|---|
| 정거장 | 팩의 포인트로 고정 | 플레이어가 아무 곳에나 건설, 트랙/그룹/신호 있음 | 큼. Phase 2 이후 |
| 노선 표시 | 색, 이름, A/B 배지 | bullet, textColor, shape 4종 | 작음: shape 옵션 |
| 배차 | 시간대별 시간당 열차 수(4단계), 왕복 후 소멸 | 3~4단계, 이상 편성 수(`idealTrainCount`), 편성당 차량 수 | 작음: 편성당 차량 수와 정원 |
| 열차 | 등속 12 m/s, 정차 시간 없음 | 가감속·최고속·경사·곡선 물리, 정차 20초 | 중간: 정차 시간부터 |
| 수요 | gravity 확률 스폰 | pops(집→직장 집단 + 출발 시각) | 중간~큼: matrix 모델(CityPack)이 pop과 가까움 |
| 승객 선택 | 항상 대중교통 | 운전/도보/대중교통 모드 선택 | 중간: Analysis의 분담률에 필요 |
| 정류장 이용권 | 없음 | 도보 30분, 환승 10분 | 정거장을 자유 배치할 때 필요 |
| 경제 | 없음 | 자금, 건설비, 운영비, 요금, 채권 | 큼. Phase 3 |
| 특수 수요 | attractor를 가까운 정거장에 합침 | 유형 분류 + 유형별 감쇠 지수 | 작음: `kind` 표준화와 감쇠 지수 |
| 통계 | 완료/포기, 시간대별 히스토그램 | 모드 분담률, 노선별 승객, 정거장별 승객 | 작음~중간 |

**추천 순서**: (1) 정차 시간과 편성당 차량 수/정원 (2) 승객의 모드 선택으로 분담률 표시 (3) attractor 유형 분류 + 감쇠 지수 (4) matrix 수요(pop 유사)를 엔진이 읽게 하기.

## 7. monorepo 전체 읽기 (2026-09-21)

`Subway-Builder-Modded/monorepo` 전체(foundry 스크립트, map-loader, railyard, website)를 읽었다. **LICENSE.md는 GPL-3.0**이므로 개념만 참고하고 코드는 가져오지 않는다.

- **건물→인구 추정** (`foundry/scripts/src/buildingPopData.js`): 건물 면적 × 층수를 OSM `building` 태그별 "1인당 면적"(단독주택 600ft², 아파트 240, 기숙사 125)과 "1일자리당 면적"(사무실 150, 소매 300, 창고·공장 500)으로 나눈다. 지역별 합계(`residents`, `jobs`)가 주어지면 그 안의 건물들에 비율로 재배분한다. 공항 터미널은 일자리 ×20. 계수는 코드 주석이 "vibes"라고 인정하는 임의값이고, 파일 자체도 미완성(미정의 변수, 누락된 import)이다.
- **공간 인덱스** (`buildings.js`): 위도 0.0009°(약 100m) 격자, 경도는 `cos(위도)`로 보정. 건물마다 bbox, 지하 기초 깊이(`building:levels:underground`, 기본 1), 폴리곤. 바다는 0.0027° 격자에 수심 -4 고정(실측 아님).
- **데이터 소스**: 도로는 Overpass 3단계(highway/major/minor), 타일은 Protomaps 일일 빌드를 `pmtiles extract --bbox`로 잘라냄, 썸네일 SVG는 타일의 water 레이어에서 생성. Overture 경로는 코드에 NON-WORKING 표기.
- **맵 팩 파일**: `demand_data.json`, `roads.geojson`, `runways_taxiways.geojson`, `buildings_index`(JSON 또는 gzip 바이너리, 게임 1.3.0 초과부터 바이너리), `ocean_depth_index.json`, `{z}/{x}/{y}.mvt`, 썸네일.
- **배포** (`railyard`, Go+Wails): Git 레지스트리에서 맵/모드 목록을 받아 zip 설치, 로컬 PMTiles 서버(임의 포트)로 타일 공급, 게임 버전별 호환 분기, 운전 경로 캐시 서버.
