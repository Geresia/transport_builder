# 직통운행 지도 표시 계약 (경영 엔진 보고 → 지도)

직통 서비스 하나를 지도에 **읽기 전용**으로 보여 주는 모델과 렌더러다. 직통 경로 전체, 계획선·자기 기존선·외부 철도 구간의 구분, 구간별 소유자와 운행사, 구간 경계, 서비스 상태, 경영 엔진이 낸 판정, 최근 운행 실적, 지도 시뮬레이션이 보고하는 열차 위치를 표시한다.

지도는 **표시만** 한다. 가능 여부·비용·현금·수익·운임·정산을 계산하지 않고, 서비스나 정산 상태를 바꾸지 않으며, B12-4 정산 API를 호출하지 않는다. 판정과 보고값은 경영 엔진이 낸 그대로 읽는다. 이 코드는 `management`를 import하지 않고 파일·저장소·네트워크에 접근하지 않는다(테스트가 검사). 결측·ID 규칙은 [through-route-contract.md](through-route-contract.md)와 같다.

메인 화면 연결, 직통 서비스 생성·승인·중단 UI, 운임·개조·정산 UI는 이 범위가 아니다(Codex).

## 코드 위치

| 파일 | 역할 |
|---|---|
| `engine/src/map/through-operation-view.mjs` | `buildThroughOperationView`, `drawThroughOperationOverlay`, `renderThroughOperationPanel`, `renderThroughOperationLegend` |
| `engine/test/through-operation-view.test.mjs` | 계약 테스트와 예제 검증 |
| `scripts/build-through-operation-map-examples.mjs` | 예제 생성(`npm run through-operation-map-examples`) |
| `packs/<id>/through-operation-map-examples/*.view.json` | 예제 11개(합성 보고서) |

## 입력과 실제 코드에 맞춘 조정

```js
buildThroughOperationView({
  route,                // transitline.through-route-geometry/1
  service,              // transitline.through-service/1
  settlements = [],     // transitline.through-operating-settlement/1 목록
  liveActuals = null,   // 지도 시뮬레이션이 넘기는 선택 입력
  playerOperatorId = "player"
})
```

| 항목 | 조정 | 이유 |
|---|---|---|
| `service` 구간 정보 | 구간별 소유자·운행사·호환·선로사용 계약은 지도가 만들지 않고 `service.legs[]`를 **`legId`로** 읽는다 | 실제 `through-service/1`이 이미 구간별 `infrastructureOwnerId`, `operatorId`, `compatibility`, `trackAccessAgreementId`, `infrastructureStatus`를 담는다. 지도가 다시 판정하면 경영과 어긋난다 |
| `settlements` | **금액은 읽지도 복사하지도 않는다.** 운행일·승객·열차-km·차량-km·선로사용별 열차-km/정차수만 쓴다 | 실제 정산 객체에는 `money`, `*JPY`, `fareAllocations`가 섞여 있다. 지도는 비용·수익을 다루지 않으므로 금액은 경영 화면이 `settlementId`로 보여 준다 |
| `operatingTotals` | 서비스의 `throughOperatingTotals`에서 `days`, `passengers`, `trainKm`만 읽고 `lastThroughOperatingDay`를 붙인다. 정산 목록을 다시 더하지 않는다 | 합계는 경영 엔진이 이미 누적한다. 최근 24건만 받는 목록을 더하면 거짓 합계가 된다. 서비스에 없으면 `null` |
| `liveActuals.trains[]` | 제시된 형태 그대로. `direction`은 `"forward"`(구간 진행 방향) 또는 `"reverse"`만 인정 | 방향 없는 `progress`로는 어느 끝에서 출발했는지 몰라 위치를 만들면 가짜 위치가 된다 |
| 판정 | `service.assessment.verdict`와 `violations/conditions/missingInputs`를 그대로 읽는다. 구간·경계 문제는 `leg:<legId>:…`, `handover:<handoverId>:…` 접두로 연결한다 | 경영 엔진의 이슈 문자열 규칙 |
| 서비스·경로 불일치 | 예외를 던진다(`error.code`) | 같은 직통 경로가 아니면 표시할 의미가 없다. 선택 입력의 오류는 예외가 아니라 경고 |

