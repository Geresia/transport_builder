# B12-6 M4 인수인계 (Claude → Codex)

Claude의 토큰이 소진되어 지도 쪽 M4를 여기서 넘긴다. 이 문서만 읽으면 이어서 할 수 있게 적는다.

## 1. 지금 상태

- 브랜치 `b12-6/m4-through-handover-site` (origin에 push됨). 기준 master `ce33a05`, 현재 origin/master `8f9611d`와 **병합 충돌 없음**(`git merge-tree` 확인).
- 이 브랜치가 하는 일: 계약 `transitline.through-handover-site-geometry/1` 구현. 파일은 `engine/src/map/through-handover-{site,editor,view,ui}.mjs`, 테스트 `engine/test/through-handover-site.test.mjs`(36개), 예제 12개(`packs/*/through-handover-examples/`), 생성 스크립트 `scripts/build-through-handover-examples.mjs`, 계약 문서 `docs/through-handover-site-contract.md`. 그 밖에 `package.json` 스크립트 한 줄과 `depot-site.mjs`의 `selfIntersects` export 한 단어만 바꿨다.
- 검증: `npm test` 739 / 통과 737 / 실패 0 / 건너뜀 2, `npm run validate` 3/3, `git diff --check` 깨끗. 브라우저(별도 하네스)에서 추가·스냅·경유점 드래그·분기기·작업구역·새로고침 복원·stale 확인·재확인까지 실제로 눌러 확인했다.
- `management/**`, `scenario-runtime.mjs`, `main.mjs`, `index.html` 등 Codex 소유 파일은 건드리지 않았다.
- 이 브랜치는 master에 **아직 병합되지 않았다**. 지금 master의 `through-handover-project.mjs`는 계약 이름만 보고 짠 상태다.

## 2. 먼저 읽을 것

1. `docs/through-handover-site-contract.md` — 필드 전체, `physicalConnectionEvidence`의 정확한 의미, 경영 엔진 읽기 대응표.
2. `docs/b12-6-through-handover-construction-2026-10-03.md` — 경영 쪽 사업 흐름. 마지막 절 "현재 한계와 다음 연결"이 이 인수인계와 같은 항목이다.

## 3. 해야 할 일 (우선순위 순)

### 3-1. 경영 읽기 코드의 이름 두 곳 고치기 (필수, 2줄)

`engine/src/management/through-handover-project.mjs`의 `normalizedFacts()`:

| 줄 | 지금 | 고칠 것 |
|---|---|---|
| 37 | `site.intersectedBuildingCount ?? ...` | `site.buildingIntersectionCount`를 읽는다 |
| 68 | `site.externalTopologyVerified === true ? ...` | `site.physicalConnectionEvidence?.connected`(true/false/null)를 읽는다 |

안 고치면 건물 수를 재 놓고도 "not-verified"로, 연결 증거는 항상 null로 처리된다. 나머지 필드명(`connectionLengthMeters`, `minimumCurveRadiusMeters`, `waterCrossingCount`, `roadCrossingCount`, `existingRailwayCrossingCount`, `maximumGradientPermille`, `selectedWorkAreaCandidateId`, `unknown`, `unknownReasons`, `dataQuality`)은 이미 맞다. 지도 쪽 이름이 정본이니 지도 쪽을 바꾸지 말 것.

의미가 걸린 부분:
- `connected`는 "그린 연락선이 양쪽 선로의 **알려진 선형**에 닿았는가"라는 공간 측정이다. true는 양쪽 선형이 있고 간극 1 m 이하. false는 어느 한쪽이 50 m 초과로 측정됨. null은 모름(외부선 선형 없음, 1~50 m 사이, 미작도, 설계 기준 경로가 바뀜 등). null을 false로 읽지 말 것.
- `maximumGradientPermille`은 플레이어가 지정한 설계 구배만 들어온다. 지반 경사(`averageSlopePercent`)를 구배로 바꾸지 말 것.
- `structureType`은 `at-grade/cut-cover/tunnel/viaduct/bridge` 5종만, 플레이어 지정이다. 비어 있으면 경영 쪽 기본값(`at-grade`)을 쓰되 "지정 안 함"을 보고에 남길 것.

### 3-2. 병합과 적합성 테스트

1. `b12-6/m4-through-handover-site`를 master에 병합한다(충돌 없음).
2. 경영 쪽에 계약 적합성 테스트를 추가한다: `packs/*/through-handover-examples/*.handover-site.json`을 읽어 `estimateThroughHandoverProject`에 넣고, `unknown[]`·`null`이 0으로 둔갑하지 않는지, stale 예제(`06-route-revision-stale`)가 입찰 불가로 처리되는지 확인한다. 예제의 `source` 필드는 입력 기록이니 읽기에서는 무시한다.
3. 병합 뒤 `docs/b12-6-through-handover-construction-2026-10-03.md`의 "유연하게 읽는다" 문구를 실제 이름 기준으로 고친다.

### 3-3. UI 연결

