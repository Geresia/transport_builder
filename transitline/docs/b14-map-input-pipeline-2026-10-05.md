# B14 지도 입력 파이프라인 — Codex 연결 안내 (2026-10-05)

철도용량 설계(M5) → 장애 위치(M6) → 관제 후보 선택(M7) → 타사선 우회(M10)를 지도에서 만드는 네 편집기를
`mountMapInputPipeline` 하나로 묶었다. **지도 쪽 작업만** 들어 있다. 비용·시간·운행 가능 여부·승인·협정·확률은
계산하지도 정하지도 않으며, 모르는 값은 null(unknown 사유 동반)로 남긴다. 이 문서는 `main.mjs`와 저장 쪽을 맡을 Codex를 위한 것이다.

- 브랜치: `b14-map-input-pipeline` (기준 42c13da). push·병합은 하지 않았다.
- 건드리지 않은 파일: `main.mjs`, `index.html`, `style.css`, `scenario-runtime.mjs`, `engine/src/management/**`.
- 기존 M5/M6/M7/M10 계약은 바꾸지 않았다.

| 단계 | 커밋 | 파일 |
|---|---|---|
| 공용 마운트 도구 + M5 마운트 | 6de8a45 | `map-mount-kit.mjs`, `rail-capacity-ui.mjs`, `rail-capacity-ui-tools.mjs` |
| M6 마운트 | 7c3e53b | `railway-disruption-site-ui.mjs` |
| M7 마운트 | 50b4502 | `railway-service-control-ui.mjs` |
| 조립 + 이 문서 | 이 커밋 | `map-input-pipeline.mjs` |

## 1. 데이터가 흐르는 순서

```
host getPlans / getRoutes / getExternalNetworks / getStationSites
        │
   [M5 railCapacity]  ──railGeometries──▶ [M6 disruptionSite] ◀── host getDisruptionEvents (엔진 장애 이벤트)
        │                                       │ sites                ▲
        │                                       ▼                      │ host getRailCapacityApplication (엔진이 만듦)
        └──railGeometries──────────────▶ [M7 serviceControl]
        │                                       │ controls
        └──railGeometries + sites + controls──▶ [M10 detour] ◀── host getExternalCatalog
```

앞 단계의 결과는 조립 모듈 안에서 뒤 단계의 getter로 자동 연결된다. 한 단계가 바뀌면 뒤 단계가 즉시 갱신되고,
호스트의 `onChange`는 **한 번의 변화 묶음당 한 번**만 불린다(`canvas`에 `transitline:map-input-pipeline` CustomEvent도 같이 발생).

## 2. `main.mjs` 마운트 예시

```js
import { mountMapInputPipeline } from "./src/map/map-input-pipeline.mjs";

const pipeline = mountMapInputPipeline({
  canvas, projection, pack,
  getPlans: () => mapExport.plans,                       // buildMapExport 결과의 plans (계획선)
  getRoutes: () => throughRoutes,                        // 직통 경로 목록(없으면 [])
  getExternalNetworks: () => mapExport.externalNetworks, // 기존선 네트워크
  getExternalCatalog: () => externalCatalog,             // 없으면 null
  getStationSites: () => stationSites,                   // 없으면 []
  getSpatial: () => spatial,                             // 없으면 생략 가능
  getRailCapacityApplication: () => state.railCapacityApplications ?? [],  // §4 참고 — 엔진 쪽 책임
  getDisruptionEvents: () => state.railwayDisruptions?.events ?? [],       // 엔진 장애 이벤트 그대로
  onChange: (out) => { latestMapInputs = out; },         // §3의 출력
});
```

- 모든 getter는 목록·단일 객체·`{plans:[…]}` 형태 어느 쪽이든 받고, `undefined`/`null`이면 빈 입력으로 본다.
- `autoRefreshMs`(기본 250)마다 getter를 다시 읽어 입력 변화를 따라간다. 테스트에서는 0.
- 입력은 읽기만 하고 절대 고치지 않는다(얼려 둔 입력으로 테스트함).
- `pipeline.stages.{railCapacity,disruptionSite,serviceControl,detour}`로 각 편집기의 API(`createDesign`, `startSite`, `startControl`, `pick`, `choose` …)에 그대로 접근한다.
- `setEnabled(bool)`은 네 패널과 오버레이를 함께 숨기거나 보인다. `destroy()`는 모두 제거한다.
- 패널은 왼쪽(철도 설계 위·장애 위치 아래), 오른쪽(관제 후보 위·우회 아래)에 쌓도록 조립 모듈이 배치용 `<style>` 하나를 더 넣는다.

