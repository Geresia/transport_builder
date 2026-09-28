# A7-2 작업면·중장비 배치 경영 연동 보고서

- 기준일: 2026-09-28
- 공간 입력: `transitline.construction-workfront-geometry/1`
- 경영 출력: 공구별 장비 배정과 `feasible` / `conditional` / `infeasible` 판정

## 경계

지도는 작업면의 면적·폭·경사·도로 접근·충돌·조립장·적치장이라는 공간 사실만 계산한다. 경영 엔진은 계약된 장비 종류에 따라 필요한 최소 조건을 적용하고 배치 판정을 만든다. 지도 모듈은 입찰 자격, 공사비, 공기와 판정을 계산하지 않는다.

## 확정된 보고서 계약

`ScenarioRuntime.report()`는 최상위에 `equipmentAssignments[]`를 반환한다. 각 항목은 다음 필드를 가진다.

```js
{
  id,
  workfrontId,
  constructionSiteId,
  equipmentType,
  status,                    // assigned | released
  placementStatus,           // feasible | conditional | infeasible
  placementFailures: [],
  placementConditions: [],
  placementAssessedAtMinute,
  contractorId,
  packageContractId
}
```

낙찰 전에는 장비가 아직 배정되지 않았으므로 `equipmentAssignments[]`가 비어 있는 것이 정상이다. 대신 같은 보고서의 `workfrontAssessments[]`에서 사전 판정을 읽는다. 각 항목에는 `scheduleId`, `projectId`, `planId`, `constructionSiteId`, `kind`, `equipmentType`, `workfrontId`, `placementStatus`, `failures`, `conditions`, `assessedAtMinute`가 포함된다. 낙찰 시에는 저장된 사전 판정 중 `feasible`을 `conditional`보다 우선하여 계약 장비 배정에 자동 복사하므로 지도 갱신을 다시 일으킬 필요가 없다.

정확한 공간 연결 키는 `workfrontId`다. `constructionSiteId`는 예전 저장자료나 작업면 미지정 상태를 위한 폴백이다. `contractorId`와 `packageContractId`는 각 배정 항목 안에 넣으며, 공구 요약에도 계속 둔다.

## 장비별 초기 요구조건

다음 수치는 법정 기준이 아니라 2026년 게임 밸런스 초기값이다.

| 장비 | 최소 작업면 | 최소 폭 | 최소 회전공간 | 최대 경사 | 주요도로 필요 |
| --- | ---: | ---: | ---: | ---: | --- |
| TBM `tunnel-boring` | 1,000㎡ | 18m | 250㎡ | 3% | 필요 |
| 흙막이 `retaining-wall` | 600㎡ | 12m | 160㎡ | 4% | 필요 |
| 대형 양중 `heavy-lift` | 800㎡ | 16m | 220㎡ | 3% | 필요 |
| 철도 시스템 `rail-systems` | 300㎡ | 8m | 80㎡ | 5% | 일반 배송도로 필요 |

장비마다 진입 폭, 도로 폭, 상부 여유고, 조립장과 적치장 최소 면적도 별도로 검사한다. 값은 `EQUIPMENT_WORKFRONT_REQUIREMENTS`에서 한곳에 관리한다.

## 판정 규칙

- `infeasible`: 알려진 값이 최소조건보다 작거나 건물·수역과 겹치거나 필요한 반입점·도로가 없다.
- `conditional`: 알려진 실패는 없지만 도로 폭·상부 여유고·경사 등 필수 확인값이 결측이다.
- `feasible`: 모든 조건이 알려져 있고 요구조건을 충족한다.

결측을 0 또는 통과로 바꾸지 않는다. 현재 팩에는 도로 폭과 상부 여유고 자료가 없으므로 실제 지도 작업면은 대체로 `conditional`에서 시작한다. 향후 현장조사·상세설계 시스템이 이 두 값을 확인하면 `feasible`로 전환할 수 있다.

## 게임 진행 영향

1. 입찰 전에 작업면을 등록할 수 있다.
2. 등록된 작업면이 모두 `infeasible`이면 해당 공구 입찰을 시작할 수 없다.
3. 가능한 작업면이 여러 개면 `feasible`을 `conditional`보다 우선해 낙찰 장비에 배정한다.
4. 낙찰 후 다른 작업면을 선택하면 같은 장비 배정의 `workfrontId`와 판정을 갱신한다.
5. 현재 배정이 `infeasible`이면 월별 물리 공사는 `equipment-workfront-infeasible` 사유로 정지한다.
6. `conditional`은 현재 자료 한계 때문에 공사를 자동 정지시키지 않지만 조건 목록을 보고서에 남긴다.

## API

- 순수 판정: `assessEquipmentWorkfront(workfront, equipmentType)`
- 공정표 적용: `applyConstructionWorkfront(schedule, workfront, contractors, clock)`
- 게임 명령: `ManagementGame.applyConstructionWorkfront(scheduleId, workfront)`
- 시나리오 명령: `ScenarioRuntime.applyConstructionWorkfront(planId, workfront)`
- 평면 보고서: `ManagementGame.equipmentAssignmentReport(scheduleId?)`

## 검증

- 세 가지 판정 어휘와 결측 처리
- 불가능한 작업면만 있을 때 입찰 거절
- 가능한 대안 작업면의 낙찰 장비 자동 배정
- 장비 항목 안의 시공사·공구계약 ID
- 낙찰 후 불가능한 작업면 재배치 시 공사 정지
- 저장·불러오기 후 작업면·판정·장비 배정 유지

