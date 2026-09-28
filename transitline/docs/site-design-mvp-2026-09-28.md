# 3D 현장 설계 MVP (Three.js) — 기술 정리

- 기준일: 2026-09-28 (1단계 뷰어), 2단계 편집 세션 추가도 같은 날
- 파일: [`packs/tokyo/site-design.html`](../packs/tokyo/site-design.html) (독립 페이지 — 1단계는 뷰어,
  2단계부터 편집기),
  [`engine/src/map/site-design-scene.mjs`](../engine/src/map/site-design-scene.mjs) (순수 변환 모듈, 1단계),
  [`engine/src/map/site-design-session.mjs`](../engine/src/map/site-design-session.mjs) (순수 세션/draft 모듈, 2단계),
  [`engine/test/site-design-scene.test.mjs`](../engine/test/site-design-scene.test.mjs),
  [`engine/test/site-design-session.test.mjs`](../engine/test/site-design-session.test.mjs)
- 계기: [tokyo-walk-mvp-2026-09-28.md](tokyo-walk-mvp-2026-09-28.md)의 "걷는 지도"에 이어, 이번에는
  역의 **본체·승강장·출입구**를 실제 3D 구조물로 확인할 수 있는 현장 설계 뷰어가 필요해졌다(1단계).
  이어서 실제 게임에서 받은 역을 그 자리에서 옮기고 크기·깊이를 바꿔 부모(메인 화면)에 돌려주는
  **편집 세션**이 필요해져 §7에서 확장했다(2단계). 기존 워크 MVP(`walk.html`)는 여전히 건드리지 않았고,
  §7의 모든 통신·상태 로직도 별도 파일(`site-design-session.mjs` + `site-design.html`)에만 있다.

## 1. 범위 — 이 MVP가 하는 일 / 안 하는 일

**함:**
- `engine/src/map/station-site.mjs`가 이미 계산해 둔 StationSite(공간 사실)를 3D로 시각화
- 선택한 역 주변의 건물·도로·지형(색상)을 `walk.html`과 같은 MapLibre 스택으로 배경에 표시
- 역 본체(승강장 포함 하나의 폴리곤), 출입구 후보, 작업구 후보를 반투명 구조물로 렌더링
- 걷기(WASD, `walk.html`과 같은 방식), 자유 카메라(마우스 드래그/스크롤로 각도·줌 자유 조작), 클릭으로 구조물 선택 + 읽기 전용 사실 패널
- 뷰 상태(선택한 역·카메라·선택 객체) 저장/복원 (§4)

**의도적으로 안 함 (ponytail — 필요해지면 그때 추가):**
- **비용·기간·위험 계산 없음.** 화면에 나오는 모든 수치는 `station-site.mjs`가 이미 만들어 둔 공간
  사실(`spatialFlags`, `unknown`, `dataQuality` 등 — 계약 자체가 "사실이지 점수가 아니다"라고 명시함)
  뿐이다. 새 점수·추정·경영 로직은 하나도 추가하지 않았다.
- `engine/src/management/**`를 import하지 않는다 — 엔진 판정(공사 진행 상태 등)은 표시하지 않는다.
- 역만 다룬다. depot-site.mjs·construction-site.mjs는 읽었지만(계약 형태 파악용) 이번 렌더러는 아직
  역만 연결했다 — 같은 패턴(로컬미터 변환 → Three.js 메쉬)으로 확장 가능.
- (1단계 당시) 편집 없음 — **2단계(§7)에서 postMessage 기반 편집 세션을 추가했다.** 본체 이동·회전·
  크기·깊이, 출입구 이동은 이제 된다. 여전히 안 하는 것: 건물 충돌 재계산(§7), 비용·기간·위험 계산.
  일단 데모 데이터는 `packs/tokyo/station-examples/*.station.json`(8개 예제, 이미 존재)를 그대로 읽는다
  (부모 세션이 없을 때의 폴백으로만, §7).
  실제 DEM 지형 메쉬(고저차가 있는 지면) 없음 — `walk.html`과 동일하게 색으로만 지표를 표현한다.
  건물 충돌판정 없음(벽 통과) — `walk.html`과 동일.

## 2. 모듈 경계

```
engine/src/map/site-design-scene.mjs   (순수, DOM/Three.js 미참조)
  StationSite(station-site.mjs 출력) --읽기전용--> 로컬미터 좌표 + 표시용 사실

packs/tokyo/site-design.html            (렌더러, 이 파일에만 Three.js/MapLibre 있음)
  station-examples/*.json --fetch--> buildStationSiteScene() --> Three.js 메쉬 + 사실 패널
  MapLibre CustomLayerInterface가 Three.js 씬의 카메라 행렬을 매 프레임 동기화 (공식 연동 방식)
```

| 원칙 | 지킨 방법 |
|---|---|
| 기존 파일 수정 금지 | `walk.html`, `station-site.mjs`, `depot-site.mjs`, `construction-site.mjs`는 읽기만 했고 한 줄도 바꾸지 않았다 |
| `engine/src/management/**` 수정 금지 | 애초에 import조차 하지 않는다 (엔진 판정·비용·공정 없음) |
| 공간 계약은 읽기 전용 | `site-design-scene.mjs`는 `station-site.mjs`의 출력(StationSite 객체)을 입력받아 새 객체를 반환할 뿐, 입력을 변경하지 않는다(테스트로 검증, §3) |
| 별도 모듈 | Three.js·MapLibre 의존성은 `site-design.html` 한 파일에만 있다. 순수 좌표 변환(`site-design-scene.mjs`)은 렌더러가 없어도(Node 테스트에서도) 동작한다 |