## 3. `pipeline.output()` / `onChange(out)`

| 필드 | 내용 |
|---|---|
| `railGeometry` | RailCapacityGeometry export(`schema, packId, packVersion, designs, warnings`) |
| `railGeometries` | 위 export의 설계 목록(M6·M7·M10 입력. `railGeometry.designs`와 같은 설계) |
| `applications` | `{supplied, needed, missing}` — §4 |
| `disruptionSites` | RailwayDisruptionSiteGeometry export(`sites, inactive, warnings`) |
| `serviceControls` | RailwayServiceControlGeometry export(`controls, inactive, warnings`) |
| `detour` | RailwayDetourServiceGeometry export(`detours, inactive, warnings`) |
| `documents` | 네 편집기의 문서(§5) — 저장 대상 |
| `selected` | 화면에서 지금 고른 것: 설계 키, 장애 eventId, 관제 eventId, 우회 계획 |
| `warnings` | 모든 단계의 경고를 `stage`("railCapacity" / "disruptionSite" / "serviceControl" / "detour" / "pipeline")를 붙여 합친 것 |

- 플레이어의 후보 선택(회차·부분운휴·우회·대피)은 `documents.serviceControl.controls[].selected`에 **후보 id와 그 후보가 속한 관제 기하의 revision**으로 남는다. 경영 판단이 아니라 공간상 선택 기록이다.
- 우회 계획은 `documents.detour.plans`, 그 기하는 `detour.detours`.
- 어느 단계든 모르면 null이고 `unknown`/`unknownReasons`가 따라온다. 지도가 값을 메워 넣지 않는다.

## 4. applications 입력 슬롯 (엔진 책임)

M6·M7은 엔진의 `trackSegmentId`를 지도의 구간(section)에 이어 줄 **rail-capacity-application**이 있어야 장애 위치와
영향 구간을 정한다. 이것은 엔진(`rail-capacity-integration` 쪽)이 만들어야 하므로 조립 모듈은 호스트가 준 것을 그대로 넘기기만 한다.

```js
// getRailCapacityApplication이 돌려줄 한 항목의 모양
{ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1",
  railGeometryId, railGeometryRevision,
  sections: [{ trackSegmentId: "track-segment:3", railCapacitySectionId }] }
```

- `output().applications.needed` — 지금 지도에 있는 철도 기하 각각의 `{railGeometryId, railGeometryRevision, sectionIds}`. 엔진이 application을 만들 때 이 목록을 보면 된다.
- `applications.supplied` — 호스트가 준 application 그대로.
- `applications.missing` — application이 없거나 **다른 revision**용이라 맞지 않는 `railGeometryId` 목록. 비어 있어야 정상.
- application이 없으면 M6는 장애를 만들되 `railCapacitySectionId`, `affectedSectionIds`를 null(`no-section-link`)로 둔다. 구간 중앙으로 가정하지 않는다.
- 지도 설계가 바뀌면 `railGeometryRevision`이 바뀌므로 application도 다시 만들어야 한다(안 맞으면 `missing`에 나타난다).

## 5. 문서 저장·복원

네 편집기는 각자 `serialize()`(JSON 문자열)와 `loadDoc(문자열 또는 객체)`를 가진다. 조립 모듈은 이 넷을 한 봉투로 묶는다.

```js
const text = pipeline.serialize();          // 통합 저장 문자열(결정적: 같은 입력 → 같은 바이트)
const notes = pipeline.loadDoc(text);       // 복원 → 경고 배열(단계 표시 포함). 빈 배열이면 문제 없음
```

봉투 필드:

```json
{ "schema": "transitline.map-input-pipeline-doc/1", "version": 1, "packId": "tokyo", "packVersion": "…",
  "stages": {
    "railCapacity":   { "version": 1, "packId": "…", "packVersion": "…", "designs": [ … ] },
    "disruptionSite": { "version": 1, "packId": "…", "packVersion": "…", "sites":   [ … ] },
    "serviceControl": { "version": 1, "packId": "…", "packVersion": "…", "controls":[ … ] },
    "detour":         { "version": 1, "packId": "…", "packVersion": "…", "plans":   [ … ] } } }
```