`through-handover-ui.mjs`의 `attachThroughHandoverEditor({ canvas, projection, pack, state, getRoutes, getMapExport, getSpatial, getExternalAlignments, panel, summary, legend, button })`를 `index.html`/`main.mjs`에서 부른다. 사용 방식은 `depot-ui.mjs`와 같다. 필요한 입력:
- `getRoutes()`: `ThroughRouteGeometry v1` 배열(직통 경로 계약).
- `getMapExport()`: `{ plans, externalNetworks }`.
- `getSpatial()`: 건물·수역·도로·DEM 레이어가 든 `makeSpatialContext(...)`. 없으면 해당 수치는 전부 null(미상)로 나온다.
- 렌더 루프에서 `drawThroughHandoverOverlay(ctx, state.throughHandoverView, screen)`를 부른다.
- 패널 CSS 클래스: `handover-row`, `handover-bar`, `handover-site`, `handover-fact`, `diag warning` 등(스타일은 `style.css`에 추가 필요).
- 편집기는 자기 문서만 `localStorage`(`transitline.through-handovers.v1:<packId>`)에 저장하고 경영 상태는 읽기만 한다. `rebindRoute`(경로 재확인)는 플레이어가 버튼을 눌러야만 호출된다.

### 3-3b. 외부선 실제 선형 공급 (선택)

`buildThroughHandoverExport({ ..., externalAlignments })`에 외부선의 실제 선형을 주면 외부 측 접속이 측정 가능해진다(`[{ externalNetworkId?, externalLineId, alignments: [[[lon,lat]...]...], quality, source: { name, license } }]`). 지금 팩의 `existing-network.json`에는 역 좌표뿐이라 외부 측은 항상 null이다. OSM/Wikidata에서 선형을 가져오는 일은 아직 안 했다.

### 3-4. B13-M5 지도 계약 (아직 지시문 없음, 문서에만 있음)

B13-1~4 문서가 "Claude의 B13-M5 지도 계약"을 기다린다. 요구가 흩어져 있어 모으면 다음과 같다.
- 폐색 경계: 한 물리 구간 안의 복수 블록(B13-3, 지금은 `trackSegment` 하나 = 블록 하나).
- 분기 후보와 전철기별 진로 조합(B13-4, 지금은 구간 단위 잠금).
- 종착·회차 후보, 승강장별 진로·입환(B13-2, B13-4).
- 지도 규칙은 M1~M4와 같다: 공간 사실만 낸다(비용·공기·허가·가능/불가능 없음), 모르면 null + `unknown[]` + `unknownReasons`, 결정론적 ID(저장된 key와 연결 대상에서 파생, 이름·배열 순서 금지), 원본 입력 불변, 같은 입력은 바이트 단위로 같은 출력.
- 새 계약이 필요하면 `engine/src/map/` 아래 새 파일로 만들고 경영 모듈을 import하지 말 것(`engine/test/map-layer.test.mjs`가 막는다. 주석에도 `from "..."` 꼴 문자열을 쓰지 말 것).

## 4. 지켜야 할 규칙 (이 프로젝트의 합의)

- 지도는 공간 사실만, 판정은 경영 엔진. 값을 모르면 `null` + `unknown[]` + `unknownReasons`. `0`/`false`/`[]`로 바꾸지 않는다. `physicalConnection: null`은 "모름"이지 "분리"가 아니다.
- 외부선: 소유자는 원자료가 말한 값만. 운영사 태그·노선 이름·외부역 중심점으로 접속을 추정하지 않는다.
- 새 작업은 별도 worktree/브랜치(최신 origin/master 기준)에서 한다. 사용자가 시키기 전에는 commit/push/merge 하지 않는다.
- `transitline/CLAUDE.md`가 `attribution.commit`이 없으면 `Co-Authored-By`를 넣지 말라고 한다.
- Windows에서 작업 트리는 CRLF로 보이지만 저장소는 LF다("LF will be replaced by CRLF" 경고는 정상). 파일을 일괄 치환할 때 줄바꿈을 정규화할 것.
- Ruflo 메모리는 Windows + Node 24에서 죽는다. 인수인계는 Git/문서로만 한다.
- 검사 명령: `npm test`, `npm run validate`, `git diff --check`, 예제 재생성은 `npm run through-handover-examples`(두 번 돌려 결과가 같아야 한다).

## 5. 건드리지 말 것 / 알아둘 것

- 메인 작업 트리(`C:\Users\이상재\transport_builder`)에는 Codex의 미커밋 B13-3/4 작업(`trains.mjs`, `scenario-runtime.mjs`, `railway-traffic-control.mjs` 등)이 있다. 이 브랜치는 그것과 무관하며 건드리지 않았다.
- 브라우저 확인용 하네스는 저장소 밖(세션 임시 폴더)에 있었고 지금은 없다. 필요하면 radial 팩의 `through-route-examples/01-...`, `03-...`와 `scripts/lib/synthetic-layers.mjs`로 `attachThroughHandoverEditor`를 붙인 캔버스 페이지를 새로 만들면 된다.
- 다른 B12 브랜치: M1 `b12-1/m1-through-route`(내용은 이미 master `89d5151`에 있음, 중복), M2 `b12-2/m2-external-technical-spec`(`7a52bac`), M3 `b12-5/m3-through-operation-map`(`d94163d`, master에 없음, master와 충돌 없음).

## 6. 알려진 한계

- 외부 기존망은 역 단위 좌표뿐이라 외부 측 접속은 항상 미상.
- 기존 철도 교차는 역 사이 직선 기준의 조잡한 값(품질 `low`로 표시).
- 경사는 DEM 31 m 격자의 지반 경사. 선로 구배가 아니다.
- 건물 자료는 팩마다 범위가 다르다(Tokyo `obstacles.json`은 4개 구역). 범위 밖은 `outside-coverage`로 미상.
- 충돌 마커는 정확한 교차 위치가 아니라 연락선 중간에 모아 표시한다.
- 지하·고가 여부는 알 수 없다. 구조형식은 플레이어가 지정한 값만 쓴다.
