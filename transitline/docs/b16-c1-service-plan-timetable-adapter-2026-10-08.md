# B16-C1 서비스 계획 → 기존 B13 시간표 어댑터

`service-plan-timetable-adapter.mjs`는 지도 `ServicePlanGeometry`를 기존 B13 시간표 엔진의 입력으로 **안전하게 번역할 수 있는지** 확인한다. 시간표·최소 시격·선로 용량·충돌은 계산하지 않는다.

중요한 경계는 두 ID다. `servicePlanId`는 플레이어가 만든 지도 설계 문서 ID이고, `binding.serviceId`는 이미 개통된 경영 서비스 ID다. 둘을 자동으로 같다고 보지 않는다. 호출자는 반드시 명시적으로 바인딩해야 한다.

현재 B13은 하나의 개통 서비스가 전체 운행선을 양방향으로 운행하는 단일 시간대만 받는다. 따라서 단축 운행, 편도 운행, 복수의 활성 시간대, stale 지도, 현재 application이 아닌 계획, 다른 실제 선로를 가리키는 계획은 B13 입력으로 변환되지 않는다. 이들은 데이터 손실을 동반하는 자동 변환 대신 `issues[]`와 `operationalRequest: null`로 남는다.

`prescreen`은 E1 결과를 읽기 전용으로 함께 제공한다. 차량·기술·차량 수·종착 설비의 unknown은 가능한 것으로 바꾸지 않는다. 이후 화면은 `status === "ready"`인 경우에만 `operationalRequest`를 `runtime.assessOperationalRailwayTimetable()`에 넘겨야 한다.
