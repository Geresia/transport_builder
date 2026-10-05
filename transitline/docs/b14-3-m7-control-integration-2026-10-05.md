# B14-3 M7 장애 관제 후보 → 운행 엔진 연결

작성일: 2026-10-05  
대상: 경영·운행 엔진과 `transitline.railway-service-control-geometry/1`의 연결 작업자

## 구현 범위

`ScenarioRuntime.issueRailwayControlSelection()`은 M7의 공간 후보와 플레이어 선택을 받아 실제
`transitline.railway-control-order/1`을 발령한다. 지도 ID를 운행 ID로 추측하지 않고,
`transitline.rail-capacity-application/1`에 기록된 `railCapacitySectionId → trackSegmentId`
매핑만 사용한다.

현재 실행되는 후보는 다음 두 종류다.

- `partialSuspension`: 선택한 지도 구간을 실제 운행 선로 구간으로 변환해 운휴한다.
- `turnback`: 운휴 경계의 회차 후보가 플레이어 선택에 포함됐는지와 물리 접속 사실을 검사한다.

`detour`와 `evacuation`은 후보와 선택을 보존하지만 아직 열차 운행명령으로 실행하지 않는다.
우회는 타사 선로 계약·차량 기술호환·선로용량 판정이, 대피 접근은 사고 대응 자원 배정이 먼저 필요하다.

## 한 노선의 복수 잔존 운행구간

중간 구간이 끊기면 한쪽만 운행하는 것으로 축약하지 않는다. 관제명령의 `retainedServices[]`에
양쪽 운행구간을 각각 기록한다. 예를 들어 `A-B-C-D`의 `B-C`가 운휴하면 다음 두 운행이 남는다.

```text
A ─ B   [운휴]   C ─ D
└ 1번 잔존 운행 ┘       └ 2번 잔존 운행 ┘
```

경로탐색은 두 구간을 같은 노선 ID의 서로 끊어진 그래프로 만들고, 배차기는 두 구간에 각각 열차를
출고한다. 열차는 출고 시점의 `serviceStationIds`를 보존하므로 관제명령 발령 전에 이미 운행 중인
열차의 경로는 갑자기 바뀌지 않는다.

구버전 명령의 단일 `retainedStationIds`는 계속 읽는다. 새 명령도 첫 구간을 이 필드에 함께 기록해
구버전 보고 소비자와의 호환을 유지하지만, 새 코드는 반드시 `retainedServices[]`를 우선 사용한다.

## 안전 규칙

- 이벤트·운행노선·M7 geometry·M5 application의 ID와 revision이 모두 일치해야 한다.
- 선택한 부분운휴 후보는 현재 geometry에 실제로 존재해야 한다.
- 후보의 모든 `suspendedSectionIds`가 운행 선로에 정확히 하나씩 매핑돼야 한다.
- 운휴 범위에 실제 장애 선로가 포함돼야 한다.
- 잔존 구간의 내부 종점마다 플레이어가 회차 후보를 골라야 한다.
- `physicalAttachment: false`인 회차 후보는 사용할 수 없다.
- `physicalAttachment: null`은 안전으로 간주하지 않는다. 플레이어가
  `confirmUnknownPhysicalAttachment: true`를 명시한 경우에만 발령하며, 가정은 명령의
  `assumptions[]`에 남는다.
- 검증이 하나라도 실패하면 운행 상태·승객 경로·명령 시퀀스를 변경하지 않는다.

## 실행 API

```js
runtime.issueRailwayControlSelection({
  controlGeometry,
  controlGeometryRevision: controlGeometry.controlGeometryRevision,
  selection: {
    partialSuspension: [partialSuspensionCandidateId],
    turnback: [leftTurnbackCandidateId, rightTurnbackCandidateId],
  },
  confirmUnknownPhysicalAttachment: false,
});
```

M7 편집기 전체 문서를 가지고 있다면 `selectionsOf(doc)[eventId]`를 `selection`에 넘긴다.

## 검증

단위 테스트는 중간 구간 운휴 시 다음을 확인한다.

- 두 잔존 운행구간이 생성됨.
- 경로 그래프에서 운휴 경계가 끊기고 양쪽 내부 구간은 유지됨.
- 같은 배차 시각에 양쪽 구간으로 열차가 각각 출고됨.
- 회차 시설 ID가 해당 열차에 전달됨.
- stale revision, 분리된 회차시설, 미확인 접속의 무단 사용이 원자적으로 거절됨.
- 명령을 저장하고 복원해도 두 운행구간이 하나로 축약되지 않음.