예외 코드: `route-invalid`, `service-invalid`, `route-service-mismatch`(`service.throughRouteId !== route.throughRouteId`).

## 출력 `ThroughOperationMapView`

`schema: "transitline.through-operation-map-view/1"`, `contractVersion: 1`.

| 분류 | 필드 |
|---|---|
| 식별 | `throughServiceId`, `throughRouteId`, `routeGeometryRevision`(경로), `serviceRouteGeometryRevision`(서비스가 판정한 때), `stale`, `name`(경로 이름, 표시용) |
| 상태·판정 | `status`, `statusLabel`, `assessmentVerdict`, `assessmentVerdictLabel`, `assessment{violations,conditions,missingInputs}` — 경영 엔진 값 그대로 |
| 역할 | `operatorId`, `playerOperatorId`, `trainsPerHour`, `retrofitProgramIds` |
| 구간 | `legs[]` |
| 경계 | `handovers[]` |
| 열차 | `trainMarkers[]` |
| 실적 | `latestSettlement`, `operatingTotals`, `live` |
| 자료 | `warnings[]`, `unknown[]`, `unknownReasons` |

### `legs[]` (경로의 `sequence` 순)

`legId`, `sequence`, `sourceKind`(`planned`/`existing`/`external`), `sourceKindLabel`, `connectedPlanId`, `connectedProjectId`, `externalNetworkId`, `externalLineId`, `stationIds`, `alignment`, `lengthMeters`, `infrastructureOwnerId`, `operatorId`, `role`, `compatibility`, `technicalVerdict`, `infrastructureStatus`, `capacityTrainsPerHour`, `trackAccessAgreementId`, `agreementUsage{trainKm,stationStops}`, `issues[{kind,code}]`, `conditional`, `stateKey`, `display`, `style`, `unknown[]`, `unknownReasons`.

- `alignment`은 경로가 준 선형이고, 외부 구간처럼 없으면 **`null`**이다. 임의의 직선으로 잇지 않고 `display: "none"`, `style.key: "no-alignment"`, 경고 `leg-not-drawable`로 알린다.
- `infrastructureOwnerId`와 `operatorId`는 서비스 구간 → 경로 구간 순서로 읽는다. 없으면 `null`+사유다.
- `compatibility`는 서비스가 낸 문자열(`compatible`/`incompatible`/`unknown`/…) 그대로이고, 서비스에 구간이 없으면 `null`이다("호환"으로 채우지 않는다).

### 구간 스타일

해석 순서는 위에서 아래이며 처음 맞는 것이 이긴다. `alignment`가 없는 구간은 마지막에 `no-alignment`로 덮는다(그려지지 않음. 원래 상태는 `stateKey`에 남는다).

| 순서 | `style.key` | 조건 |
|---|---|---|
| 1 | `terminated` | 서비스 `status: terminated` |
| 2 | `suspended` | 서비스 `status: suspended` |
| 3 | `impossible` | 구간 비호환(`compatibility: incompatible` 또는 기술 판정 `impossible`) 또는 **이 구간에 귀속된** 위반, 또는 구간·경계를 지목하지 않는 서비스 전체 위반이 있고 판정이 `impossible` |
| 4 | `unknown` | 구간 호환 미상, 소유자·운행사 미상, **이 구간에 귀속된** 누락 입력, 또는 구간·경계를 지목하지 않는 서비스 전체 누락이 있고 판정이 `unknown` |
| 5 | `player-owned-player-operated` | 소유자·운행사 모두 플레이어 |
| 5 | `external-owned-player-operated` | 타사 소유, 플레이어 운행 |
| 5 | `player-owned-external-operated` | 플레이어 소유, 타사 운행 |
| 5 | `external-owned-external-operated` | 타사 소유, 타사 운행 |
| 마지막 | `no-alignment` | 선형이 없는 구간 |

