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

## 8. MLIT 国土数値情報 이용약관 확인 (2026-09-21)

출처: nlftp.mlit.go.jp/ksj/other/agreement.html 및 각 데이터셋 페이지.

- **기본 약관**: PDL1.0, 상업 이용·가공 허용. 출처 표기 필수(`出典：国土交通省国土数値情報ダウンロードサイト（URL）`). 가공했으면 별도로 데이터 이름과 가공 사실을 적고, 국가가 만든 것처럼 보이게 하면 안 된다(`「国土数値情報（○○データ）」（国土交通省）をもとに○○作成`).
- **데이터셋별 예외** (기본 약관이 적용되지 않을 수 있음):
  | 데이터 | 최신 | 조건 |
  |---|---|---|
  | P29 학교 | 2023 | CC BY 4.0 (상업 가능). 2013판은 **비상업**이므로 2021/2023판만 사용 |
  | P04 의료기관 | 2020 | 오픈데이터(상업 가능) |
  | P27 문화시설 | 2013 | **비상업 전용** — 사용 불가 |
- **결론**: P29(2023)와 P04(2020)는 출처 표기 후 사용 가능. P27은 쓰지 않고 OSM/다른 소스로 대체. 공항·항만 CSV는 미확인.

## 9. depot 전체 읽기 (2026-09-21)

`Downloads/depot-main` 전체(17개 파일: `maps.py` 3,141줄, `demand.py` 2,204줄, `special_demand_types.json`, 예제·테스트)를 읽었다. Subway Builder 맵을 만드는 Python 도구이며 **GPL-3.0이므로 개념만 참고하고 코드·수식 구현은 가져오지 않는다.** 외부 프로그램(osmium, tippecanoe, planetiler, mapshaper, pmtiles 등)과 Windows에서는 WSL이 필요하다.

- **실측 수심**: GEBCO 격자를 OPeNDAP으로 받아 약 0.0027°(300m) 격자로 보간하고, 5·10·50·100m 등 계단식 수심 구간의 등고선 다각형으로 만든다. 바다에서는 노선이 물속 대신 위쪽이나 해저 밑으로만 지나게 한다(monorepo의 "수심 -4 고정"보다 정확). **우리 반영**: `packs/tokyo/bathymetry.json`(GEBCO_2026, 15초 격자), `engine/src/bathymetry.mjs`. 등고선 다각형은 만들지 않았다.
- **건물 기초 깊이**: 건물 높이와 최소 회전 외접 사각형의 짧은 변으로 기초 깊이를 추정하고 10~80m로 제한한다. **우리 반영 없음** — 조사 데이터의 실제 지하 층수(`obstacles.json`의 `levels_underground`)가 더 실측에 가깝다. 깊이가 필요해지면 층수에서 환산한다.
- **맵 파일 생성 파이프라인**: 건물 충돌 색인은 소형 건물(기본 40㎡ 미만)을 제외하고 꼭짓점을 간소화하며, 타일당 건물 크기 상한(450KB, 절대 상한 500KB)을 둔다. 건물 원본은 Overture Maps(우리는 OSM 전용). OSM 건물이 듬성한 도쿄 북동부 4개 구는 Overture로 보완할 여지가 있다(미검토).
- **수요 가공 메서드**: `sanitize`, `scale_demand`, `enforce_max_pop_size`(큰 pop 분할), `consolidate_pops`(pop 크기별 거리 기준 [25/10/5/2명 → 2/4/80/16km]로 병합), `agglomerate_pops`(도심과 비도심에 서로 다른 거리 기준), `merge_identical_commutes`, `cluster_points`, `move/add/del_points`, `calculate_routes`(OSMnx 또는 로컬 OSRM으로 이동 시간·거리), `create_config`·`create_description`(Railyard 등록용). §5와 대부분 겹친다.
- **특수 수요 분류** (`special_demand_types.json`, 25종): 공항, 놀이공원, 수족관, 온천시설, 컨벤션, 문화시설, 관공서, 유적, 병원, 도서관, 군사기지, 박물관, 자연경관, 공원, 항만, 종교시설(신사·절 하위 종류), 리조트, 학교, 상업시설, 스포츠시설, 대학, 동물원, 域外接続 등. 종마다 코드(AIR, UNI…)와 **일본어 이름**, 하위 종류가 있다. 도쿄 팩의 명소 목록을 만들 때 분류 틀로 쓸 만하다.
- **기타**: 지도 라벨은 OSM `place` 태그를 도시·교외·동네 세 단계로 나눠 줌 수준별로 표시한다(`check_labels`로 태그 분포 확인).