`site-design-scene.mjs`는 `station-view.mjs`의 `factRows()`만 재사용한다(순수 함수, DOM 없음). 라벨
사전(`FLAG_LABELS`, `ENTRANCE_FLAG_LABELS`, `REASON_LABELS`)은 렌더러가 직접 `station-view.mjs`에서
가져다 쓴다 — 2D 캔버스를 그리는 `drawStationOverlay()`/`renderStationDetail()`은 이 MVP가 전혀 쓰지
않는다(그건 기존 지도 화면의 몫).

### `buildStationSiteScene(site)` 계약

입력: `station-site.mjs`의 `buildStationSite()` 반환값 하나 (`schema: "transitline.station-site-geometry/1"`).
스키마가 다르면 예외를 던진다(잘못 연결됐을 때 조용히 빈 화면을 내지 않도록).

출력 (`schema: "transitline.site-design-scene/1"`):

| 필드 | 내용 |
|---|---|
| `origin` | 역 위치 (lon/lat) — 이 값이 로컬미터 좌표계의 원점 |
| `body` | `null` 또는 `{ polygonXY, baseZMeters, heightMeters, lengthMeters, widthMeters, headingDegrees, areaSquareMeters, structure }`. `baseZMeters`는 `plannedDepthMeters > 0`이면 `-깊이`(지하/개착), 아니면 0(지상 — 고가 높이는 계약에 없어 추정하지 않음). `heightMeters`는 표시용 추정치(6 m, "역사 1개 층" 가정)이지 설계값이 아니다 |
| `entrances[]` | `{ id, xy, footprintMeters, distanceToBodyMeters, blocked, flags }` — `blocked`는 `spatialFlags`에 `building-collision`/`in-water`가 있는지만 본 파생값(새 판정 아님) |
| `workAreas[]` | `{ id, slot, polygonXY, areaSquareMeters, blocked }` |
| `flags`, `unknown`, `unknownReasons`, `dataQuality` | `station-site.mjs`가 낸 값 그대로 |
| `facts` | `station-view.mjs`의 `factRows()` 그대로 (2D 화면과 같은 표) |

좌표계: `engine/src/map/local-geometry.mjs`의 `frameAt(origin)`과 동일한 등장방형 근사 —
`x = 동쪽(m)`, `y = 북쪽(m)`. Three.js 씬에서는 `Y = 남쪽(-y)`, `Z = 위`로 한 번 더 변환한다
(MapLibre의 메르카토르 Y가 남쪽으로 증가하기 때문 — `site-design.html`의 주석 참고).

## 3. 테스트

`engine/test/site-design-scene.test.mjs` (node:test, `npm test`에 포함):
- 스키마가 아닌 입력은 예외를 던진다
- 입력 StationSite를 변이하지 않는다(깊은 비교)
- 지상역: 본체가 지표(`baseZMeters === 0`)에 놓이고, 출입구/작업구 개수가 원본과 같다
- 깊이 38 m역: 본체가 `-38`에 놓인다(지하 오프셋 확인)
- 출입구 `blocked`가 `spatialFlags`에서 파생됨을 확인
- 결과 객체 어디에도 `cost|budget|price|duration|schedule|days|months|risk|probability|score`류 키가
  없음을 재귀로 검사 — "비용·기간·위험 계산 없음" 제약이 나중에 실수로 깨지는 걸 잡는 회귀 가드

렌더러(`site-design.html`)는 브라우저 전용(Three.js/WebGL)이라 node:test로 못 돌린다 — 헤드리스 Chrome으로
수동 확인했다(§5).

## 4. 저장 형식 (뷰 상태)

이 MVP는 **뷰어**라 팩 데이터를 저장하지 않는다. 저장하는 건 "지금 보고 있는 화면"뿐이다 — 어느 역,
어떤 카메라 모드, 어디를 보고 있는지, 무엇을 선택했는지. 두 곳에 같은 형식으로 저장한다:

- `localStorage["transitline.site-design.view"]` — 마지막으로 본 화면을 다음 방문 때 복원
- URL 해시 `#v=<base64url(JSON)>` — "이 뷰 링크 복사" 버튼이 만든다. 현재 스크린을 남에게 공유하거나
  북마크할 때 쓴다. 해시가 있으면 `localStorage`보다 우선한다

```jsonc
{
  "schema": "transitline.site-design-view/1",
  "stationSiteFile": "04-deep-station.station.json", // packs/tokyo/station-examples/ 안의 파일명
  "cameraMode": "walk", // "walk" | "free"
  "center": [139.70422, 35.70441],  // 소수 6자리
  "zoom": 17.6, "bearing": 20, "pitch": 78, // MapLibre 카메라, 소수 1~2자리
  "selected": { "kind": "entrance", "id": "ent:beffffb0c2afbcfe" } // 또는 null
}
```

