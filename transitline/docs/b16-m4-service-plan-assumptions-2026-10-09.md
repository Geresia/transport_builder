# B16-M4 서비스 계획 운영 전제 (`transitline.service-plan-operational-assumptions/1`)

B16 서비스 계획이 B13 시간표 심사를 받기 전에 필요한 **기술사양·선로 전제**를 **플레이어가 명시적으로 입력·저장**하는 독립 모듈이다. 지금은 값이 없으면 정직하게 unknown이 되어 심사가 막힌다. 이 모듈은 그 값을 **플레이어의 진술로만** 채우고, **기본값을 몰래 넣지 않는다.** 기준은 master `713172e`, 브랜치 `b16-m4-service-plan-assumptions`.

## 경계

- **플레이어가 적은 값만 있다.** 모든 출력에 `basis: "player-stated-assumption"`이 붙고, 적지 않은 값은 `null`(미상)과 사유(`…-not-stated`)다. 최소 시격, 수송 설정(시간당 열차 수), 단·복선, 요일 유형, 수용 비율, 폐쇄 시간창, 기술 프로필·사양 어느 것도 다른 값에서 **추정·계산하지 않는다.** 특히 **시격과 시간당 열차 수를 서로 계산하지 않는다**(테스트: 시격만 적으면 시간당 열차 수는 `null`, 시간당 열차 수만 적으면 시격은 `null`, 둘을 다르게 적어도 맞추지 않음).
- 운행 가능 여부 판정, 시간표 생성, 비용·수요·혼잡·운임 계산을 하지 않는다. `management/**`, `scenario-runtime.mjs`, `main.mjs`, `index.html`, `style.css`는 수정하지 않았고, 새 모듈은 management·런타임·엔진 상태를 import하지 않는다(테스트로 고정).
- 지도 계획·카탈로그 입력은 바꾸지 않고(얼린 입력 테스트), 출력은 입력과 객체를 공유하지 않는다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/service-plan-assumptions.mjs` | 검증, 전제 묶음(`buildAssumptionSet`)과 export(`buildAssumptionExport`), `technicalSpecsOf`, `assessmentInputFor` — 순수 함수 |
| `engine/src/service-plan-assumptions-editor.mjs` | 문서 편집(`setAssumptions` 등), `rebindAssumptions`, `serializeAssumptionsDoc`, `restoreAssumptionsDoc` |
| `engine/src/service-plan-assumptions-ui.mjs` | `mountServicePlanAssumptionsPanel` — 컨테이너에 그리는 독립 패널(자기 `<style>` 포함, 지도 캔버스 불필요) |
| `engine/test/service-plan-assumptions.test.mjs` | 계약·편집기·런타임 연결 20개 |
| `engine/test/service-plan-assumptions-ui.test.mjs` | 패널 17개(fake DOM) |

## 문서와 ID

저장 문서 `{ version: 1, packId, packVersion, entries: [{ servicePlanId, boundServicePlanRevision, statements }] }` — 계획 하나에 항목 하나. `statements`는 항상 아래 9개 키를 가지며 안 적은 값은 `null`이다.

| 필드 | 값 | 비고 |
|---|---|---|
| `technicalProfileId` | 문자열 \| `null` | 호스트 카탈로그(`knownTechnicalProfileIds`)를 주면 그 안의 값만 받는다. 카탈로그가 없으면 모양만 본다 |
| `technicalSpecification` | 객체 \| `null` | 알려진 필드만(`runningSystemId`, `gaugeMm`, `carWidthM`, `maxAxleLoadTonnes`, `collectionSystemId`, `currentSystem`, `voltageV`, `minimumCurveRadiusMeters`, `maxGradientPermille`, `signalSystemIds`, `platformHeightMm`, `doorLayoutId`, `minCars`, `maxCars`, `maintenanceSystemId`). 숫자는 양수, `minCars ≤ maxCars`, `signalSystemIds`는 비어 있지 않은 목록. `{}`는 "덮어쓸 것 없음" 선언 |
| `notApplicable` | `["gaugeMm"]` 부분집합 \| `null` | `[]` = "해당 없는 항목 없음"을 선언 |
| `capacityTrainsPerHour` | 양의 정수 \| `null` | 플레이어가 직접 적은 값(시격에서 계산하지 않음) |
| `directionMode` | `"single"` \| `"double"` \| `null` | |
| `minimumHeadwayMinutes` | 0 초과 1440 이하 숫자 \| `null` | 0·음수·문자·NaN·1441은 거부 |
| `closureWindowsBySectionId` | `{ [trackSegmentId]: [] \| [{startMinute, endMinute, reason?}] }` \| `null` | 구간마다 `[]` = 폐쇄 없음 선언, 목록 = 시간창. **적지 않은 구간은 미기재**(`closureSectionsNotStated`로 나열). 시간창은 하루 안의 정수 분, `0 ≤ start < end ≤ 1440`, 한 구간 안에서 겹치면 거부(맞닿는 것은 허용) |
| `dayType` | `weekday` \| `weekend` \| `holiday` \| `null` | B13 `RAILWAY_TIMETABLE_DAY_TYPES`와 같다(테스트로 고정) |
| `minimumAcceptanceRatio` | 0~1 숫자 \| `null` | **0은 적은 0**이며 그대로 넘어간다 |

- `assumptionSetId` = `stableId("service-plan-assumptions", packId, servicePlanId)` — 계획 ID에서만 나온다(이름·순서·시계·난수에 의존하지 않음). `assumptionSetRevision` = 내용 전체의 해시(바뀐 값이 있으면 달라진다). 같은 입력은 바이트까지 같은 JSON이다.
- **계획 개정에 묶인다.** 항목은 만들 때의 `servicePlanRevision`(`boundServicePlanRevision`)을 기록한다. 지도 계획이 바뀌어 개정이 다르면 `state: "stale"`, `usable: false`, `assessInput: null`, 경고 `service-plan-revision-changed`다. 적어 둔 값은 **지우지 않고 보존·표시**하지만 넘기지 않는다. 편집만으로는 다시 맞춰지지 않고, 플레이어가 `rebindAssumptions`(패널의 "계획이 바뀐 것을 확인했고 이 전제를 계속 씁니다")로 확인해야 한다. 지도에 없는 계획은 `state: "plan-missing"`(문서에는 남음).

## null / 0 / false / [] 규칙

- `null` = 안 적음(미상). `unknown[]`·`unknownReasons`에 이름과 사유(`direction-mode-not-stated` …)가 같은 개수로 있다.
- `[]` = 플레이어가 "없음"이라고 선언했다. 폐쇄가 없다(`closure…: { ab: [] }`), 해당 없는 항목이 없다(`notApplicable: []`). `null`과 다르다.
- `0` = 적은 0. 유일하게 합법적인 0은 수용 비율 `0`이다. 시격 0, 시간당 열차 수 0, 폭 0 같은 값은 거부한다.
- `false`는 이 계약의 값이 아니다(문서에 `false`가 나오지 않음을 테스트가 확인).
- **적지 않은 항목은 `assessInput`에서 아예 빠진다**(기본값으로 채우지 않음). B13/런타임이 입력이 없을 때 하는 처리는 `defaultsApplyDownstream`에 이름을 달아 두었다: `dayType` → 런타임이 `weekday`, `minimumAcceptanceRatio` → 런타임이 `1`, `closureWindowsBySectionId` → 시간표 심사가 폐쇄 없음으로 읽음. **이것은 플레이어가 정한 값이 아니다**(패널에도 그렇게 표시).

## export 계약

`buildAssumptionExport({ pack, doc, servicePlans, knownTechnicalProfileIds? })` → `transitline.service-plan-operational-assumptions-export/1`:

```
{ schema, packId, packVersion, basis: "player-stated-assumption",
  sets: [ transitline.service-plan-operational-assumptions/1, … ],   // assumptionSetId 순
  technical: { technicalSpecs: { [operationalLineId]: spec }, conflicts: [{ operationalLineId, assumptionSetIds }] } }
