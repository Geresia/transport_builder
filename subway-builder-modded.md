# Subway Builder Modded 조직 분석

- 대상: https://github.com/Subway-Builder-Modded (공개 저장소 14개)
- 조사일: 2026-09-20
- 방법: 소형 저장소 11개는 shallow clone 후 파일을 직접 읽음. 대형 저장소 4개(registry, monorepo, website-legacy, website-dev)는 GitHub API 파일 트리와 README, 일부 원본 파일만 확인함. 대형 저장소는 전체 코드를 읽은 것이 아니므로 아래 내용 중 세부 동작은 문서가 말하는 바이며 코드로 검증하지 않았음.

## 1. 한눈에 보기

Subway Builder(Redistricter, LLC 제작 게임)의 **비공식 커뮤니티 모딩 허브**. 게임과 제휴 관계가 아니며(프로필 문구), 커뮤니티가 만들고 유지함. 캐나다 기반, Discord 있음.

구성은 크게 네 층이다.

| 층 | 저장소 | 역할 |
|---|---|---|
| 배포/유통 | registry, monorepo(railyard) | 모드·맵 메타데이터 레지스트리와 설치 앱 Railyard |
| 제작 도구 | depot, template-mod, monorepo(foundry) | 맵 생성, 수요 데이터 편집, 모드 템플릿 |
| 세이브 유틸 | city-code-changer, save-merger | `.metro` 세이브 파일 변환·병합 |
| 사이트/운영 | website, website-legacy, website-dev, bot, .github | 문서·허브 사이트, Discord 봇 |

데이터 흐름: 제작자가 depot으로 맵 생성 → registry에 이슈 폼으로 등록(메타데이터만 저장, 바이너리는 제작자의 GitHub Release/URL) → Railyard 앱이 registry를 clone해 목록 표시 → 사용자 설치 시 zip을 받아 게임용 모드(`com.railyard.maploader`)를 생성해 게임에 맵을 등록.

## 2. 저장소별 정리

### 2.1 registry (TypeScript, 약 1.2GB)
"Railyard와 그 서비스를 구동하는 GitHub 호스팅 레지스트리".

- **규모**: 모드 64개, 맵 395개 (`manifest.json` 기준). 그중 `yukina-*` 맵이 133개로 일본(도쿄, 오사카, 교토, 삿포로 등), 폴란드, 체코, 슬로바키아, 우크라이나, 대만, 발트권을 대량 제공. `history/`에는 일별 스냅샷 398개.
- **저장 대상**: manifest, 갤러리 이미지, 업데이트 포인터만. 모드/맵 바이너리는 저장하지 않음.
- **제출**: 전부 GitHub Issue 폼. 폼 종류는 모드/맵 게시·갱신, 작성자 프로필 갱신, 신고, 폐기(deprecate), 삭제(delete), 폐기 해제, data-quality. 폼이 검증 CI를 돌리고 자동 PR을 만들며 머지되면 게시됨.
- **폐기 규칙**: 폐기는 되돌릴 수 있고 삭제는 영구적. 원 게시자 또는 활성 caretaker만 가능하고 협업자는 불가. 개별 버전 철회는 폼 없이 author가 처리.
- **이슈 코멘트 명령**: `revalidate`, `rescore_data`, `admin_author`, `data_quality_exempt`. 권한은 워크플로가 강제.
- **분석 자동화**: 다운로드 수는 매시간, 무결성·수요 통계는 3시간마다 갱신. 저장소 생존 검사는 매일 돌고 72시간 넘게 접근 불가면 리뷰 이슈를 만듦. 결과는 Discord 웹훅으로 요약.
  - 산출물: `downloads.json`, `integrity.json`, `grandfathered-downloads.json`, `repo-liveness.json`, `analytics/*.csv`
  - semver 버전만 다운로드 집계 대상. 무결성 검사에 실패한 버전은 집계에서 제외.
- **보안 스캔**: 모드 zip 안의 `.js/.ts`를 규칙(`security-rules.json`)으로 검사. 규칙 타입은 literal, regex, ast(`eval(atob(...))`, while 루프 안 특정 호출 등). ERROR면 해당 버전이 미완성 처리되어 다운로드 집계에서 빠지고, WARNING은 기록만 함. 규칙마다 `scripts/tests/fixtures/security-rules/<id>/`에 트리거 픽스처가 필요. 이 목적으로 만든 테스트 모드가 Test-Mod-VulnerabilityScanning.
- **데이터 품질 등급**: 맵에 `data_quality`(tier, 점수, rubric_version)를 부여. 품질 하한 미달이면 머지가 막히고 관리자가 면제할 수 있음.
- **구성**: `scripts/`는 lib, intake, listings, ops, tests, 다운로드·분석·알림 스크립트로 구성. 문서는 `ARCHITECTURE.md`, `KNOWN_INCIDENTS.md`, `RELEASING.md`, `docs/data-quality*.md`, `docs/terms-of-service.mdx`.