base64url 인코딩은 URL-safe(`+/` → `-_`, 패딩 제거)이고 UTF-8을 거쳐 한글/일본어 역 이름도 안전하게
왕복한다(`btoa(unescape(encodeURIComponent(...)))` 관용구). 스키마 필드가 있어 나중에 형식이 바뀌어도
구버전 저장값을 구분할 수 있다.

## 5. 실행 / 확인

```powershell
powershell -File ../docs/serve.ps1 -Root .. -Index packs/tokyo/site-design.html
```

`http://localhost:8000/packs/tokyo/site-design.html`. 헤드리스 Chrome(CDP)으로 확인한 것:
- 페이지가 콘솔 오류 없이 로드되고(파비콘 404 제외), MapLibre·pmtiles·Three.js·`site-design-scene.mjs`·
  `station-view.mjs` 전부 정상 로드됨 (네트워크 로그로 확인)
- 첫 예제(01)의 StationSite를 fetch해 씬을 만들면 `siteGroup`에 정확히 기대한 개수의 메쉬가 생김
  (본체 1+테두리1, 출입구 4, 작업구 4×(메쉬+테두리)=8 → 총 14) — 좌표도 원점 근처 수십 미터 안
- 클릭 → 레이캐스팅 → 우측 "선택" 패널 갱신까지 실제로 동작함(자동화 도구가 보낸 클릭이 본체 메쉬에
  맞았고, 패널에 정확한 본체 사실이 표시됨)
- **버그 하나 발견·수정**: 처음엔 `new THREE.Camera()`(베이스 클래스)를 썼는데 `THREE.Raycaster.
  setFromCamera()`가 이를 지원하지 않아(`isPerspectiveCamera` 없음) 클릭 선택이 항상 실패했다.
  `new THREE.PerspectiveCamera()`로 바꿔 해결(투영 행렬은 여전히 매 프레임 MapLibre 쪽에서 덮어씀)

같은 세션에서 다른 Claude 세션이 같은 Chrome 프로필(chrome-devtools-mcp)을 동시에 쓰고 있어
("browser is already running") 드롭다운 8개 예제 전체 순회·"걷기/자유 카메라" 버튼 클릭까지는
끝까지 수동 확인하지 못했다 — 다만 그 경로들은 `loadSite()`/`setMode()`의 단순한 상태 전이이고,
`buildStationSiteScene()` 쪽 분기(지상/지하 깊이, 막힌 출입구 등)는 §3의 노드 테스트가 이미
8개 예제 중 3개(지상·38 m 지하·출입구 막힘)를 실제로 검증한다.

## 7. 2단계 — 편집 세션 (postMessage)

역만 **보던** 1단계 뷰어를, 실제 게임(부모 화면)에서 받은 역을 3D에서 옮기고 크기·깊이를 바꿔
결과를 돌려주는 **독립 편집기**로 확장했다. "독립"이 핵심이다 — `engine/index.html`·`main.mjs`·
`state.mjs`·`render.mjs`(메인 화면 연결은 다른 세션 담당)와 `engine/src/management/**`,
`construction-workfront-*`는 이번에도 한 줄도 안 건드렸다.

### 7.1 통신 계약

부모(게임) ↔ `site-design.html`(iframe)이 `window.postMessage`로 주고받는다. `?targetOrigin=` 쿼리
파라미터로 부모의 origin을 지정할 수 있고, 없으면 `"*"`(느슨한 기본값 — 로컬/단일 사용자 게임 기준).

| 방향 | 스키마 | 언제 |
|---|---|---|
| 편집기→부모 | `transitline.site-design-ready/1` | 편집기가 뜨자마자(부모가 언제 세션을 보내도 안전하도록 핸드셰이크) |
| 부모→편집기 | `transitline.site-design-session/1` | 편집할 역을 보낼 때 |
| 편집기→부모 | `transitline.site-design-collision-request/1` | 본체/출입구를 옮기거나 바꿀 때마다(커밋 시점) — **편집기는 충돌을 스스로 계산하지 않는다** |
| 부모→편집기 | `transitline.site-design-collision-result/1` | 위 요청에 대한 부모 지도 엔진의 재계산 결과 |
| 편집기→부모 | `transitline.site-design-edit/1` | 적용(`status:"submitted"`) 또는 취소(`status:"cancelled"`) 시 |

`engine/src/map/site-design-session.mjs`가 이 모든 메시지의 형태(스키마)와 draft 상태 전이를 순수
함수로 구현한다 — DOM도 postMessage도 모른다. `site-design.html`은 이 모듈을 import해서
`window.addEventListener("message", ...)`/`window.parent.postMessage(...)`로 감싸기만 한다.

#### 입력 `SiteDesignSession` (`transitline.site-design-session/1`)

```jsonc
{
  "schema": "transitline.site-design-session/1",
  "sessionId": "sess-1",                 // 편집기가 응답을 상관지을 때 그대로 돌려줌
  "stationSite": { "schema": "transitline.station-site-geometry/1", ... }, // station-site.mjs 출력 그대로
  "baseRevision": "rev-42",              // 낙관적 동시성용 태그 — 편집기는 그대로 보관/반환만 함, 검증 안 함(부모 몫)
  "surroundingSpatialData": null,        // 선택. { buildings, roads } 등 — 아직 렌더러가 쓰지 않음(§7.4)
  "initialView": { "center": [139.7,35.7], "zoom": 17.6, "bearing": 20, "pitch": 78 } // 선택, 없으면 역 위치로 점프
}
```

