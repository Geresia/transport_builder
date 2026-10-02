# 직통 서비스 경영 계약 v1

`transitline.through-service/1`은 지도 계약 `transitline.through-route-geometry/1`을 읽어 차량·인프라 호환, 소유자와 운행사 역할, 선로사용 계약 연결을 판정한다. 지도 형상을 바꾸거나 비용을 계산하지 않는다. 구현은 `engine/src/management/through-service.mjs`, 테스트는 `engine/test/through-service.test.mjs`에 있다.

## 입력

`createThroughService(input, context)`를 사용한다.

```js
input = {
  throughServiceId,
  status?,                 // draft 기본값
  operatorId,
  guestModelId,
  trainsPerHour,
  trackAccessAgreementIds?
}

context = {
  route,                   // ThroughRouteGeometry v1
  projects?,               // 플레이어 사업 상태·technicalProfileId
  infrastructureCatalog?, // 외부망/구간의 소유자·기술·상태·용량
  trackAccessAgreements?,
  playerOperatorId?        // "player" 기본값
}
```

`infrastructureCatalog[]`는 `legId`를 우선 키로 쓴다. 외부망은 `externalNetworkId`+`externalLineId`로도 찾을 수 있다. 항목은 `infrastructureOwnerId`, `technicalProfileId`, `status`, `capacityTrainsPerHour`를 제공한다. 팩의 외부망을 수정하거나 외부 회사의 전체 재무 상태를 만들지 않는다.

## 출력

- 식별·버전: `schema`, `contractVersion`, `throughServiceId`, `throughRouteId`, `routeGeometryRevision`
- 상태·운행: `status`, `guestModelId`, `trainsPerHour`, `operatorId`
- 역할: `payerOperatorId`, `payeeOwnerId`
- 연결: `legs[]`, `handoverIds[]`, `trackAccessAgreementIds[]`
- 판정: `assessment.verdict`, `violations[]`, `conditions[]`, `missingInputs[]`

각 `legs[]`에는 지도 연결 ID와 함께 `infrastructureOwnerId`, `operatorId`, `payerOperatorId`, `payeeOwnerId`, `technicalProfileId`, `vehicleProfileId`, `compatibility`, `infrastructureStatus`, `capacityTrainsPerHour`, `trackAccessAgreementId`가 들어간다.

`routeGeometryRevision`은 같은 `throughRouteId`의 내용이 바뀐 경우를 검출하기 위한 값이다. E2에서 저장된 서비스와 현재 지도 경로의 리비전을 비교한다.

## 소유자·운행사 대칭 구조

- 자기 선로를 자기가 운행하면 payer/payee는 `null`이다.
- 타사가 플레이어 선로를 운행하면 타사가 payer, 플레이어가 payee다.
- 플레이어가 외부 선로를 운행하면 플레이어가 payer, 외부 소유자가 payee다.

따라서 플레이어가 선로 소유자인 경우와 게스트 운행사인 경우를 별도 스키마로 나누지 않는다. 여러 소유자의 선로를 동시에 지나면 구간별 역할은 유지하지만 최상위 `payeeOwnerId`는 `null`이고 별도 정산이 필요하다는 조건을 남긴다.

## 4단계 판정

우선순위는 `impossible` → `unknown` → `conditional` → `possible`이다.

| 판정 | 의미 | 대표 사례 |
|---|---|---|
| `impossible` | 확인된 위반이 있음 | 미준공 계획선, 분리된 선로, 운행 시스템 불일치, 용량 초과, 잘못된 계약 ID |
| `unknown` | 기초 사실이 없어 판정 불가 | `physicalConnection:null`, 소유자·기술 프로필·사업·경로 리비전 미상 |
| `conditional` | 기술적 위반은 없지만 이행 조건이 남음 | 선로사용 계약 미체결, 용량 검증 필요, 복수 소유자 정산 분리 |
| `possible` | 확인된 위반·미상·조건이 없음 | 접속·기술·용량·권리 연결이 모두 확인됨 |

지도 `physicalConnection:null` 또는 `connectionState:"unknown"`은 `unknown`이다. `false`/`separated`만 `impossible`이다.

## 기술·상태 규칙

- 차량의 `VEHICLE_MODELS[guestModelId].profileId`와 각 인프라의 `TECHNICAL_PROFILES` ID가 같아야 한다.
- `planned` 구간은 아직 지어진 선로가 아니므로 운행 불가다.
- `existing` 구간은 연결 사업이 실제로 존재하고 `available`이어야 한다. 프로젝트 상태와 기술 프로필은 게임 상태가 권위 원천이다.
- `external` 구간은 읽기 전용 카탈로그가 소유자와 기술 프로필을 제공해야 한다.
- 외부 소유 구간은 운행사·소유자 역할이 맞고 활성 상태인 선로사용 계약을 연결한다. 중단·종료·만료 계약은 활성 권리로 인정하지 않는다.

## 범위 밖

비용, 사용료 단가, 현금, 수입, 점수는 이 계약에 없다. 실제 운행 정산, 계약 생성·해지, 게임 저장 컬렉션, 런타임 UI는 E2~R1에서 연결한다.

## ManagementGame 연결(E2)

- `createThroughService(route, input, infrastructureCatalog)`: 트랜잭션 안에서 판정하고 `throughServices[]`에 추가한다. ID를 생략하면 `through-service:<순번>`을 발급한다.
- `reassessThroughService(id, route, infrastructureCatalog)`: 같은 경로 ID만 허용한다. 리비전이 바뀌면 상태를 `assessed`로 되돌리며, 기존 리비전이라도 판정이 악화되면 승인을 해제한다.
- `approveThroughService(id)`: `assessment.verdict === "possible"`인 `assessed` 상태만 승인한다.
- `throughServiceReport(id?)`: 복제된 읽기 전용 보고를 돌려준다.

컬렉션과 다음 ID 순번은 기존 게임 스냅샷에 추가됐다. 해당 키가 없는 구저장본은 빈 배열·순번 1로 복원된다. 저장 스키마 버전은 그대로이며 이 API는 RNG, 원장, 현금과 선로사용 누계를 바꾸지 않는다.
