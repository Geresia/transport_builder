# B16-E2 런타임 서비스 계획 심사

`ScenarioRuntime.assessServicePlanTimetable(servicePlan, binding, input)`이 B16 지도 계획의 유일한 경영 진입점이다.

1. C1이 지도 계획과 명시적인 `binding.serviceId`를 확인한다.
2. E1이 차량·기술·편성·종착 설비의 준비도를 읽는다.
3. 상태가 `ready`일 때만 기존 B13 `assessOperationalRailwayTimetable`을 호출한다.

반환값은 `{ adaptation, timetable }`이다. `unknown`, `blocked`, `unsupported`에서는 `timetable`이 항상 `null`이고 게임 원장·시계·운행 상태를 바꾸지 않는다. `binding`은 M3 UI와 통합 저장이 보존할 플레이어 문서이며, 지도 계획 ID와 관리 서비스 ID를 자동 연결하지 않는다.