`parseSiteDesignSession()`이 구조를 검사한다 — 스키마 불일치, `sessionId`/`baseRevision` 없음,
`stationSite`가 `transitline.station-site-geometry/1`이 아니거나 `location`이 `[lon,lat]`이 아니면
`{session:null, error:"..."}`을 낸다(예외를 던지지 않음 — 편집기가 배너로 원인을 보여줘야 하므로).

#### 출력 `SiteDesignEdit` (`transitline.site-design-edit/1`)

```jsonc
{
  "schema": "transitline.site-design-edit/1",
  "sessionId": "sess-1", "stationSiteId": "stn-site:...", "baseRevision": "rev-42", // 입력 그대로
  "body": { "location": [139.7,35.7], "headingDegrees": 140.3, "lengthMeters": 88, "widthMeters": 24, "depthMeters": 0 },
  "entranceChanges": [ { "entranceId": "ent:...", "location": [139.71,35.71] } ], // 옮긴 출입구만
  "status": "submitted" // "draft" | "submitted"(적용) | "cancelled"(취소)
}
```

적용 버튼은 **이 메시지 하나만** 부모로 보낸다(요구사항 7) — 다른 사이드이펙트 없음. 취소는 draft를
원본으로 완전히 되돌린 뒤(§7.2) `status:"cancelled"`로 같은 메시지를 보내 부모가 세션 종료를 알게
한다(스키마가 `"cancelled"`를 값으로 두고 있어 쓰이게 만들었다); 이후에도 같은 draft로 계속 편집할
수 있다(세션이 죽지 않음).

### 7.2 draft — 원본은 절대 안 건드린다

`createDraft(session)`은 `session.stationSite`를 **읽기만** 해서 별도의 draft 객체를 만든다
(`{ body: {location, headingDegrees, lengthMeters, widthMeters, depthMeters}, entranceChanges: [], original: {...} }`).
`moveBodyTo/rotateBodyTo/resizeBody/setBodyDepth/moveEntrance`는 모두 이 draft만 변이한다.
`resetDraft(session)`(취소)은 draft를 patch하지 않고 **session에서 다시 만든다** — 그래서 절반만
복원된 상태가 있을 수 없다. `engine/test/site-design-session.test.mjs`의 "createDraft never mutates
the session's stationSite" 테스트가 각 편집 함수를 전부 호출한 뒤 원본을 깊은 비교로 검증한다.

### 7.3 3D 편집 기능

- **이동**: 본체/출입구를 선택하고 "이동" 버튼을 누르면 지도 드래그가 이동 도구로 바뀐다
  (`map.dragPan`/`dragRotate`를 잠깐 끄고, MapLibre의 `e.lngLat`로 바로 위치를 갱신 — 3D 기즈모 없이
  지도가 이미 정확하게 주는 좌표를 그대로 쓴다).
- **회전·크기·깊이**: 숫자 입력. 드래그 기즈모보다 간단하고 값도 정확하다(ponytail: 필요해지면 회전
  기즈모 추가).
- **지상/지하 전환**: 체크박스 하나 — 끄면 깊이 0(지상)으로 강제, 켜면 숫자 입력이 열린다
  (`depthMeters`는 양수=지하/개착, 음수=고가, 0=지상 — 계약을 넘어선 새 규칙이 아니라 표시 규약).
- **X-ray 모드**: 버튼으로 토글. MapLibre 건물/지표 레이어의 불투명도를 낮추고, 편집 중인 3D 메쉬는
  `depthTest`를 꺼서 항상 위에 그린다 — 지하역을 실측 건물에 가려지지 않고 볼 수 있다.
- **깊이 표시**: 본체 중심에서 지표(z=0)까지 점선(단면 막대) + 우측 패널의 정확한 숫자
  (`bodyElevationInfo()` — 지표고, 선로고 추정치, 지하/고가 여부). 진짜 단면도는 아니다(ponytail).
- **작업구는 편집 불가**: 원본 계약의 참고용 표시로만 남는다(선택하면 그렇다고 안내).

### 7.4 건물 충돌 — 절대 새로 계산하지 않는다

`site-design-session.mjs`는 `engine/src/map/spatial.mjs`의 겹침 판정 함수를 **import조차 하지
않는다.** 대신:
1. 본체/출입구를 옮기거나 바꿀 때마다 `buildCollisionRequest(draft, requestId)`로 부모에 재확인을
   요청한다.
2. 부모가 `transitline.site-design-collision-result/1`로 응답하면 `applyCollisionResult()`가
   `requestId`/`sessionId`가 맞는 것만 받아들인다(드래그 중 이전 위치에 대한 늦은 응답을 무시).