```

한 묶음: `{ assumptionSetId, assumptionSetRevision, sourcePackId, sourcePackVersion, servicePlanId, boundServicePlanRevision, currentServicePlanRevision, operationalLineId, state, usable, basis, statements, statedFields, unknown, unknownReasons, closureSectionsNotStated, defaultsApplyDownstream, assessInput, warnings }`.

`assessInput`(`usable`일 때만, 적은 값만):

```
{ technicalSpecs: { [operationalLineId]: { technicalProfileId?, technicalSpecification?, notApplicable?, capacityTrainsPerHour? } },   // 계획에 운영 노선이 없으면 {}
  infrastructureAssumptions: { directionMode?, minimumHeadwayMinutes? } | null,
  closureWindowsBySectionId?, dayType?, minimumAcceptanceRatio? }
```

## Codex 연결 표

| 연결 지점 | 이 모듈에서 | 비고 |
|---|---|---|
| `getPrescreenContext().technicalSpecs` (B16-M3 `mountServicePlanManagementPanel`) | `panel.technicalSpecs()` 또는 `export.technical.technicalSpecs` | `{ [lineId]: { technicalProfileId?, technicalSpecification?, notApplicable?, capacityTrainsPerHour? } }` — M3가 E1에 넘기는 모양 그대로. 낡은·지도에 없는 계획의 것은 빠지고, 같은 노선에 서로 다른 사양을 적은 계획이 둘 이상이면 그 노선은 빠지고 `technical.conflicts`에 나온다(어느 쪽이 맞는지 추측하지 않음) |
| `ScenarioRuntime.assessServicePlanTimetable(servicePlan, binding, input)`의 `input.technicalSpecs` | `assessmentInputFor(export, servicePlanId).technicalSpecs` | 위와 같은 모양(그 계획의 노선 하나) |
| `input.infrastructureAssumptions` | `….infrastructureAssumptions` | B13이 트랙에 `directionMode`·`minimumHeadwayMinutes`가 없을 때만 쓰며, 쓰면 `operationalFacts.assumptions`에 `…:explicit-assumption-…`으로 기록한다(테스트로 확인) |
| `input.closureWindowsBySectionId` | `….closureWindowsBySectionId` | 키는 **운영 트랙 구간 ID**(`route.sections[].trackSegmentId`) |
| `input.dayType`, `input.minimumAcceptanceRatio` | `….dayType`, `….minimumAcceptanceRatio` | 안 적었으면 키가 없다 → 런타임 처리(`defaultsApplyDownstream`) |
| `input.vehicleOrders`, `input.operatingResourcePools` | (이 모듈이 다루지 않음) | 호스트가 기존대로 넘긴다 |

호스트 코드 모양(Codex가 `main.mjs`에서 연결):

```js
import { mountServicePlanAssumptionsPanel } from "./service-plan-assumptions-ui.mjs";
const assumptions = mountServicePlanAssumptionsPanel({
  container: $("scenario-service-plan-assumptions"), pack,
  getServicePlans: () => servicePlanEditor?.output().export?.plans ?? [],   // 지도 계획(B16-M2 export)
  getTechnicalProfiles: () => Object.values(TECHNICAL_PROFILES).map((p) => ({ id: p.id, name: p.id })),  // 선택. 카탈로그를 주면 그 밖의 프로필은 거부
  storage: window.localStorage,                                             // 선택. 없으면 호스트가 serialize()/loadDoc()으로 저장
  onChange: () => queueMicrotask(() => refreshScenarioPanel()),
});
// M3의 사전심사 문맥: 기존 technicalSpecs에 이 모듈의 것을 합친다
const servicePlanPrescreenContext = () => ({ technicalSpecs: { ...hostSpecs, ...assumptions.technicalSpecs() } });
// 시간표 심사 호출: 계획마다
const input = assumptions.assessInput(servicePlanId);           // null이면 전제가 없거나 낡음 → 심사에 넘기지 않는다
if (input) runtime.assessServicePlanTimetable(plan, { servicePlanId, serviceId }, { ...hostInput, ...input });
```

(합칠 때 호스트가 이미 가진 사양과 같은 노선이 겹치면 어느 쪽을 쓸지는 호스트 정책이다. 이 모듈은 자기 값에 `basis`를 남길 뿐 덮어쓰지 않는다.)

## 패널

컨테이너 하나에 그린다(지도 캔버스·mount-kit 오버레이 없음, 자기 `<style>` 포함). 계획 목록(`전제 없음` / `현재` / `계획이 바뀜 (낡음)` / `지도에 없는 계획`) → 선택하면 카드: 기술 프로필(카탈로그 선택 또는 입력), 명시적 기술사양(JSON), 해당 없는 항목, 시간당 열차 수(직접 적은 값), 단·복선, 최소 시격(분), 구간별 폐쇄 시간창(시간창 추가 / 없음으로 선언 / 미기재로 / 모든 구간 없음으로 선언), 요일 유형, 수용 비율. 맨 아래 "정리"에 적은 항목, 미상 항목과 사유, 기본 처리가 적용되는 항목, 시간표 심사 입력 미리보기(적은 값만, 낡으면 "넘기지 않음")가 있다. 값을 바꾸면(칸에서 벗어나거나 선택하면) 바로 검사하고 저장한다. 잘못된 값은 **적용하지 않고** 패널과 `output().warnings`에 `service-plan-assumptions-refused`와 이유를 남긴다. 호출: `select`, `set(servicePlanId, patch)`, `setClosureWindows`, `declareNoClosures`, `clear`, `rebind`, `remove`, `serialize`, `loadDoc`(다른 팩·읽을 수 없는·다른 버전 문서는 거부하고 현재 문서를 그대로 둠), `technicalSpecs()`, `assessInput(id)`, `output()`, `refresh()`, `destroy()`. 저장 키 `transitline.service-plan-assumptions.v1:<packId>`.

## 알아 둘 한계 (실제로 확인한 것)

- **사전심사(E1)의 `direction-mode` 항목은 지도에 적힌 단·복선(용량 application)을 읽는다.** 여기서 적은 단·복선은 B13 입력(`infrastructureAssumptions`)으로만 가고, 지도에 단·복선이 없으면 그 항목은 계속 미상이라 심사가 막힌다. 실제 연결 테스트(4번 시나리오)가 이를 보여 준다. 풀려면 철도 용량 지도(B13-M5)에 단·복선을 적거나, Codex가 E1이 플레이어 전제를 읽게 바꿔야 한다(이번 범위 밖, E1 미변경).
- 사전심사의 `capacity-data`는 `capacityTrainsPerHour`를 요구한다. 이 모듈은 그 값을 **플레이어가 적었을 때만** 채운다(시격에서 계산하지 않음).
- 시간창은 하루 안의 정수 분이다(자정을 넘는 폐쇄는 두 구간으로 나눈다). 폐쇄 시간창의 키가 계획 경로에 없는 구간이면 경고(`closure-section-not-on-route`)만 하고 값은 그대로 둔다.
- 기술사양 JSON 필드 목록은 `assessTechnicalCompatibility`가 읽는 것에 맞춘 목록이며, 값의 단위·범위는 모양만 검사한다(기술적으로 맞는지는 E1이 판단).
- 계획이 바뀔 때마다 전제가 낡아지므로 계획을 자주 고치면 확인 버튼을 자주 눌러야 한다.
- 브라우저에서 select 상자는 헤드리스에서 열 수 없어 값 지정 + `change` 이벤트로 확인했다. 합성 계획으로만 확인했고 실제 도쿄 계획으로는 확인하지 않았다.

## 검증

- 단위 20 + 패널 17개. 거부(0·음수·문자·NaN·너무 큰 시격, 겹치거나 뒤집힌·하루를 넘는 시간창, 알 수 없는 요일·단·복선·프로필·사양 필드, 범위 밖 비율), null/0/false/[] 구분, 같은 입력 = 같은 ID·바이트, 쓴 순서와 무관, 저장·복원, 다른 팩 문서 거부와 현재 문서 유지, 팩 버전 경고, 깨진 저장 항목은 고치지 않고 경고, stale·재확인·지도에 없는 계획, 입력 불변·출력 비공유, 노선별 기술사양 병합·충돌, import·시계·난수·저장소·"시격↔수송 설정 계산 없음" 검사, 패널의 모든 상태 문구에 판정·비용·수요 낱말 없음, 그리고 **실제 `ScenarioRuntime`**(전제 없음 → 심사 unknown·`timetable: null`, 일부만 적음 → 여전히 unknown, 전부 적음 → `ready`와 B13 시간표가 `weekend`와 명시 가정을 기록, 지도에 단·복선 없음 → 계속 unknown, 계획이 바뀜 → 입력을 넘기지 않음).
- 실제 headless Chrome(진짜 마우스·타이핑): 프로필 선택 → 단·복선 → 최소 시격 3 입력 → 시간당 열차 수 20 → 수용 비율 0 → 요일 유형 → "모든 구간 없음으로 선언" → 최소 시격 `0` 입력(거부됨, 값 유지) → 저장 확인 → 새로고침 후 복원 → 계획 개정 변경(낡음, 입력 넘기지 않음, 값 보존) → 확인 버튼으로 재개 → localStorage에 다른 팩 문서를 넣고 새로고침하면 거부되고 패널에 표시. 콘솔 오류 0.