구간 색이 서비스 판정을 그대로 따르지 않는 이유: 분리된 경계 하나 때문에 두 구간이 모두 빨강이 되면 어디가 문제인지 알 수 없다. 서비스 판정(`assessmentVerdict`)은 항상 그대로 보이고, 분리된 경계는 **경계 마커**가 빨강 ✕로 표시한다. 조건부(`conditional`)는 구간 색을 바꾸지 않고 `conditional: true`와 `issues`로 패널에 표시한다.

### `handovers[]`

`handoverId`, `sequence`, `fromLegId`, `toLegId`, `stationId`, `physicalConnection`, `connectionState`, `gapMeters`, `at`, `atBasis`, `fromEnd`, `toStart`, `issues`, `style`, `unknown[]`, `unknownReasons`.

- **`physicalConnection: null`은 미상이며 `false`가 아니다.** `connectionState`는 `true → joined`, `false → separated`, 그 밖(`null`, 값 없음) → `unknown`이다. 세 상태는 색과 글리프가 모두 다르다(●녹색 / ✕빨강 / ?황색).
- `at`(마커 위치)은 경로가 준 `location`이 있으면 그것, 없으면 **앞 구간 선형의 끝**, 그것도 없으면 **뒤 구간 선형의 시작**이다. `atBasis`가 어느 쪽인지 말해 준다. 어디서도 구할 수 없으면 `null`+`handover-position-unknown` 경고이며 위치를 만들지 않는다.
- 분리된 경계는 앞 구간 끝과 뒤 구간 시작이 둘 다 있을 때만 그 사이에 점선을 그어 틈을 보인다. 외부 구간 쪽에는 점이 없어 잇지 않는다.

### `trainMarkers[]`

`trainRunId`, `throughServiceId`, `legId`, `progress`, `direction`, `delayMinutes`, `location`, `locationBasis`(`reported`/`interpolated`/`null`), `drawable`, `unknown[]`, `unknownReasons`.

- 위치는 **보고된 `location`**이거나, **구간 선형이 있고 `progress`(0~1)와 `direction`이 있을 때** 선형 길이를 따라 결정론적으로 보간한 값(`interpolated`)뿐이다. 그 밖에는 `null`이다(`no-location-and-no-progress`, `direction-unknown-for-progress`, `leg-has-no-alignment`). 가짜 위치를 만들지 않는다.
- 다른 서비스의 열차, 모르는 `legId`, 잘못된 진행률·방향·위치, 이름 없는 열차는 제외하고 경고한다(`train-other-service`, `train-leg-unknown`, `train-progress-invalid`, `train-direction-invalid`, `train-location-invalid`, `train-invalid`). 같은 `trainRunId`가 둘이면 둘 다 제외한다(`duplicate-train-run`). 잘못된 진행률은 0~1로 자르지 않고 `null`이다.

### `latestSettlement`, `operatingTotals`, `live`

- `latestSettlement`: 이 서비스의 유효한 정산 중 **운행일이 가장 큰 것**(같은 날이면 `settledAtMinute`, 그다음 `settlementId`)이다. 없으면 `null`+`no-settlement-for-service`이며 이는 정상 상태다. 다른 서비스의 정산·형식이 틀린 정산은 제외하고 경고한다(`settlement-other-service`, `settlement-invalid`). 같은 날이 여럿이면 `settlement-duplicate-day`. 필드는 `settlementId`, `operatingDay`, `settledAtMinute`, `passengers`, `trainKm`, `carKm`, `trackAccessUsage[{agreementId,infrastructureOwnerId,trainKm,stationStops}]`뿐이다.
- `legs[].agreementUsage`: 최신 정산의 선로사용 열차-km·정차수를 구간의 `trackAccessAgreementId`로 연결한 값이다.
- `live`: `liveActuals`의 운행일·서비스 분·승객·열차-km·선로사용을 **표시용으로만** 담는다. 정산이 아니며 합산하지 않는다.

### 경고 코드

`route-revision-mismatch`(서비스 판정 이후 경로가 바뀜. 모델은 현재 경로로 그리고 `stale: true`), `service-leg-not-on-route`, `route-leg-not-in-service`, `handover-ids-mismatch`, `handover-position-unknown`, `leg-not-drawable`, 정산·열차 경고 위 참조.

## 결측