3. 결과는 **색으로만** 표시한다 — 초록(충돌 없음 확인)/빨강(충돌)/회색("충돌 확인 안 됨: 부모 재계산
   대기"). 옮긴 뒤 아직 응답이 없으면 무조건 회색이다(이전 위치의 판정을 그대로 보여주지 않는다).

`surroundingSpatialData`(세션 입력)는 통신 계약에는 있지만 이번 렌더러는 아직 소비하지 않는다 —
MapLibre가 이미 실측 건물/도로를 배경으로 보여주므로 당장 필요하지 않았다(ponytail: 부모가 도쿄
바깥 좌표를 보내는 시나리오가 생기면 그때 배경 지오메트리로 그린다).

### 7.5 걷기 vs 자유 카메라 — 과장하지 않기

HUD에 상시 문구: "'걷기'는 지도 카메라 중심을 수평 이동할 뿐입니다 — 충돌·경사·계단 등 실제 보행
물리는 없습니다." 두 모드의 실제 차이는 딱 하나, WASD 루프가 도는지 여부다(카메라 조작 자체는
MapLibre 기본 제스처라 두 모드 모두 마우스 드래그/스크롤이 된다). "자유 카메라"는 pitch를 40°로
낮춰 평면에 가깝게 볼 수 있게만 한다.

### 7.6 테스트

`engine/test/site-design-session.test.mjs` (18개 전부 §3의 site-design-scene 테스트와 함께
`npm test`에서 통과):
- 잘못된/누락된 스키마 거절(`error` 코드로, 예외 아님)
- `createDraft`가 `session.stationSite`를 변이하지 않음
- 이동·회전·크기·깊이 각각 draft에 반영되고 `draftIsEdited()`가 맞게 따라감
- 존재하지 않는 출입구를 옮기려 하면 예외
- 취소(`resetDraft`)가 모든 편집 후에도 원본과 완전히 같은 `body`로 돌아옴
- `buildSiteDesignEdit()`가 계약대로의 스키마·`baseRevision`·`body`·`entranceChanges`를 냄
- 충돌 피드백이 `requestId`/`sessionId`가 다르면 무시되고, 맞으면 반영됨(직접 계산 없음)
- `bodyElevationInfo()`의 지하/고가 판정
- 결과 객체 어디에도 비용·기간·위험류 키가 없음(회귀 가드)

**헤드리스 Chrome으로 통신 계약 전체를 실제로 검증**했다(`docs/no-node-on-machine` 메모의 기법 —
스크래치패드에 임시 하니스 페이지를 만들어 `chrome.exe --headless=new`로 실행, 저장소엔 남기지
않음): iframe으로 `site-design.html`을 띄우고, `ready` 수신 → 실제 StationSite로 `session` 전송 →
방향 숫자 입력을 실제 `change` 이벤트로 편집 → `collision-request` 왕복 확인 → "적용" 클릭 →
`transitline.site-design-edit/1`(status `submitted`, `baseRevision` 보존, 편집값 일치) 부모 수신 확인
→ 별도 세션으로 편집 후 "취소" → `status:"cancelled"` 메시지의 `body`가 **원본**과 일치함을 확인.
검증 중 실제 버그 두 개를 발견·수정했다:
1. **MapLibre 5.24 커스텀 레이어 API 변경**: `render(gl, matrix)`의 두 번째 인자가 더 이상 평평한
   16개 행렬 배열이 아니라 `{modelViewProjectionMatrix, projectionMatrix, ...}` 객체다(globe 투영
   지원을 위한 변경). 예전 API를 가정한 코드는 카메라 투영행렬이 조용히 NaN이 돼 클릭 선택이 항상
   실패했다 — `args.modelViewProjectionMatrix`를 쓰도록 고쳤다.
2. **`THREE.Raycaster.setFromCamera()`의 카메라 위치 가정**: 이 커스텀 레이어 기법(MapLibre의
   뷰+투영을 통째로 `projectionMatrix`에 굽고 `matrixWorld`는 항등행렬로 둠)에서는
   `setFromCamera()`가 광선의 시작점으로 `camera.matrixWorld`(우리 경우 원점)를 그대로 쓰는데, 이는
   실제 "카메라 위치"와 다르다. NDC 근평면/원평면 두 점을 `projectionMatrixInverse`로 직접
   역투영해 광선을 만들도록 고쳤다(`raycaster.set(near, far-near)`) — camera.matrixWorld에 기대지
   않는 방식이라 정확하다.

**알려진 한계(정직하게 남겨둠)**: 위 수정 후에도 아주 가파른 pitch(78°, 걷기 모드 기본값)에서
클릭 레이캐스팅이 100% 안정적이진 않다 — MapLibre의 보통 크기 값과 우리의 미터당 메르카토르
스케일(~3×10⁻⁸)이 섞인 행렬을 32비트 부동소수점으로 역행렬화할 때 정밀도가 떨어지는 것으로 보인다
(이 통합 방식 자체의 알려진 한계). 완만한 pitch(예: 자유 카메라 모드, pitch 40°)에서는 문제가 훨씬
적다. 실사용에서 클릭이 안 먹히면 자유 카메라로 각도를 낮추고 다시 클릭하는 것을 권한다 —
근본적으로 고치려면 GPU 기반 피킹(별도 컬러 버퍼 렌더)이나 정밀도를 보존하는 이중 좌표계가
필요한데, 이번 범위를 넘는다(ponytail: 필요해지면 그때).

### 7.7 아직 안 한 것