**맵 manifest 필드 (oslo-no 예시)**: id, name, author, github_id, description(HTML), tags, gallery, source, update(type=custom + URL), city_code(OSL), country, population, points_count, population_count, initial_view_state, data_source, source_quality, level_of_detail, location, special_demand, file_sizes, grid_statistics(최근접 거리, 통근 거리, 밀도, detail score, polycentrism), search_aliases(다국어), data_quality.
맵 zip에 들어가는 파일: `{CODE}.pmtiles`, `{CODE}_foundations.pmtiles`, `buildings_index.json/.bin`, `roads.geojson`, `runways_taxiways.geojson`, `demand_data.json`, `ocean_depth_index.json.gz`, `config.json`, `.railyard_map/special_demand_*.json`.

**모드 manifest 필드 (demand-clusters 예시)**: id, name, author, github_id, description(마크다운), tags, gallery, is_test, source, update(custom URL), last_updated.

**등록된 모드(64개)**: advanced-analytics, any-money, anysave, auto-lines, basedgoat-trains, chinese-trains, cinematic-camera, citymapper, compatibility-test-mod, copy-paste, danield1909-dantrains, danield1909-realism-pathfinding, dantrains-abridged, demand-clusters, demand-developer, dep-test-mod(+nested), distance-circles, game-speedup, hide-and-seek, imb11-moveit, imb11-subwaycine, improved-schematics, induced-demand, intercity-hsr-trains, japanese-trains, kr-ktp, la-metro-trainpack, lrt-trains, madrid-transit-pack, map-markers, missed-connections, mode-manager, mtr-trains, neighborhood-station-names, network-status, noah-great-society, orbital-surveyor, pause-on-start, penguin-approved-rolling-stock, prospector-ghebeek, resizable-ui, satellite-overlay, scrollable-dropdowns, simple-trains, station-dots, subway-builder-performance, subwaybuilder-regions, taiwan-trains, tathan-casino, test-mod-vulnscan, time-boost, tod, track-anarchy, track-visualizer, train-anarchy, transit-overlay, unrusted-chicago, unrusted-cities-pack, unrusted-detroit, upzoned-transit, valdotoriums-trains, zz-deletion-fixture, zz-deprecation-fixture.
분류: 열차 팩(japanese, chinese, taiwan, mtr, kr-ktp, LA metro, Madrid 등), 수요 분석(demand-clusters, demand-developer, induced-demand), UI/QoL(resizable-ui, scrollable-dropdowns, station-dots, copy-paste), 지도 오버레이(satellite-overlay, transit-overlay), 성능·시뮬레이션(subway-builder-performance, game-speedup, time-boost) 등. `zz-*`와 `*-test-mod`는 테스트 픽스처.

**맵 지역 분포 (395개)**: 미국 다수, 한국(seoul, busan, daegu, incheon 등 3/4 접미사 변형), 일본(jelegend-tokyo, yukina-tokyo, yukina-keihanshin, yukina-nagoya 등), 프랑스, 독일, 이탈리아, 중동, 호주/뉴질랜드, 남미(페루) 등. 전체 목록은 `maps/*/manifest.json`.

### 2.2 monorepo (TypeScript + Go, 약 106MB)
pnpm 워크스페이스. 프로젝트 공용 코드와 앱 두 개(Railyard, website), 도구(foundry)를 담음.

**공용 패키지 (`packages/`)**

| 패키지 | 내용 |
|---|---|
| config | 워크스페이스 상수 |
| shared-ui | 공용 React UI |
| asset-listings-ui / asset-listings-state | 목록 UI와 필터·정렬·상태 로직 (country-search, listing-status 포함) |
| stores-core | Zustand 스토어 정의 |
| lifecycle-core / -web / -wails | 폴링, 시작, 워밍업 훅. 웹용은 hydration과 theme script, Wails용은 딥링크와 이벤트 |
| map-loader | 게임 안에서 맵을 등록하는 JS (cities, layers, tabs, driving-path). Railyard가 생성하는 `com.railyard.maploader` 모드의 원본 |
| analytics, icons, mdx | 분석, 아이콘(discord/github/kofi/markdown), MDX 런타임과 remark 플러그인 |

