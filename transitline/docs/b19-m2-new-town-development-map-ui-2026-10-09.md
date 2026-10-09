# B19-M2 신도시 개발 지도 편집기와 읽기 전용 오버레이 — 인수 문서

플레이어가 지도에서 신도시 개발 구역과 단계를 만들고, 다각형을 그리고 고치고, 켜고 끄고, 저장·복원하는 **독립 mount**다. 기준은 master `e6275af`(B19-M1 계약·편집기, B19-E1 포함), 브랜치 `b19-m2-new-town-map-ui`. B19-M1의 `new-town-development.mjs`(빌더)와 `new-town-development-editor.mjs`(편집 문서)를 그대로 쓰며 계약은 바꾸지 않았다. 지도는 **공간 사실만** 보여 준다: 입주율·인구·수요·비용·사업성·교통량·점수는 계산도 표시도 하지 않는다. `main.mjs`, `index.html`, `style.css`, `scenario-runtime.mjs`, `management/**`는 수정하지 않았다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/new-town-development-ui.mjs` | `mountNewTownDevelopment` — 상태·포인터·키보드·편집·새로 고침·출력 |
| `engine/src/map/new-town-development-view.mjs` | 표시 모델 `buildNewTownDevelopmentView`와 그리기 `drawNewTownDevelopmentOverlay` (순수) |
| `engine/src/map/new-town-development-panel.mjs` | 패널 DOM (개발·단계 목록, 선언 입력, 역·선로 지정, 공간 사실) |
| `engine/src/map/new-town-development-tools.mjs` | 꼭짓점·변·단계·역·선로 히트 판정, 표시 규칙(미상/측정/선언 구분), 한글 라벨 (순수) |
| `engine/test/new-town-development-ui.test.mjs` | 15개 |

모든 파일이 map 규칙을 따른다: import는 `./이름.mjs`뿐, 40 KB 미만, management·저장소·시계·난수 없음(소스 검사 테스트).

## mount API

```js
const bridge = mountNewTownDevelopment({
  canvas, projection, pack,        // 지도 canvas, projection.toScreen([lon,lat],w,h), pack.manifest.origin
  getMapExport,                    // () => { plans, externalNetworks }   (buildMapExport의 결과)
  getSpatial,                      // () => makeSpatialContext({ dem?, water?, roads?, buildings? }) | null
  onChange,                        // (output) => {}   바뀐 때마다 한 번
  enabled: true, autoRefreshMs: 250,
});
```

| 반환 | 하는 일 |
|---|---|
| `output()` | `{ document, export, selected, warnings }` — **이 네 가지만**. 모두 복사본 |
| `serialize()` | 편집 문서를 문자열로. 저장은 **호스트**가 한다(mount는 `localStorage`를 쓰지 않는다) |
| `loadDoc(source)` | 문자열 또는 객체로 문서 교체. 거절(다른 팩·읽을 수 없음·모르는 버전)되면 현재 문서를 그대로 두고 경고를 돌려준다. 팩 버전만 다르면 받고 `pack-version-mismatch` 경고. 불러온 뒤 선택은 비어 있다 |
| `refresh()` | 맵 export·레이어가 바뀌었음을 알리고 강제로 다시 계산 (타이머는 지문이 바뀐 때만) |
| `setEnabled(bool)` | 끄면 패널·오버레이를 숨기고 클릭·키를 지도에 넘긴다. 그리던 다각형은 버린다 |
| `destroy()` | 패널·오버레이·모든 리스너 제거 |

- `output().export`: `transitline.new-town-development-export/1` (개발 구역별 `developmentId`/`developmentRevision`, 단계별 `phaseId`/`phaseRevision`/`sequence`, 공간 사실). 스키마는 B19-M1 문서 참조.
- `output().selected`: 선택이 없으면 `null`, 있으면 `{ developmentKey, phaseKey, vertexIndex, mode, development, phase }`(`development`/`phase`는 그 export 항목의 복사본).
- `output().warnings`: mount의 알림(`new-town-edit-refused`, `polygon-needs-three-points`, 복원 거절·`pack-version-mismatch`) + export의 경고 + 개발 구역·단계 경고(`developmentId`/`phaseId`를 붙임: 오래된 역·선로 참조 `station-ref-missing`/`rail-ref-missing` 등) + `layer-missing`(`{reason: no-layer|outside-coverage, fields[]}`).
- CustomEvent `transitline:new-town-development`가 같은 출력을 `canvas`에서 낸다.

## main 연결 예 (Codex)

```js
import { mountNewTownDevelopment } from "./map/new-town-development-ui.mjs";