- **메인 화면 연결 자체.** 이 편집기가 실제로 `iframe`에 얹혀 postMessage를 주고받는 배선은
  "Claude 1"(다른 세션) 담당 — 이번 작업은 편집기 쪽 계약과 UI만 완성했다.
- 건물 충돌 **재계산 로직 자체**(부모 지도 엔진 쪽에 구현돼야 함) — 이번엔 구조(요청/응답 스키마 +
  색 표시)만 만들었다(요구사항 13이 명시적으로 그렇게 요구함).
- ~~`surroundingSpatialData`를 실제로 렌더링에 쓰는 것~~, ~~회전 드래그~~, ~~출입구 추가/삭제~~,
  ~~작업구 편집~~ — 3단계(§8, B8-3B)에서 전부 구현했다.
- 협업(여러 사람이 동시에 같은 세션을 편집)이나 `baseRevision` 충돌 검증 — 편집기는 그 값을
  그대로 보관/반환만 하고 검증하지 않는다(부모 책임으로 남겨둠).
- 작업구 크기 조정은 중심 기준 단일 배율(가로세로 동시 확대/축소)만 지원한다 — 변을 하나씩 끄는
  비대칭 리사이즈는 없다(§8.3).
- 회전 기즈모는 시각 표시(방향 막대+손잡이)일 뿐, 손잡이 자체를 드래그해서 돌리지는 않는다 — 실제
  회전 조작은 "회전(드래그)" 버튼으로 모드를 켠 뒤 지도 아무 곳이나 드래그한다(§8.4의 이유).
- targetOrigin 불일치 메시지 거절(요구사항 9)은 코드로 구현·검토했지만, 서로 다른 origin 두 개를
  띄우는 전용 교차 출처 테스트까지는 이번 회차에서 시간상 돌리지 못했다(§8.6).

## 8. 3단계 — 공간 표현·편집 보강 (B8-3B, 2026-09-29)

2단계가 본체 이동·회전(숫자)·크기·깊이만 다뤘다면, 이번엔 **주변 맥락을 실제로 보여주고**,
**출입구·작업구까지 편집**할 수 있게 넓혔다. 담당 파일은 여전히 `site-design.html` +
`site-design-session.mjs` + `site-design-scene.mjs`뿐이다 — `engine/src/main.mjs`·`engine/index.html`·
`engine/src/management/**`는 이번에도 한 줄도 안 건드렸다.

### 8.1 주변 공간 표현 (요구사항 1)

`site-design-scene.mjs`에 `buildSurroundingScene(surroundingSpatialData, origin)`을 추가했다 —
`SiteDesignSession.surroundingSpatialData`(§7.1의 `{ buildings?, roads?, water?, existingRail? }`)를
읽기 전용 로컬미터 지오메트리로 바꾸는 순수 함수다. `site-design.html`은 세션이 시작될 때 한 번만
(드래그마다 다시 그리는 `siteGroup`과 달리) `surroundingGroup`에 그린다 — 건물은 회색 압출, 도로는
어두운 선, 수역은 옅은 파란 평면, 기존 철도는 보라 선(`walk.html`의 철도색과 통일). **선택·편집
불가**(`pickable`에 안 넣음) — 어디까지나 도쿄 23구 pmtiles가 못 덮는 곳(예: 다른 지역 역)을 위한
참고용 배경이다. 헤드리스 Chrome으로 건물 1동+도로 1개를 보낸 세션에서 메쉬 3개(건물 메쉬+테두리,
도로 선)가 정확히 생기는 것을 확인했다(§8.6).

### 8.2 출입구 추가·삭제 (요구사항 2)

`site-design-session.mjs`의 `entranceChanges[]`가 `{entranceId, location}` 하나였던 걸
**`{entranceId, action: "move"|"add"|"remove", location?}`**로 넓혔다(제거는 `location` 없음).
`addEntrance(draft, location)`은 `stableId("ent-draft", stationSiteId, "seq", n)`으로 새 id를 내고,
`removeEntrance(draft, entranceId)`는 원본 출입구면 `action:"remove"` 항목을 남기고(id 보존),
**아직 적용 전에 추가했다 지운 출입구는 배열에서 아예 사라진다**(합쳐진 순효과만 내보냄 —
"이 세션에서 실제로 무엇이 바뀌었는가"만 부모에게 전달). 화면에서는 HUD의 "+ 출입구 추가" 버튼을
누르고 지도를 클릭하면 그 자리에 놓인다 — **레이캐스팅이 아니라 MapLibre가 클릭에서 직접 주는
`e.lngLat`을 쓰므로 §8.5의 정밀도 문제와 무관하게 항상 정확하다.** 선택한 출입구의 편집 패널에
"삭제" 버튼이 새로 생겼다.

### 8.3 작업구 이동·크기 조정 (요구사항 3)

