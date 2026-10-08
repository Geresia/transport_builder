# B16-M2 운행계획 지도 편집 UI — Codex 인수 문서

B16-M1의 `service-plan-geometry.mjs`(계약)와 `service-plan-editor.mjs`(문서 편집)를 **그대로 쓰는** 독립 mount다. 플레이어가 철도 용량 지도 위에서 운행계획(구간 순서, 방향, 시간대, 회차, 차량·차량기지 참조, 가정)을 **요청으로 적고**, 지도가 읽은 선로 사실을 옆에서 본다. 기준은 master `6cf4d5c`, 브랜치 `b16-m2-service-plan-editor-ui`.

## 경계

- **계산하지 않는다.** 비용, 수요, 혼잡, 실제 운행 여부, 시간표, 용량을 만들지도 보이지도 않는다. 배차 간격·편성 수·량 수는 화면 어디서나 **"요청"**이라고 부른다(`배차 간격 요청 5분`, `요청 편성 수`, `요청 량 수`). 맨 위 안내문: "이 화면에 적는 배차 간격·편성 수·량 수는 요청한 값이며, 그대로 운행된다는 뜻이 아닙니다."
- management, 엔진 상태, `scenario-runtime`, `main.mjs`, `index.html`, `style.css`, B16-C1 adapter를 import하거나 수정하지 않는다. 새 모듈은 `engine/src/map/` 안의 `./…mjs`만 import한다(테스트로 고정). 지도·적용 결과·카탈로그 getter가 준 객체는 바꾸지 않는다(얼린 입력 테스트).
- 시계, 난수, 저장소 직접 접근이 없다. 저장은 `map-mount-kit`의 `createStore`(localStorage, 막히면 노트)가 한다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/service-plan-ui.mjs` | `mountServicePlanEditor` — 상태, 편집(문서 수정·저장), 지도 클릭, 갱신, 출력 |
| `engine/src/map/service-plan-panel.mjs` | 패널의 조작부(선택·입력·버튼). 상태를 받아 DOM만 만든다 |
| `engine/src/map/service-plan-view.mjs` | 순수 표시 모델 `buildServicePlanView`, 캔버스 그리기, 범례, "지도가 읽은 사실" 목록, 사유·경고 라벨 |
| `engine/src/map/service-plan-tools.mjs` | 구간·역 클릭 판별, 역·구간 이름, 값 표시(`showValue`), 숫자 입력 해석 |
| `scripts/lib/service-plan-world.mjs` | 합성 세계(실제 `buildMapExport → buildRailGeometry` 경로, 브라우저에서도 로드됨) — 테스트와 Chrome 확인 공용 |
| `engine/test/service-plan-editor-ui.test.mjs` | 30개 테스트(fake DOM) |

## mount

```js
import { mountServicePlanEditor } from "./src/map/service-plan-ui.mjs";

const planEditor = mountServicePlanEditor({
  canvas, projection, pack,                                   // 지도 캔버스, toScreen([lon,lat], w, h), 팩(manifest.id/origin/version)
  getRailGeometries: () => railCapacityOutput.railGeometries, // RailCapacityGeometry v1 목록 (또는 { railGeometries | designs }, 단일 객체)
  getApplications:   () => runtime.railCapacityApplicationReport(), // rail-capacity-application/1 목록 (또는 { applications })
  getVehicleModels:  () => [{ id, name }],                    // 선택. 없으면(null) 차량 모델 ID를 글로 입력
  getDepots:         () => [{ id, name }],                    // 선택. 없으면 차량기지 ID를 글로 입력
  onChange: (out) => {},                                      // 바뀔 때만 한 번
});
```

- 필요한 getter는 **지도 목록과 적용 결과** 둘이다. 지도 목록은 B13 `mountRailCapacityDesign`의 `output().railGeometries`를 그대로 연결하면 된다. 적용 결과는 `runtime.railCapacityApplicationReport()`다. 둘 다 없거나 이상한 모양이면 빈 편집기가 되고 예외는 없다(테스트).
- 오버레이 캔버스·패널(`.tl-plan-panel`, **오른쪽 위**, 폭 380 px, 높이 78vh 스크롤)·`<style>`(`transitline-service-plan-style`)은 mount가 만든다. 다른 패널과 겹치면 호스트 CSS로 위치를 바꾼다.
- 지도 목록이 하나뿐이면 자동으로 고른다. 여럿이면 플레이어가 "지도"를 고른다.
- 같은 입력과 같은 조작이면 `output()`이 바이트까지 같다(ID 포함, 테스트). `refresh()`는 입력(지도·적용 결과·카탈로그)이 바뀌었을 때만 다시 만들고 `onChange`도 그때만 부른다.

### 출력과 호출

`planEditor.output()` / `onChange(out)` / `CustomEvent("transitline:service-plan-editor")` →

```
{ document,                // 플레이어의 문서 (B16-M1 service-plan-editor 문서, 복사본)
  export,                  // buildServicePlanExport 결과 (transitline.service-plan-export/1, 복사본)
  plans, selected,         // export.plans, 선택한 계획의 계약 객체(없으면 null)
  selectedKey, geometryId, applicationLine, mode,   // mode: null | "pick-section" | "pick-turnback"
  view,                    // 표시 모델 transitline.service-plan-editor-view/1
  warnings }               // 저장 실패·편집 거부 노트 + export 경고