**Railyard (`railyard/`)**: Go 1.25+, Wails 데스크톱 앱, 프런트엔드는 React. 기능은 커스텀 맵 브라우저·설치, 모드 브라우저, 콘텐츠 관리, 프로필 관리, 로컬 에셋 가져오기.
- Go 내부 패키지: announcements, config, deeplink, dialog, downloader, drivingpaths, files, gate, lock, logger, paths, profiles, registry, requests, steam, updater 등.
- 동작: registry를 Git으로 clone → 맵 zip(PMTiles, config, GeoJSON)을 데이터 디렉터리에 풀기 → 게임 실행 시 맵 로더 모드 생성 → 임의 포트에 로컬 PMTiles 서버를 띄워 타일 제공 → 수계 레이어로 SVG 썸네일 생성.
- 품질 관문: pre-push에서 gofmt, go test, Go 커버리지 60% 하한, 프런트엔드 lint/format/test/coverage.
- 문서(v0.1~v0.2): 설치(Windows/macOS/Linux), GitHub 토큰, 프로필, 로컬 에셋 가져오기, 게임 버전 비호환, 국기 이모지, 상태 필터, 트러블슈팅. 릴리스 노트는 v0.1.0 ~ v0.2.10.

**foundry (`foundry/`)**: 맵 제작 스크립트와 스키마.
- `foundry/schemas`: 특수 수요 JSON 스키마 + 검증기 (`@subway-builder-modded/special-demand-schemas`). `special_demand_points.schema.json`, `special_demand_types.json`, 예시 `izumo`, `tsugaru`.
- `foundry/scripts/src`: buildings, buildingPopData, roads, runways-taxiways, pmtiles, thumbnail, 그리고 utils(overpass, overture, file).

**website (`website/`)**: React 기반 사이트. features에 community, contribute, credits, depot, docs, home, legal, license, markdown-playground, railyard, registry, template-mod, updates가 있음. `content/`의 MDX 문서는 registry 문서(게시, 갱신, 소유권, caretaker, 폐기, 태깅, 의존성, 데이터 품질 등), template-mod v1.0 문서, depot(v1.0.0~v1.2.5)/railyard/template-mod/website의 업데이트 노트.

### 2.3 template-mod (TypeScript, MIT(package.json 기준), 69KB)
Subway Builder 모드용 TypeScript + React 스타터. rolldown-vite 사용, **pnpm 필수**. **Modding API v1.0.0** 기준이라 다른 게임 버전과는 타입이 어긋날 수 있음.

- 스크립트: `build`, `dev`(watch + 게임 실행 + 로그는 `debug/latest.log`), `dev:link/unlink`(dist를 게임 mods 폴더에 심볼릭 링크), `typecheck`.
- 게임 안에서 Ctrl/Cmd+Shift+R로 핫 리로드.
- `manifest.json`: id, name, description, version, author, main.
- 진입점은 `window.SubwayBuilderAPI`. `onMapReady`가 여러 번 불릴 수 있어 초기화 가드가 필요.
- API 영역(타입 정의 기준): `cities`, `map`, `trains`, `stations`, `career`(METRICS/OPERATORS/REGIONS), `ui`, `hooks`, `actions`, `gameState`, `build`, `popTiming`, `storage`, `utils`(React, lucide icons, Button/Card/Progress/Slider/Switch/Label 등 게임 UI 컴포넌트).
- `src/types/`에 20여 개 `.d.ts`(game-state, trains, stations, map, pop-timing 등)가 있어 게임 내부 모델을 파악하기 좋음.
- 사용 예: `api.hooks.onMapReady`, `api.hooks.onDayChange`, `api.ui.addFloatingPanel`, `api.ui.addButton('escape-menu', ...)`, `api.ui.showNotification`.

### 2.4 depot (Python, 1.8MB, GPL-3.0)
맵 제작 유틸 라이브러리. **셸 필수, Windows는 WSL 필수.** 검증 환경은 Python 3.13.9. 지원 버전 표(duckdb, geopandas, mapbox_vector_tile, numpy, scipy, shapely, osmnx, xarray 등)와 conda `environment.yml` 제공.

외부 CLI 요구: node, mapshaper, osmium, java, tippecanoe/tile-join, sqlite3, jq, pmtiles, planetiler.jar. (로컬 OSRM을 쓰면 Docker.) 하나라도 없으면 실행 안 됨.

