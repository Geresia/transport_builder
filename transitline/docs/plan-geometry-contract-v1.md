# PlanGeometry 계약 v1

이 문서는 지도 편집 영역과 건설·경제 엔진 사이의 유일한 쓰기 계약이다.
지도는 엔진 상태를 직접 수정하지 않고 `createMapEngineBridge()`의 명령만
호출한다.

## 입력

```json
{
  "schema": "transitline.plan-geometry/1",
  "contractVersion": 1,
  "planId": "tokyo-east-001",
  "name": "동부 신선",
  "coordinateReference": "EPSG:4326",
  "sourcePackId": "tokyo",
  "sourcePackVersion": "2026-09-25",
  "stationCandidates": [
    {
      "id": "station-a",
      "name": "서부역",
      "location": [139.7, 35.68],
      "structure": "surface",
      "depthMeters": 0,
      "platformType": "side",
      "platformLengthM": 100
    },
    {
      "id": "station-b",
      "name": "동부역",
      "location": [139.73, 35.68],
      "structure": "elevated",
      "depthMeters": 0,
      "platformType": "island",
      "platformLengthM": 100
    }
  ],
  "segments": [
    {
      "from": "station-a",
      "to": "station-b",
      "lengthMeters": 3200,
      "elevationStartMeters": 4,
      "elevationEndMeters": 12,
      "curveRadiusMeters": 400,
      "structureHint": "elevated",
      "constraintFlags": ["road-median"],
      "dataQuality": "high"
    }
  ],
  "accessLinks": [
    {
      "id": "access-a",
      "demandNodeId": "13101",
      "stationId": "station-a",
      "walkMinutes": 7
    }
  ]
}
```

## 필드 규칙

- 표준 식별자는 `schema: "transitline.plan-geometry/1"`이다.
- `contractVersion: 1`도 같은 버전의 숫자 별칭으로 허용한다. 둘 중 하나는 필수이며 다른 버전은 명시적으로 거절된다.
- `planId`는 지도 저장·재실행 후에도 유지되는 안정 ID다.
- 같은 `planId`의 내용이 달라지면 엔진이 버전을 1씩 올린다.
- 승인된 버전은 덮어쓰지 않는다. 변경안은 별도 계획으로 제출한다.
- 좌표 순서는 `[경도, 위도]`다.
- 길이와 고도는 미터, 곡선반경은 미터, 접근시간은 분이다.
- 접근 링크의 표준 역 참조는 `stationId`다. 초기 합성 입력의 `stationCandidateId` 별칭도 엔진이 호환한다.
- 자료가 없으면 숫자 `0`을 만들지 않고 필드를 생략한다.
- `dataQuality`는 `high`, `medium`, `low`, `unknown` 중 하나다.
- `structureHint`는 `surface`, `elevated`, `cut-cover`, `shield`,
  `deep`, `bridge`, `embankment`, `cutting` 중 하나다.
- 기본 개통기는 두 종점을 가진 하나의 비분기 경로만 받는다.

## 명령 순서

```text
submitPlan(planGeometry, technicalProfileId)
→ approvePlan(planRecordId)
→ createProject(planRecordId)
→ contractProject(projectId)
→ 월별 공정 진행
→ 차량·기지·통합시험 완료
→ commission({ projectId, serviceId })
```

## 반환 상태

| 상태 | 지도 표시 |
|---|---|
| `needs-information` | 자료보완 필요 |
| `rejected` | 건설 불가 |
| `assessed` | 기술검토 완료 |
| `approved` | 승인 |
| `in-project` | 사업화 완료 |
| `assets-available` | 공사·검사 완료 |
| `commissioned` | 영업운행 가능 |

프로젝트 오버레이는 `getProjectOverlay(projectId)`로 조회한다. 반환된
역과 구간의 상태만 지도에서 표현하고 지도 코드가 상태를 추정하지 않는다.

## 원자성

`commission()`은 역, 승강장, 선로, 접근 링크, 운행노선을 하나의 작업으로
등록한다. 하나라도 유효하지 않으면 경영 상태와 운행 상태가 모두 호출 전으로
복구된다. 공사 중인 프로젝트나 개통 준비가 끝나지 않은 서비스는 거절된다.