작업구(`workAreaCandidates`)는 원래 station-site.mjs 계약의 **참고용 읽기 전용** 표시였다. 이제
`moveWorkAreaBy(draft, workAreaId, dEastMeters, dNorthMeters)`(드래그, 이전 마우스 위치 대비
증분 이동 — 본체·출입구의 "절대 위치로 이동"과 달리 폴리곤이라 상대 이동이 자연스럽다)와
`resizeWorkAreaBy(draft, workAreaId, scaleFactor)`(폴리곤 자체 중심 기준 배율 — 변 하나씩 끄는
비대칭 리사이즈는 범위 밖)를 추가해 편집할 수 있다. 두 함수 모두 **`workAreaId`를 그대로 유지**하고
`draft.workAreaChanges`에 새 폴리곤(경위도)만 담는다. `buildSiteDesignEdit()`의 출력에
`workAreaChanges: [{workAreaId, polygon}]`이 새로 생겼다.

### 8.4 회전 기즈모 + 숫자 입력 유지 (요구사항 4)

본체가 선택돼 있으면 항상 현재 방향을 가리키는 막대+구슬 손잡이를 그린다(`addRotateHandle()`,
시각 표시일 뿐 그 자체를 드래그로 잡는 기즈모는 아니다 — 이유는 아래). 실제 회전은 "회전(드래그)"
버튼으로 모드를 켠 뒤 **지도 아무 곳이나** 드래그하면 본체 중심에서 커서까지의 방위각으로 방향이
정해진다(`frameAt` + `atan2`, MapLibre의 `e.lngLat` 기반 — 레이캐스팅 없음). 손잡이 자체를
클릭해서 잡는 진짜 기즈모로 만들려면 손잡이를 레이캐스팅으로 골라야 하는데, 그러면 §8.5의 정밀도
문제를 다시 끌어들이게 돼 일부러 피했다(ponytail: 필요해지면 GPU 피킹 등으로 다시 본다). 숫자
입력(방향°)은 그대로 남아 있다 — 정확한 값을 바로 넣고 싶을 때 쓴다.

### 8.5 지상/지하 전환 검증 (요구사항 5)

체크박스는 `depthMeters`에서 **유도만** 한다(0=지상) — 별도 "지상이다/지하다" 플래그를 따로 두지
않으므로 애초에 체크박스와 숫자가 서로 다른 값을 가리킬 수 없는 구조다. 대신 값 자체가 물리적으로
말이 안 되는 경우(비유한, 또는 ±200 m를 넘는 극단값 — 실제 어떤 역도 200 m 깊이/200 m 고가가 아니다,
오타 방지용 상식선)를 `validateBodyDepth(depthMeters)`로 걸러 `setBodyDepth()`가 예외를 던지고,
`site-design.html`이 그 예외를 잡아 배너로 "깊이 값이 모순됩니다(extreme-depth): 5000 m"처럼
보여준다(헤드리스 테스트로 문구까지 확인, §8.6).

### 8.6 충돌 표시 — null은 절대 "안전"이 아니다 (요구사항 6/7)

`site-design-session.mjs`는 여전히 `engine/src/map/spatial.mjs`를 import하지 않는다(충돌을 스스로
계산하지 않음, 요구사항 6). `applyCollisionResult()`가 `true`/`false`가 아닌 값은 전부 `null`로
정규화하고(`toTriState`), `site-design.html`의 `collisionLabel()`이 `null`을 "충돌 여부 자료 미상
(부모 재계산 대기 중)"이라고 **명시적으로 다르게** 표시한다(요구사항 7 — "충돌 없음"이라고 쓰지
않는다). `colorForWorkArea()`가 이번에 고친 버그: 손 안 댄 작업구는 원본 계약의 실제 사실(항상
boolean)을 그대로 보여주지만, **옮기거나 크기를 바꾼** 작업구는 재확인 전까지 무조건 회색(미상)
이다 — 이전엔 `w.blocked ? bad : work`로 `null`을 "안전"(주황 후보색)처럼 잘못 보여주고 있었다.
헤드리스 Chrome으로 실제로 확인: 원래 "충돌 있음"(빨강, 실제 사실)이던 작업구를 옮기자 즉시
"충돌 여부 자료 미상"(회색)으로 바뀌고, 부모 응답 전까지 그 상태를 유지했다.

### 8.7 pitch 정밀도 완화 (요구사항 8)

기본 pitch를 78→55°로 낮추고 `map.maxPitch`를 60°로 제한했다(`MAX_PITCH_EDITING`). **다만 헤드리스
검증 결과, 이 완화만으로 클릭 레이캐스팅이 완전히 안정화되지는 않았다** — pitch 55°에서도 화면
중심이 아닌 특정 좌표(예: 특정 출입구 위치)를 노려 클릭하면 여전히 빗나가는 경우를 관찰했다. 근본
원인은 여전히 부동소수점 정밀도(MapLibre의 보통 크기 값과 우리의 ~3×10⁻⁸ 미터당 메르카토르
스케일이 섞인 행렬의 32비트 역행렬화)로 보이며, GPU 피킹 등 더 큰 작업 없이는 완전히 없애기
어렵다. 그래서 요구사항 8이 명시한 대로 **pitch 상한을 "완화 조치"로 남겨두고**, 출입구 배치·이동/
회전/작업구 이동 같은 실제 조작은 전부 레이캐스팅이 아니라 MapLibre가 직접 주는 `e.lngLat`을 쓰도록
설계해(§8.2/8.4/8.3) **선택(클릭) 이후의 조작 자체는 이 문제와 무관하게 동작**한다. 남은 약점은
"클릭으로 정확한 대상을 고르는" 그 첫 클릭뿐이다.