| 단계 | 문서 필드 | 개별 localStorage 키 |
|---|---|---|
| railCapacity | `designs` | `transitline.rail-capacity.v1:<packId>` |
| disruptionSite | `sites` | `transitline.railway-disruption.v1:<packId>` |
| serviceControl | `controls` | `transitline.railway-service-control.v1:<packId>` |
| detour | `plans` | `transitline.railway-detour.v1:<packId>` |

복원 규칙:
- 읽을 수 없음 / 스키마가 다름 / 봉투 `version`이 다름 / **다른 팩의 봉투**는 통째로 거부하고 어느 단계도 건드리지 않는다. 경고 코드는 `map-input-pipeline-doc-unreadable|-version|-other-pack`(`stage: "pipeline"`).
- 팩 버전만 다르면 `pack-version-mismatch`를 알리되 문서는 불러온다.
- 봉투 안의 한 단계 문서가 거부되면(예: 그 단계 문서만 다른 팩 것) 그 단계만 그대로 두고 나머지는 불러온다. 경고에 `stage`가 붙는다.
- 봉투에 없는 단계는 현재 상태를 유지한다.
- 설계가 바뀌어 저장해 둔 선택이 낡았으면(`…-selection-outdated` / `…-selection-stale`, 장애 위치의 설계 revision 불일치 등) 경고만 나오고 값은 지워지지 않는다. 패널의 "다시 확인" 버튼으로 플레이어가 확정한다.
- 각 단계 `loadDoc`은 자기 localStorage 키도 갱신한다. **통합 저장을 쓰면** 시작할 때 `mount` → `loadDoc(저장본)` 순서로 부르면 개별 키보다 저장본이 이긴다. 개별 키만 쓰는 독립 모드도 그대로 동작한다.
- 저장소가 막혀 있어도(시크릿 창 등) 던지지 않고 메모리에서만 동작하며 `…-doc-not-saved` 경고를 낸다. `serialize()`는 항상 쓸 수 있다.

## 6. Codex가 이어서 할 일 (제안)

1. `main.mjs`에 §2처럼 마운트하고 `onChange`의 결과를 보관한다.
2. 저장 데이터에 `pipeline.serialize()` 문자열을 넣고, 불러올 때 마운트 직후 `pipeline.loadDoc()`을 부른다.
3. 엔진의 application 생성기가 `applications.needed`를 보고 `getRailCapacityApplication`을 채운다(§4).
4. 경영 쪽은 `serviceControls`·`detour` export와 `documents.serviceControl`/`documents.detour`의 선택 기록을 입력으로 받아 승인·협정·운행을 정한다. 지도에는 이 값을 되돌려 쓰지 않는다.

## 7. 한계

- 도로 폭은 플레이어가 입력한 접근점의 값만 쓰고, 입력한 차량 폭과의 비교만 한다. 입력이 없으면 null.
- 열차 단위 장애는 지도에 위치가 없어 후보가 null이다(`railway-disruption-train-has-no-position`).
- 부분운휴·우회 후보는 나열 상한이 있을 수 있고, 그때 `…-enumeration-limited` 플래그가 붙는다.
- 도쿄 실제 데이터로 만든 설계·장애·후보 선택은 이번에 검증하지 않았다. 합성 월드(단선·복선·분기·우회 3종)와 headless Chrome으로만 확인했다.
- 개별 마운트의 단독 사용은 그대로 가능하지만, 패널 배치는 조립 모듈이 넣는 `<style>`에 의존한다(단독 사용 시 각자 기본 위치).

## 8. 검증

- 단위 테스트: 조립 17개 + M5 17개 + M6 17개 + M7 15개. 전체 `npm test`·`npm run validate`·`git diff --check` 통과.
- headless Chrome(실제 포인터 클릭·새로고침): 설계 만들기 → 장애 위치 시작 → 관제 후보 선택(마커 클릭 포함) → 우회 계획 선택 →
  개별 localStorage 4개 키 저장 → 새로고침 후 문서 동일 → 통합 봉투 `loadDoc` 후 `serialize()`가 원문과 바이트 동일 →
  다른 팩 봉투 거부 후 상태 불변 → 콘솔 오류 없음. 네 패널이 겹치지 않음을 화면으로 확인했다.