- **`depot.maps.MapGen`**: `city`(2~4자 코드), `bbox`, `osmpbf`(Geofabrik) 입력. 순서는 `extract_base_data` → `process_buildings`(Overture 건물, `buildings_index.json`) → `process_roads_and_aeroways` → `generate_pmtiles` → `add_labels`. 한 번에는 `run_all`, 라벨 점검은 `check_labels`. 라벨은 cities/suburbs/neighborhoods로 줌 단계별 분류하며 언어 선호(`prefer:`/`force:`) 설정 가능. 건물 지반(foundation)과 해양 지반(GEBCO 수심)을 계산해 트랙이 물속을 지나지 못하게 하는 옵션이 있음. maxzoom 15, 타일 최대 500KB(건물은 450KB 기본).
- **`depot.demand.DemandData`**: 수요 데이터 편집. `sanitize`, `scale_demand`, `consolidate_pops`, `agglomerate_pops`, `cluster_points`, `merge_identical_commutes`, `move/add/del_points`, `calculate_routes`(osmnx 또는 OSRM), `prepare_osrm`, 특수 수요 스키마 로딩, `create_config`(Railyard 제출용 config.json), `create_description`(맵 설명 HTML).
- `roads_config.json`, `special_demand_types.json` 포함. `examples/`(HEL, LAXM 맵, TPA 수요), `tests/` 있음.
- 방법론 언급: "Colin의 중력 모델 수정판으로 통근 생성" (registry의 Oslo 맵 설명). 데이터 소스는 국가 격자 통계(노르웨이 SSB 250m 격자 등).

### 2.5 city-code-changer (Python, MIT, 15KB)
`.metro` 세이브의 도시 코드를 바꿔 겹치는 다른 맵으로 네트워크를 이전 (예: SJU→PR, LAXM→LAX). 표준 라이브러리만 사용. `python change_city_code.py <file.metro> <NEW>` → `<NEW>_<원본>.metro` 출력. 릴리스에 사전 빌드 실행파일 제공. 파일 포맷 처리는 ejfox의 metro-savefile-doctor를 따랐다고 크레딧 명시.

### 2.6 save-merger (Python, 6KB)
같은 도시 코드의 세이브 두 개 병합. `.metro`/JSON 입력, 표준 라이브러리만 사용, Python 3.9+. 첫 세이브가 기준(경제, 경과 시간, 난이도, 수요 등 유지)이고 두 번째에서 tracks, track groups, signals, station nodes, stations, routes, 운행 중 열차를 가져옴. 공유 엔티티는 안정 ID로 매칭하고 `trackIds`/`stNodeIds`/`routeIds` 관계를 합침. 도시 코드가 다르거나 없으면 거부. `--output`, `--force` 옵션. 테스트 파일 있음.

### 2.7 map-manager (JavaScript, 511KB)
Railyard 이전 세대의 맵 관리 도구 (README는 "See subwaybuildermodded.com" 한 줄뿐). `MapLoader-Electron`은 Electron Forge + webpack + React(app.jsx, mapList.jsx)로 만든 데스크톱 앱이고 pmtiles 서버와 썸네일 생성이 있음. `map_scripts/`는 data 다운로드·가공, 타일 다운로드, 주행 경로 계산(`compute_driving.js`), 썸네일 스크립트. Railyard로 대체된 구버전으로 보임(코드 근거는 구조와 README뿐, 공식 언급은 못 찾음).

### 2.8 bot (JavaScript, 110KB)
Discord 봇 (discord.js 14, dotenv, pnpm). 서비스 모듈: 기능 요청(feature), 지원 티켓(support), 베타 테스트(betatest), 포럼, 설정(setup), GitHub 연동(report, service), Railyard 서비스, 웹훅 서버(`webhookServer.js`), 보안·텍스트 유틸. 슬래시 명령: `feature`, `support`, `betatest`, `setup`, `resetfeatureticket`, `resetsupportticket`, `setfeatureticket`, `setsupportticket`, `add/remove/create/delete` 등 하위 명령. 티켓 카운터는 `src/data/*.json`에 저장. 이 봇이 registry의 Discord 웹훅 알림과 같은 것인지는 확인하지 못함.

### 2.9 사이트 3종
- **website** (TypeScript, 32MB): 현재 사이트. 실제 소스는 monorepo/website에 있는 것으로 보임 (같은 features 구조). 이 저장소에서 별도 확인은 못 했음.
- **website-legacy** (MDX, 383MB): Docusaurus 기반 옛 비공식 문서. 맵 설치 가이드/맵 디렉터리/문제 해결, 맵 제작(`making-custom-maps`, `optional-features`), Railyard 게시(`publishing-map-packs`, `publishing-projects`), template-mod 문서 6편, 번역 기여 가이드, 독일어 i18n 20파일.
- **website-dev** (HTML, 1.8GB, 브랜치 `gh-pages`): 프리릴리스 빌드 산출물. registry 스냅샷(맵 3611파일, 모드 530파일, 작성자 227) 등이 통째로 들어 있어 용량이 큼. 코드가 아니라 배포물이므로 읽을 가치는 낮음.