```

출력은 내부 상태의 복사본이라 고쳐 써도 편집기에 영향이 없다. Codex(B16-C1 adapter)는 `export.plans`(또는 `selected`)를 읽으면 된다. 읽는 법은 B16-M1 문서 7장.

호출(전부 문서를 고치고 저장한다; 편집기가 거부하면 예외 대신 `warnings`에 `service-plan-edit-refused`와 이유가 남고 `false`를 돌려준다):

`selectGeometry(id)`, `selectApplication(lineId)`, `createPlan({name})`, `selectPlan(key)`, `deselect()`, `deactivatePlan(key)`, `restorePlan(key)`, `removePlan(key)`, `rebind()`, `setPlanField(field, value)`(`name|planKind|operatingPattern|operationalLineId`), `addSection(id)`, `removeSection(id)`, `moveSection(from, to)`, `reverseRoute()`, `clearRoute()`, `addDirection(from, to, label)`, `addDirections("both"|"forward"|"reverse")`, `removeDirection(key)`, `clearList("direction"|"turnback")`, `addBand(values)`, `updateBand(key, values)`, `toggleBand(key)`, `removeBand(key)`, `addTurnback(stationId)`, `setTurnback(key, patch)`, `removeTurnback(key)`, `declareNoTurnbacks()`, `setVehicle(values)`, `addDepotRef(values)`, `removeDepotRef(key)`, `addAssumption(text)`, `removeAssumption(key)`, `setMode(kind)`, `setEnabled(bool)`, `refresh()`, `destroy()`. 읽기: `selectedKey`, `mode`, `document`, `storageKey`.

### 저장·복원

- 저장 키 `transitline.service-plan.v1:<packId>`, 값은 B16-M1 문서의 JSON(`serializeServicePlanDoc`). 모든 편집 뒤에 저장하고, 못 하면(막힘·가득 참) 패널과 `warnings`에 `service-plan-doc-not-saved`가 뜨지만 편집은 계속된다.
- mount할 때 한 번 읽는다. **다른 팩의 문서**, 읽을 수 없는 문서, 다른 버전의 문서는 거부하고 빈 문서로 시작하며 `service-plan-doc-other-pack` 등이 `warnings`에 남는다(저장소의 원본은 다음 저장 전까지 그대로다). 팩 버전이 다르면 `pack-version-mismatch` 경고만 하고 문서는 쓴다.
- `serialize()`는 문서 JSON 문자열을 돌려준다. `loadDoc(text|object)`는 호스트가 가진 저장본으로 **통째로 바꾼다**. 거부된 문서(다른 팩 등)는 **지금 편집 중인 문서를 그대로 둔다**(`restoreServicePlanDoc`의 `{ current }`). 돌려주는 값은 이번 호출의 경고 목록이다.
- 삭제한 계획은 문서에 무덤으로 남아(`deleted: true`) 번호를 다시 쓰지 않는다. 저장·복원 뒤에도 같다. 계획 ID는 key에서 나오므로 수정·저장·복원 뒤에도 같다(테스트).

## 플레이어가 하는 일 (화면)

1. **지도·적용 결과 고르기**: "지도" 선택, "용량 적용 결과" 선택(노선 ID와 `현재`/`낡음`). 적용 결과가 없거나 낡으면 계획 옆 경고와 배너가 뜨고, 낡은 결과에서는 구간별 트랙 번호가 비어 있다.
2. **계획 생성·끄기·켜기·삭제**: 이름을 적고 "새 계획 만들기". 꺼진 계획은 `꺼짐`, 지도가 바뀐 계획은 `지도 낡음`, 만들 수 없는 계획은 `만들 수 없음`. 삭제한 계획은 번호를 안내한다.
3. **구간 고르기**: "지도에서 구간 고르기"를 켜고 지도의 구간을 순서대로 클릭(이미 고른 구간을 다시 클릭하면 뺀다, 선형이 없는 기존선은 역과 역을 잇는 점선으로 클릭 가능). 패널에서 ▲▼, 삭제, "노선 반전", "구간 모두 비우기". 계획 ID는 안 바뀐다.
4. **방향**: "양방향 만들기", "정방향만", "역방향만"(시작·끝 역을 읽을 수 있을 때), 또는 출발·도착 역을 직접 골라 추가. 같은 방향 중복은 거부된다. 일부 구간만 가는 방향도 된다.
5. **시간대**: 이름·기간 구분(문자열), 시작·끝(하루 안의 분), "배차 간격 요청(분)", "요청 편성 수", "요청 량 수", 적용할 방향 체크(건드리지 않으면 계획의 모든 방향). 비운 칸은 "안 적음"(`null`)이고 "미상 (…사유)"로 보인다. `0`은 0으로 남는다. 글자가 섞이면 거부한다. 계약이 받아들이지 않는 값(간격 0, 끝이 시작보다 이름)은 **적은 그대로 두고** 패널에 "배차 요청 값이 올바르지 않아 비웠음" 같은 경고로 알린다. 수정·끄기·켜기·삭제가 있다.
6. **회차**: "지도에서 회차역 고르기"로 노선 위의 역을 클릭(노선 끝이면 `route-end`, 아니면 `intermediate`). 역마다 "종착 설비"(지도가 아는 설비 목록)와 "회차 후보"(고른 설비의 회차선·인상선 후보)를 고른다. "회차 없음으로 선언"(`[]`)과 "회차를 적지 않은 상태로"(`null`)가 따로 있다. 고른 설비가 그 역에 없으면 목록에 `(목록에 없음)`으로 남고 경고가 뜬다.
7. **차량·차량기지·가정**: 차량 모델(카탈로그 선택 또는 ID 입력), 요청 량 수, 요청 편성 수. 입·출고 참조(차량기지, 연결 역, 입고/출고/입·출고), 운영 가정(글). 맞는지는 확인하지 않는다는 문구가 붙어 있다.

## 지도 위 표시

고른 구간은 굵은 선과 **순서 번호**, 방향마다 다른 색의 **진행 화살표**(두 방향이면 나란히), 시작·끝 역 표시, 이웃 구간의 접속 기호(`●` 읽음 / `✕` 만나지 않음 / `?` 지도에서 읽을 수 없음), 회차역의 고리(`✓` 고른 설비가 지도에 있음 / `✕` 고른 설비가 이 역에 없음 / `○` 설비는 있으나 고르지 않음 / `–` 종착 자료에 이 역의 설비가 없음 / `?` 종착 자료 없음). 점선 고리는 "자료가 없거나 정하지 않음"을 뜻한다. 고르지 않은 구간은 회색, 선형이 없는 기존선은 점선. **지도가 바뀐 뒤 다시 확인하지 않은 계획은 전체가 흐리고 노란색**이다("현재 지도로 다시 확인"을 눌러야 현재가 된다). 색에만 기대지 않고 글리프·점선·글자로 구분한다.

패널 아래쪽 "지도가 읽은 사실"에는 구간별 단·복선, 폐색 수, 분기기 수, 길이, 이웃 구간 접속, 방향별 구간 수, 회차 설비 사실이 있고, **미상은 "미상 (사유)", 없다고 선언한 목록은 "없음(선언됨)", 0은 "0", false는 "아니오"**로 따로 보인다.

## 검증

- 단위·DOM 테스트 30개(실제 `buildRailGeometry` 경로의 합성 세계): 마운트·숨김·destroy, 지도 선택, 계획 생성, 적용 결과 연결·낡음, 구간 클릭·재클릭·반전·재정렬, 방향(양방향·정·역·수동·중복·읽을 수 없는 노선), 시간대 입력·수정·끄기·0과 빈칸·잘못된 입력, 회차(지도 클릭·설비·후보·선언), 설비 자료 없음 미상, 차량·차량기지·가정(카탈로그 있음/없음), 종류·운행 방식·이름(타이핑 중 패널 유지), 끄기·켜기·삭제와 번호 재사용 금지, 그리기 결과(색·번호·화살표·접속 기호·점선·흐림), stale·재확인, null/false/0/[] 표시, 표시 모델의 순수성, 저장·복원·같은 ID, 다른 팩 거부(저장소·`loadDoc`)와 현재 문서 유지, 저장소 막힘, 같은 입력 = 같은 출력, 얼린 입력 불변·출력 비공유, 이상한 getter, Esc·`onChange` 한 번, 금지 낱말 전수 검사, 계산 필드 없음, import·시계·난수·저장소 검사, 엔진 상태 불변.
- **실제 headless Chrome**(진짜 마우스·키보드): 계획 만들기 → 지도에서 구간 2개 클릭 → 양방향 → 시간대 입력(실제 타이핑) → 회차역 2곳 클릭 → 종착 설비 선택 → Esc → 저장 확인 → **새로고침 후 같은 계획 ID로 복원** → 지도가 바뀐 상태(stale) 배너와 노란 흐림 → "현재 지도로 다시 확인" → localStorage에 다른 팩 문서를 넣고 새로고침하면 `service-plan-doc-other-pack`로 거부되고 패널에 표시. 콘솔 오류 0. (select 상자의 선택은 브라우저 기본 드롭다운을 헤드리스로 열 수 없어 값 지정 + `change` 이벤트로 했다.)

## UI 한계

- 패널 위치(오른쪽 위)는 호스트가 정한다. 다른 패널과 겹칠 수 있고, 화면이 좁으면 패널 아래로 지도가 가려진다.
- 지도는 자기가 읽은 구간만 그린다. 구간 클릭은 지도에 선형이 있는 구간은 그 선, 없는 기존선은 역과 역을 잇는 직선이다(그 직선은 실제 선로 위치가 아니다). 다른 계획선과 겹치면 가장 가까운 선(같으면 구간 ID가 앞선 쪽)이 잡힌다.
- 구간 목록은 **고른 순서 그대로**다. 서로 이어지지 않는 구간을 골라도 막지 않고 "이웃 구간이 같은 역을 공유하지 않음"으로 미상을 표시할 뿐이다. 도쿄 팩처럼 계획 구간과 기존선이 같은 역 ID를 쓰지 않으면 역 순서가 `null`이어서 "양방향 만들기"를 쓸 수 없고 역을 직접 골라야 한다.
- 시간은 하루 안의 분(0–1440)만 받는다. 자정을 넘는 운행은 두 시간대로 나눈다. 요일 유형은 "기간 구분" 문자열을 그대로 전달할 뿐 해석하지 않는다.
- 차량 모델·차량기지는 카탈로그가 있으면 목록에서 고르고, 없으면 ID를 쓴다. 어느 쪽이든 존재·호환 여부는 확인하지 않는다.
- 합성 세계(구간 6개)로만 확인했고 실제 도쿄 위 화면과 큰 지도에서의 성능은 확인하지 않았다. 입력이 같으면 갱신 주기(250 ms)마다 아무것도 다시 만들지 않는다.
- 모바일·터치 조작, 드래그로 구간 이어 그리기, 지도에서 방향 화살표를 직접 잡아 바꾸는 조작은 없다.
- 여러 계획을 동시에 겹쳐 보여 주지 않는다(선택한 한 계획만 강조).

## Codex가 할 일

1. `main.mjs`에서 위 예시처럼 마운트한다. 지도 목록은 B13 철도 용량 mount 출력의 `railGeometries`, 적용 결과는 `runtime.railCapacityApplicationReport()`.
2. `onChange`(또는 `transitline:service-plan-editor` 이벤트)의 `export`를 B16-C1 adapter에 넘긴다. `revision.state`·`capacityApplicationState`가 `current`인지, `active`, `unknownReasons`를 adapter가 확인한다(B16-M1 문서 7장).
3. 패널 자리를 정하고, 필요하면 `setEnabled(false)`로 숨긴다. 저장은 mount가 하므로 호스트는 따로 저장하지 않아도 된다. 호스트 자체 저장소를 쓰려면 `serialize()`/`loadDoc()`을 쓴다.
