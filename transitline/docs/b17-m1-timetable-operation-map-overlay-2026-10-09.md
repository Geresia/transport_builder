# B17-M1 — 시간표 실제 운행 지도

`railway-timetable-operation-view.mjs`와 `railway-timetable-operation-ui.mjs`는 개통된 시간표를 새로 계산하거나 실행하지 않는다. 이 화면은 이미 존재하는 `runtime.railwayTimetableReport()`, 운행선의 `timetableDispatches`, 현재 열차와 역 위치를 읽기 전용으로 표시한다.

- 선로는 `line.timetableDispatches.*.timetableId`가 가리키는 시간표일 때만 연결한다. 노선 이름·표시 이름으로 연결하지 않는다.
- 활성, 승인됨, 심사됨, 철회됨, 대체됨을 서로 다른 선과 색으로 보인다. 활성 시간표는 굵게 보인다.
- 실제 운행 중 열차는 엔진의 `serviceStationIds`, `segIndex`, `dir`, `t`에서 현재 위치를 보간해 표시하며, B17-E0가 남긴 `timetableId`와 `managementServiceId`를 그대로 쓴다.
- 시간표 기록, 역 위치, 열차 위치가 없으면 `null`/경고로 남기며 선이나 열차 위치를 만들어 내지 않는다.
- 선택은 강조만 바꾸고 저장·엔진 명령·경제·수요·지연 계산을 하지 않는다.

`main.mjs`는 시나리오 모드에서만 `#btn-timetable-operation` 버튼을 노출한다. 지도·시간표·열차가 틱에서 바뀔 때 기존 `refreshMapOverlay()` 흐름으로 화면도 다시 읽는다.