### 2.10 테스트 픽스처
- **compatibility-test-mod** (TS): 모드 호환·비호환 테스트 전용. 열차 데이터 CSV 임포트(`scripts/train-import.ts`), 릴리스 워크플로 있음.
- **Dependency-Test-Mod** (JS): 모드 의존성(base/nested) 해석 테스트. registry의 `dep-test-mod`, `dep-test-mod-nested`가 이것.
- **Test-Mod-VulnerabilityScanning** (JS): 보안 스캐너를 시험하는 의도적 취약 모드. registry의 `test-mod-vulnscan`. 실제 사용 목적이 아니라 픽스처.

### 2.11 .github
조직 프로필 README. 프로젝트 소개, Discord 링크, credits, license 페이지, "Subway Builder 및 Redistricter, LLC와 무관" 고지.

## 3. 아키텍처 요약

```
[제작]  depot(MapGen/DemandData) ─┐          foundry(스키마/스크립트)
        template-mod ────────────┤
                                 ▼
[등록]  registry  ◀── GitHub Issue 폼 ──▶ CI 검증(스키마, 무결성, 보안 스캔, 품질 등급) ──▶ 자동 PR
           │  (메타데이터 + 갤러리, 바이너리는 제작자 호스팅)
           ▼
[유통]  Railyard(Wails, Go+React) ── registry clone ── zip 설치 ── 로컬 PMTiles 서버
           │                                   └ 게임용 모드 com.railyard.maploader 생성
           ▼
[게임]  Subway Builder (Modding API v1.0.0, window.SubwayBuilderAPI)
[운영]  website(MDX 문서) · bot(Discord) · 분석 CSV/JSON(시간별/3시간별 자동)
```

## 4. transitline 프로젝트와 연결할 만한 점

메모리 기준으로 이 프로젝트는 도쿄/일본을 기준으로 실데이터를 쓰는 방향이므로, 참고할 부분은 다음이다. (아래는 제안이며, 조직 코드에서 직접 확인한 사실과 구분함.)

- **일본 맵이 이미 있음**: `jelegend-tokyo`, `yukina-tokyo`, `yukina-keihanshin` 등. 수요 데이터 모델과 데이터 출처를 비교해 볼 가치가 있음 (각 맵 manifest의 `data_source`, `methodology` 참고).
- **수요 모델**: depot의 `DemandData`(points/pops, 통근 쌍, 특수 수요)와 registry의 중력 모델 언급은, 건물 단위 인구 모델을 만들 때 스키마 참고 자료가 됨. 특수 수요 스키마는 `foundry/schemas`에 JSON Schema로 공개돼 있음.
- **게임 내부 모델**: template-mod의 `src/types/*.d.ts`(Station, Track, Train, Route, popTiming)는 Subway Builder의 엔티티 모델을 그대로 보여줌. `save-merger`는 `.metro` 세이브의 엔티티 관계(`trackIds`, `stNodeIds`, `routeIds`)를 알려 줌.
- **라이선스 주의**: depot 등 GPL-3.0 코드를 가져다 쓰면 파생물에 GPL이 전파될 수 있음. 스키마나 데이터 구조를 참고만 할지, 코드를 재사용할지 정한 뒤 라이선스를 저장소별로 확인할 것.

## 5. 한계와 확인 못 한 것

- registry, monorepo, website-legacy, website-dev는 전체를 읽지 않음. Railyard의 Go 코드, 프런트엔드, 워크플로 YAML, 스키마 세부는 파일 목록과 README 수준으로만 파악함.
- 라이선스 확인 결과: depot=GPL-3.0, city-code-changer=MIT, map-manager=ISC(Kronifer 저작권 표기), template-mod와 compatibility-test-mod=package.json에 MIT(LICENSE 파일 없음), bot=package.json에 ISC(LICENSE 파일 없음), save-merger와 website는 LICENSE 파일 없음. registry, monorepo, website-legacy, website-dev는 확인하지 않음.
- 각 모드/맵 개별 내용(395 + 64개)은 목록과 샘플 하나씩만 봄.
- 로컬 사본은 세션 임시 폴더(scratchpad)에 있어 세션이 끝나면 사라질 수 있음.