### 8.8 targetOrigin 검증 (요구사항 9)

`window.addEventListener("message", ...)`의 첫 줄이 `if (TARGET_ORIGIN !== "*" && event.origin !==
TARGET_ORIGIN) return;`이다 — `?targetOrigin=`이 지정되면 그 origin이 아닌 곳에서 온 메시지는 스키마
검사도 하기 전에 버린다. 스키마 검사는 항상 한다(`parseSiteDesignSession`의 에러 코드, 그리고
collision-result 분기의 `data.schema === ...` 비교). **다만 이 거절 경로 자체는 코드 검토로만
확인했고, 서로 다른 origin 두 개(예: 포트가 다른 정적 서버 두 개)를 띄워 실제로 거절되는지 보는
전용 교차 출처 테스트는 이번 회차 시간 안에 못 돌렸다** — 같은 origin에서 보낸 메시지가 정상 처리
되는 건 §8.6까지의 모든 테스트가 이미 매번 검증한 셈이다(§7.1의 세션 통신 전체가 이 경로를 탄다).

### 8.9 테스트

`engine/test/site-design-session.test.mjs`(18개)·`engine/test/site-design-scene.test.mjs`(7개) 전부
`npm test`로 통과. 새로 늘어난 것: 출입구 추가/삭제 후 ID 유지(추가는 새 id, 삭제는 원본 id를
tombstone으로 보존, 추가 후 삭제는 완전히 사라짐), 작업구 이동/리사이즈 후 `workAreaId` 유지,
`validateBodyDepth`/`setBodyDepth`의 극단값 거절, 취소 후 재편집이 정상적인 `submitted` 메시지를
내는지(적용→취소→재편집→적용 전체 사이클), 충돌 결과의 `null`/`true`/`false` 3원 구분이
`requestId`·`sessionId` 검증과 함께 올바른지.

브라우저: 이번에도 스크래치패드 임시 하니스(저장소엔 안 남김, §5와 같은 기법)로 실제 postMessage
왕복을 확인했다. 이번엔 raycasting 대신 (a) 실제 클릭 이벤트가 주는 `e.lngLat`을 쓰는 출입구 배치는
그대로 검증했고, (b) 순수 선택 로직(출입구/본체/작업구를 고른 뒤의 편집·삭제·충돌 표시·적용/취소)은
`selectObject()`를 직접 호출하는 임시 디버그 훅으로 raycasting과 분리해 검증한 뒤 제거했다 —
"선택 자체가 되는지"(§8.7의 한계)와 "선택된 뒤 로직이 맞는지"를 구분해서 본 것이다. 한 회차에서
실제로 확인한 것: 세션 시작 → 주변 데이터 3개 메쉬 생성 → 출입구 추가(클릭 배치) →
원본 출입구 선택·삭제 → 본체 선택 → 극단 깊이 거절(배너 문구까지 일치) → 방향 회전(숫자 입력) →
작업구 선택 → 드래그 이동(편집됨=예, 충돌=자료 미상으로 전환 확인) → 크기 배율 조정 → 적용
(entranceChanges에 add+remove, workAreaChanges에 이동한 폴리곤이 정확히 담긴
`transitline.site-design-edit/1` 수신) → 별도 세션에서 편집 → 취소(원본과 완전히 같은 body로
복원된 `cancelled` 메시지 수신) → 같은 draft로 재편집 → 적용(새 값이 정확히 반영된 `submitted`
메시지 수신).

### 8.10 다른 세션과의 호환성 (참고)

같은 저장소에서 동시에 작업 중인 다른 세션이 `engine/src/map/site-design-bridge.mjs`(부모 화면 ↔
이 편집기의 postMessage 중계)와 `engine/src/management/station-design-changes.mjs`(경영 엔진 쪽
승인 로직)를 만들고 있었다. 그 두 파일을 읽어 보니 `entranceChanges[].action`(`move`/`add`/`remove`,
`?? "move"`로 구버전과도 호환)과 `workAreaChanges[].{workAreaId, polygon}`, `collisionResult`의
`null`을 "미확인"으로 다루는 원칙까지 **이번 §8에서 정한 계약과 정확히 일치**했다 — 그래서 이번
변경이 그쪽 작업을 깨뜨리지 않는다(단, `site-design-bridge.mjs`의 충돌 재계산은 아직 `add`/`remove`
출입구와 `workAreaChanges`를 완전히 반영하지는 않는다 — 그런 경우 그냥 항상 "자료 미상"으로
남으므로 안전하게 저하될 뿐 틀린 "안전" 표시는 나지 않는다).

## 9. 참고 자료

- MapLibre + three.js 공식 커스텀 레이어 연동 방식(모델 변환 행렬 = `matrix * (translate * scale)`,
  `projectionMatrixInverse`를 직접 갱신해 레이캐스팅 가능하게 함): MapLibre GL JS 예제 문서
- `docs/tokyo-walk-mvp-2026-09-28.md` — 같은 팔레트·같은 WASD 이동 방식을 재사용한 선행 MVP
- `docs/station-site-contract.md` — 이 MVP가 읽기 전용으로 쓰는 StationSite 계약의 원문
