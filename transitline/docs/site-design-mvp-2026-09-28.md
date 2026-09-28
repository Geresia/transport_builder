# 3D 현장 설계 MVP (Three.js) — 기술 정리

- 기준일: 2026-09-28
- 파일: [`packs/tokyo/site-design.html`](../packs/tokyo/site-design.html) (독립 페이지),
  [`engine/src/map/site-design-scene.mjs`](../engine/src/map/site-design-scene.mjs) (순수 변환 모듈),
  [`engine/test/site-design-scene.test.mjs`](../engine/test/site-design-scene.test.mjs)
- 계기: [tokyo-walk-mvp-2026-09-28.md](tokyo-walk-mvp-2026-09-28.md)의 "걷는 지도"에 이어, 이번에는
  역의 **본체·승강장·출입구**를 실제 3D 구조물로 확인할 수 있는 현장 설계 뷰어가 필요해졌다.
  기존 워크 MVP(`walk.html`)는 건드리지 않고, 완전히 별도 파일 2개(렌더러 + 순수 변환 모듈)로 만들었다.

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
- 건물·출입구·작업구 **편집**(그리기/이동) 없음 — 순수 뷰어. 편집은 이미 `station-editor.mjs` +
  2D 캔버스(`station-view.mjs`)에 있고, 이 3D 뷰어는 그 위에 값을 얹지 않는다.
  일단 데모 데이터는 `packs/tokyo/station-examples/*.station.json`(8개 예제, 이미 존재)를 그대로 읽는다.
  살아있는 팩 편집 상태를 연결하려면 `buildStationExport()`의 출력을 그대로 넘기면 된다(스키마 동일).
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

## 6. 참고 자료

- MapLibre + three.js 공식 커스텀 레이어 연동 방식(모델 변환 행렬 = `matrix * (translate * scale)`,
  `projectionMatrixInverse`를 직접 갱신해 레이캐스팅 가능하게 함): MapLibre GL JS 예제 문서
- `docs/tokyo-walk-mvp-2026-09-28.md` — 같은 팔레트·같은 WASD 이동 방식을 재사용한 선행 MVP
- `docs/station-site-contract.md` — 이 MVP가 읽기 전용으로 쓰는 StationSite 계약의 원문