## 10. save-merger (2026-09-22)

`C:\Users\이상재\Downloads\save-merger-main` — Subway Builder 세이브 2개를 합치는 독립 실행 Python CLI(표준 라이브러리만 사용, 655줄 이하). **LICENSE 파일 없음** → template-mod 타입 정의와 같은 상황(저작권 기본 규칙 적용, 재배포·코드 복사 권한 불명확) → **읽기만, 코드 금지**.

- **`.metro` 바이너리 포맷을 리버스 엔지니어링해 문서화한 첫 자료다.** 4096바이트 고정 헤더 + `METR` 매직 바이트. 헤더 오프셋 8에 `<6I`(리틀엔디언 unsigned int 6개)로 autosave 인덱스/썸네일/게임데이터의 (offset, size) 3쌍이 있다. 오프셋 32에 int64 타임스탬프, 40(256바이트)에 이름, 296(32바이트)에 cityCode, 328(64바이트)에 세션 ID, 392(512바이트)에 stats JSON, 912에 압축 데이터의 CRC32 — 전부 널 종료 UTF-8 고정폭 문자열. 게임 본체는 헤더 뒤에 gzip 압축된 JSON(`{mainSave: {data: {...}}, autosaves: []}`)으로 온다.
- **세이브 데이터의 7개 최상위 컬렉션이 실제로 확인됐다**: `tracks`, `trackGroups`, `signals`, `stNodes`, `stations`, `routes`, `trains`. §1의 타입 정의 기반 모델과 일치하지만, `signals`가 StCombo.path 안에 파묻힌 값이 아니라 **최상위 컬렉션**(다른 엔티티들이 id로 참조)이라는 점은 타입 정의만으로는 몰랐던 부분이다.
- **엔티티 간 연결은 문자열 id 배열**(`trackIds`, `stNodeIds`, `routeIds`)로 저장된다. 공유 병합 시 이 세 필드만 합집합으로 합치고 나머지 필드는 base 세이브 값을 유지한다 — 즉 이 세 필드가 "다대다 관계"의 정본이고 나머지(이름 등)는 각 엔티티가 소유.
- **세이브 최상위에 `money`, `elapsedSeconds`가 있다** — §6 표의 "경제: 자금 … 없음(Phase 3)" 갭과 직결되는 실제 필드명. 병합 시 base 세이브 값을 그대로 유지(경제 상태는 공유 대상이 아님).
- `cityCode`가 저장 파일 자체의 필드다(두 세이브가 같은 도시인지 검증하는 키) — 우리 CityPack의 `manifest.id`와 개념은 같지만 이쪽은 게임이 부여한 코드.

## 11. city-code-changer (2026-09-23)

`github.com/Subway-Builder-Modded/city-code-changer` — `.metro`의 `cityCode`만 바꿔서 다른 지도로 네트워크를 옮기는 285줄짜리 독립 실행 Python 스크립트(`change_city_code.py` 한 개, 표준 라이브러리만 사용). **MIT 라이선스** — save-merger·depot·monorepo와 달리 코드를 그대로 가져다 써도 된다. `gh repo clone`으로 `Downloads/city-code-changer`에 받음.

- **§10 save-merger의 `.metro` 헤더 리버스 엔지니어링을 그대로 확인해준다**: 매직 `METR`, 4096바이트 헤더, 오프셋 8/12/16/20/24/28에 autosave 인덱스·썸네일·게임데이터의 (offset,size) 세 쌍(`<6I`), 32(리틀엔디언 u32+i32로 나눈 64비트 타임스탬프), 40(이름 256B), 296(cityCode 32B), 328(세션ID 64B), 392(stats JSON 512B), 912(CRC32) — 전부 동일. 독립적인 두 소스가 일치해서 이 포맷 문서화의 신뢰도가 올라갔다.
- **추가로 확인된 것**: 압축은 raw zlib이 아니라 **gzip 헤더 포함**(`zlib.compressobj(wbits=16+MAX_WBITS)`로 쓰고 `zlib.decompress(data, 15+32)`로 읽음 — 15+32는 zlib/gzip 자동 판별). `stats` JSON의 기본 키는 `{stations, routes, trains, money}` 4개(§10에서 본 최상위 `money`/`elapsedSeconds`와는 별개로, 헤더 안에도 요약 통계가 한 번 더 있다는 뜻).
- **우리 반영**: 없음. 이 저장소는 **세이브 파일**(플레이어가 지은 네트워크 상태)을 다루고, `transitline/subway-builder-export/`가 만드는 건 **맵팩 파일**(`demand_data.json`, `buildings_index.json` 등 depot이 만드는 것과 같은 종류)이라 대상이 다르다. 나중에 우리 엔진 상태를 실제 `.metro`로 내보내는 기능을 만들 때, MIT라서 이 파서/시리얼라이저를 그대로 포팅해 쓸 수 있는 후보로 남겨둔다. 원 저작자는 이 코드가 `ejfox/metro-savefile-doctor`(TS)를 참고했다고 밝힘 — 그쪽은 라이선스 미확인.