값을 알 수 없으면 `null`, 이름을 `unknown[]`에, 사유를 `unknownReasons`에 둔다. `0`, `false`, `[]`로 바꾸지 않는다. 최상위·구간·경계·열차 모두 `unknown[]`과 `unknownReasons`가 대응한다(테스트가 검사). 사유 예: `service-has-no-status`, `service-has-no-assessment`, `no-settlement-for-service`, `service-has-no-operating-totals`, `owner-not-stated`, `leg-not-in-service`, `external-location-basis:demand-node`, `no-location-and-no-adjacent-alignment`.

## 렌더링 API

| 함수 | 동작 |
|---|---|
| `drawThroughOperationOverlay(ctx, model, screen)` | `screen([lon,lat]) → [x,y]`. 선형이 있는 구간만 외곽선+본선으로 그리고, 경계 마커와 **위치가 있는** 열차만 그린다. 외부 구간은 그리지 않는다 |
| `renderThroughOperationPanel(container, model)` | 상태·판정, 구간별 소유→운행·호환·계약, 구간·경계 이슈, 선형 없음·미상·재판정 경고, 최근 정산·누계·실시간, 열차를 쓴다. `model`이 `null`이면 숨긴다 |
| `renderThroughOperationLegend(container)` | 구간 스타일 9종, 경계 3종, 열차 표시를 보여 준다 |

DOM에는 `createElement`, `className`, `textContent`, `append`, `replaceChildren`, `hidden`, `style`만 쓴다. 플레이어가 입력한 이름(경로 이름, 운영사 ID 등)은 전부 `textContent`로만 들어가므로 HTML이 삽입되지 않는다(테스트가 `<script>` 문자열로 검사한다. `innerHTML` 같은 API는 코드에 없다).

## 예제

모든 예제 파일의 `source.synthetic`은 `true`이고 `source.note`에 합성 보고서임을 적었다. 서비스·정산·열차는 손으로 쓴 값이며 경영 엔진이 계산한 것이 아니고, 금액 필드는 넣지 않았다. 경로는 같은 팩의 실제 직통 경로 예제(`through-route-examples`)를 읽는다. 각 예제의 `source.input`에 입력이 그대로 저장되어 재생성할 수 있다.

| 팩 | 파일 | 사례 |
|---|---|---|
| tokyo | `01-approved-normal-split-joined` | 승인·정상 운행, 최근 정산 3건, 보고된 열차 위치 |
| tokyo | `02-external-connection-unknown` | 외부 철도 구간 포함, 접속 미상, 선로사용 계약 조건 |
| tokyo | `03-external-no-alignment-no-train-position` | 외부 구간 선형·열차 위치 모두 미상, 계획 구간 열차는 보간 |
| tokyo | `04-physically-separated` | 물리적으로 분리된 경로 |
| example-radial | `01-approved-recent-settlement` | 승인, 최근 정산 존재 |
| example-radial | `02-track-access-condition-unmet` | 선로사용 계약 조건 미충족(타사 소유 구간) |
| example-radial | `03-physically-separated` | 분리된 경로 |
| example-radial | `04-live-trains-reported-and-interpolated` | 보고된 위치와 보간된 위치(정방향·역방향) |
| example-corridor | `01-technically-incompatible` | 기술 호환 불가능 |
| example-corridor | `02-suspended` | 운행 중단 |
| example-corridor | `03-terminated` | 서비스 종료 |

## 한계

- 합성 보고서뿐이다. 실제 경영 엔진 출력과의 연결과 `liveActuals` 공급은 Codex 통합 범위다. 단, 테스트는 실제 `calculateThroughOperatingSettlement` 결과가 입력으로 받아들여지는지 확인한다.
- 외부 구간은 기존망 자료에 선형이 없어 지도에 그려지지 않는다. 경계 마커와 패널 경고로만 표현한다.
- 열차 위치의 `progress`는 "구간 선형을 진행 방향으로 지난 비율"로 가정한다. 시뮬레이션의 실제 정의와 맞는지는 연결할 때 확인해야 한다.
- 화면 좌표 변환·확대에 따른 마커 크기, 라벨 겹침 처리는 하지 않는다. 실제 브라우저 연결은 이번 범위가 아니다.