const newTown = mountNewTownDevelopment({
  canvas, projection, pack,
  getMapExport: () => latestMapExport,          // 이미 있는 buildMapExport 결과
  getSpatial: () => spatialContext,             // 이미 만든 공간 컨텍스트(없으면 null)
  onChange: (out) => {
    hostStorage.set(`newTown:${pack.manifest.id}`, newTown.serialize());   // 저장은 호스트가
    // B19 엔진에는 out.export 를 읽기 전용으로 넘긴다 (developmentId / phaseId 로 자기 상태를 연결)
  },
  enabled: false,
});
const saved = hostStorage.get(`newTown:${pack.manifest.id}`);
if (saved) newTown.loadDoc(saved);               // 경고가 돌아오면 사용자에게 알린다
toggleButton.addEventListener("click", () => { enabled = !enabled; newTown.setEnabled(enabled); });
// 맵 export 나 레이어가 바뀌면:  newTown.refresh();
```

## 저장 필드

`serialize()`는 B19-M1의 편집 문서 그대로다(버전 1):

```
{ version: 1, packId, packVersion,
  developments: [ { key, name, active, deleted, phaseSeq,
                    phases: [ { key, name, active, deleted, polygon: [[lon,lat]…] | null,
                                playerDeclaredLandUse: string | null, playerDeclaredDeliveryOrder: 정수 | null,
                                stationRefs: [{stationId, stationKind}] | [] | null,
                                railRefs: [{planId, segmentId} | {externalNetworkId, externalLineId}] | [] | null } ] } ] }