## 12. website-legacy + map-manager (2026-09-23)

`github.com/Subway-Builder-Modded/website-legacy`(구 공식 위키, archived, **LICENSE 없음 → 읽기만**)와
`github.com/Subway-Builder-Modded/map-manager`(Kronifer의 구버전 맵 패처, archived, **ISC 라이선스 →
코드 재사용 가능**)를 `gh repo clone`으로 받아 읽음. website-legacy는 "구버전" 표시가 있어 depot 이전
파이프라인 문서라 상당 부분 depot로 대체됐지만, depot에는 없는 두 가지가 있다.

- **맵팩 배포 형식이 정확히 나온다** (`modding-docs/creating-maps/making-custom-maps.mdx`): 최종 zip은
  `demand_data.json`, `buildings_index.json`, `roads.geojson`, `runways_taxiways.geojson`, `XXX.pmtiles`
  (`XXX`=도시 코드), `config.json` 6개 파일이 **서브폴더 없이 zip 루트**에 있어야 한다. `config.json` 스키마:
  `name, code, description, population, initialViewState{zoom,latitude,longitude,bearing}, creator, version`
  (선택: `thumbnailBbox`, `country`=ISO 3166-1 alpha-2).
- **Railyard 등록 절차** (`modding-docs/railyard/publishing-map-packs.mdx`): GitHub에 소스+릴리스를 올리고,
  레지스트리 이슈("Publish New Map")를 열어 Map ID(kebab-case, 영구 고정)/City Name/City Code/Country
  Code/Population/Description/Tags/Data Source/Source URL/Update Type(GitHub Releases 또는 자체 호스팅
  `update.json`)을 입력하면 자동으로 PR이 생성되고 관리자가 검토한다. `update.json` 스키마(버전별
  download URL + sha256)도 있음. **[[project-subway-builder-export]]가 실제로 Railyard에 낼 단계까지
  가면 이 문서가 그 다음 단계다.**
- **map-manager**(`map_scripts/`, Node.js): depot 이전에 쓰이던 실제 코드. `download_data.js`가
  Overpass로 도로(`highway=*`)를 받아 **`roads.geojson`을 정확히 어떤 모양으로 만드는지** 보여준다 —
  `{type:"Feature", properties:{roadClass, structure:"normal", name}, geometry:{type:"LineString",...}}`,
  `roadClass`는 `motorway→highway, trunk/primary→major, secondary/tertiary/unclassified/residential→minor`
  (참고: [[project-subway-builder-export]]가 실제 게임 설치본에서 확인한 `roadClass`는 3종 동일, `structure`는
  bridge/normal/tunnel 3종 — 이 스크립트는 tunnel/bridge 구분을 안 하는 구버전이라 그 부분만 낡음). ISC라
  이 쿼리·매핑 로직을 그대로 가져다 `roads.geojson`을 채우는 데 쓸 수 있다(Option B).
  `process_data.js`의 `squareFeetPerPopulation`/`squareFeetPerJob`는 monorepo foundry가 나중에 베낀
  **원조 "감으로 정한" 수치**임을 확인(주석이 "vibes vibes vibes", "TIL..." 등 — 실측 아님이 코드 주석에도
  써 있다). 우리가 이미 실측 데이터로 대체하기로 한 결정([[feedback-real-data-over-synthetic]])이 맞았다는
  재확인일 뿐, 반영할 내용 없음. `buildings_index.json`의 압축 배열 스키마(`{cs, bbox, grid:[cols,rows],
  cells:[[x,y,...ids]], buildings:[{b:bbox,f:foundationDepth,p:polygon}]}`)도 확인 가능.