```

`deleted: true`는 묘비(key 재사용 방지), `active: false`는 껐다(잃지 않음). 참조 목록은 `null`=말하지 않음, `[]`=없다고 선언.

## 조작

| 조작 | 방법 |
|---|---|
| 개발 구역 생성 / 단계 추가 | `＋ 개발 구역` / `＋ 단계` (key는 `town-N`, `phase-N`이며 한 번 쓴 key는 삭제해도 다시 쓰지 않음) |
| 다각형 | `다각형 그리기`/`다시 그리기` → 지도를 눌러 점 찍기 → `완료`(Enter) / `취소`(Esc) / Backspace로 마지막 점 지우기. 3점 미만이면 거절하고 계속 그리게 둠 |
| 꼭짓점 | 선택한 단계의 핸들을 누르면 선택, **끌어서 이동**(놓을 때 공간 사실을 다시 계산), **변을 더블클릭하면 삽입**, `Delete` 또는 `점 삭제`로 삭제(3점 아래로는 거절) |
| 선택 | 단계 안을 누르면 선택(겹치면 나중에 그린 단계). 아무것도 못 고른 클릭은 지도로 넘어감. Esc는 점 → 단계 → 개발 구역 순으로 선택을 푼다 |
| 순서 변경 | 단계 줄의 `▲` `▼` — `sequence`만 바뀌고 key·ID는 그대로 |
| 켜기·끄기 | `구역 비활성/복원`, `단계 비활성/복원` — 지도에서 사라지지 않고 **흐린 점선**과 `(비활성)` 표시로 남고 사실도 그대로 |
| 삭제 | `구역 삭제`, `단계 삭제` (묘비로 남음) |
| 이름·용도·인도 순서 | 입력 칸(바꾸면 적용), 용도는 제안 버튼 10개 또는 아무 낱말. 인도 순서는 1 이상의 정수, 비우면 "말하지 않음". 잘못된 값은 거절하고 경고 |
| 역·선로 참조 | `지도에서 역/선로 고르기`(고르는 동안 모든 클릭을 가져가며 후보 표시를 그림) 또는 `역 ID 입력`. `빼기`로 하나씩 빼다가 마지막을 빼면 "말하지 않음"으로 돌아감. `없다고 선언`은 `[]`, `말하지 않음으로 되돌리기`는 `null` |

## 화면 규칙

- **미상(null)·측정된 없음·측정된 0·선언한 없음을 서로 다르게 쓴다**: `미상 (이유)` / `없음 (측정됨)` / `0` / `없음 (플레이어가 없다고 선언)`. 레이어가 없거나 범위 밖이면 `미상 (레이어 없음)`·`미상 (레이어 범위 밖)`이고 경고 `레이어 결측 …`이 뜬다. 다각형이 없는 단계의 모든 사실은 `미상 (다각형 없음)`.
- **선로 후보는 거리·겹침 사실**이다: 항목마다 `가까이 있음 · N m` 등으로 쓰고, 목록 위에 "접속이나 개통을 뜻하지 않습니다"를 붙인다. 연결/개통을 뜻하는 표시는 어디에도 없다.
- **노드는 위치만**: 구역 안의 노드 ID만 나열하고 팩의 `residents`/`jobs` 숫자는 읽지도 않는다. 구역 안에 노드가 없다는 것은 아무것도 뜻하지 않는다고 적는다.
- **오래된(stale) 참조**: 저장 문서가 가리키는 역·선로가 지금 지도에 없으면 경고 `오래된 참조: …`를 띄우되 플레이어의 참조는 문서에 남긴다.
- **복원 거부**: 다른 팩·읽을 수 없는 문서·모르는 버전은 패널에 `…불러오지 않았습니다`를 띄우고 현재 문서를 그대로 둔다.
- 패널은 화면 왼쪽(12 px, 위 64 px, 폭 372 px)에 놓인다. 다른 mount의 패널과 겹치면 호스트가 CSS로 옮긴다.

## 검증

- 단위(가짜 브라우저) 15개: 마운트·반환 형태·저장소 미사용, 그리기·완료·취소·3점 미만 거절, 꼭짓점 선택·이동·삽입·삭제와 3점 하한, 단계 선택(겹침·지도로 넘어가는 클릭), 순서 변경, 끄기·켜기(흐림·점선·라벨·사실 보존), 이름·용도·인도 순서(미선언 null, 나쁜 값 거절), 역·선로 지정(지도·ID 입력·`null`/`[]`/목록·오래된 참조), 공간 사실 패널(미상/측정 0/측정된 없음/선언 없음, 선로 거리, 노드 숫자 없음), `serialize`/`loadDoc`(같은 ID, 다른 팩·손상·버전 거절, 현재 문서 보존), ID 유지·삭제 key 비재사용, 얼린 입력과 출력 비공유, 껐을 때 지도로 넘기기와 `destroy`, 알림 횟수, 금지어·금지 키·management·저장소 없음.
- **실제 headless Chrome**(진짜 마우스·키): 개발 구역·단계 생성 → 점 4개 찍어 완료 → 꼭짓점 끌기 → 변 더블클릭 삽입 → Delete → 이름·용도·인도 순서 입력 → 지도에서 역·선로 고르기 → 단계 비활성(흐린 점선) → `serialize` 문자열을 호스트(`window.name`)에 보관하고 새로고침 → `loadDoc` 복원 → 다른 팩 문서 거절. 콘솔 오류 0.

## 화면 한계

- 다각형은 단순 외곽선만 지원한다(구멍 없음). 그리는 도중 자기 교차를 막지 않고, 완료 뒤 경고(`다각형 변이 서로 교차합니다`)와 사실 `null`로 알린다. 점 맞춤(스냅)·되돌리기(undo)·여러 점 동시 선택은 없다.
- 도로 참조 지정은 없다(도로는 사실 목록으로만 본다). 역·선로 지정은 지도 클릭 또는 역 ID 입력이다.
- 역·선로 고르기 모드는 맵 export의 모든 역과 선로를 그린다(Tokyo처럼 많으면 느릴 수 있음).
- 꼭짓점을 끄는 동안에는 공간 사실이 이전 값이고, 놓을 때 다시 계산한다.
- 패널 입력은 값이 바뀌어 포커스를 잃을 때(change) 적용된다. 터치 입력은 시험하지 않았다.
- 단계 라벨은 이름·용도·인도 순서만 쓴다. 입주율·인구 같은 상태는 이 mount에 들어올 자리가 없다(B19 엔진이 `developmentId`/`phaseId`로 따로 붙인다).
- 팩의 `demand.points`가 없으면 노드 사실이 `미상 (팩에 노드 기록 없음)`이다.
