# B8-3C 역 3D 설계변경·변경계약 경영 엔진

작성일: 2026-09-29
담당: Codex 경영 엔진

## 목적

3D 현장 편집기가 보내는 `transitline.site-design-edit/1`을 역 시공 패키지의 원본에 바로 덮어쓰지 않고, 재설계·재견적·승인 절차를 거쳐 반영한다. 지도와 3D 편집기는 공간 형상과 충돌 사실을 제공하고, 비용·공기·계약·자금 약정은 경영 엔진만 계산한다.

## 변경안 계약

경영 엔진의 변경안 스키마는 `transitline.station-design-change/1`, `contractVersion: 1`이다.

주요 필드는 다음과 같다.

- 식별: `id`, `packageId`, `projectId`, `stationSiteId`, `sessionId`
- 동시성: `baseRevision`, `proposedRevision`
- 상태: `proposed`, `approved`, `rejected`
- 입력: `designEdit`, 부모 지도에서 받은 `collision`
- 재설계 결과: `revisedDesign`, `estimateBefore`, `estimateAfter`
- 변경계약: `contractBefore`, `contractAfter`, `costDeltaP50`, `costDeltaP90`, `durationDeltaMonths`
- 심사: `violations`, `conditions`

역 패키지는 `designRevision`, `geometryRevision`, `designChanges[]`를 가진다. 신규 패키지의 최초 revision은 `station-design:<packageId>:0`이다. 기존 저장본에는 해당 필드가 없어도 읽을 수 있으며, 처음 변경안을 만들 때 기본 revision을 보충한다.

## 처리 순서

1. `SiteDesignEdit`이 `submitted`인지 확인한다.
2. `stationSiteId`와 현재 역 패키지가 같은지 확인한다.
3. `baseRevision`과 현재 `geometryRevision`이 같은지 확인한다.
4. 같은 세션의 중복 제출과 승인 대기 중인 다른 변경안을 차단한다.
5. 본체 길이·폭·깊이와 출입구 이동을 복제된 설계에만 적용한다.
6. `estimateStationConstruction()`으로 역 공사비 P50/P90와 공기를 다시 계산한다.
7. 기존 낙찰가가 기존 원가에 적용했던 계약 가격 비율을 새 원가에 적용해 변경계약 금액을 산정한다.
8. 승인 전까지 역 원본, 프로젝트 총사업비, 현금, 자금 약정, 공정표는 변경하지 않는다.
9. 승인 시 한 거래 안에서 역 설계·낙찰계약·프로젝트 총사업비·역 상세대체액·자금 약정·통합 공정표·revision을 갱신한다.
10. 어느 단계에서든 오류가 발생하면 `ManagementGame.transact()`가 전체 상태를 복원한다.

거절된 변경안은 같은 3D 세션에서 형상을 고쳐 다시 제출할 수 있다. 승인 대기 중이거나 이미 승인된 같은 세션의 중복 제출만 차단한다.

## 3D 형상과 역 설계 변환

- 편집 본체 길이는 `구조 승강장 길이 + 20m`로 변환한다.
- 편집 본체 폭에서 선로 건축한계 폭을 제외한 나머지를 기존 승강장 폭 비율에 따라 배분한다.
- 완성 승강장보다 짧은 본체나 최소 승강장 폭을 만족하지 못하는 본체는 거부한다.
- 지상역은 깊이 0만 허용한다.
- 고가역의 음수 깊이는 굴착 깊이가 아니라 지상 선로 높이로 바꾸며, 공사 견적의 깊이는 0으로 둔다.
- 지하역은 음수 깊이를 거부한다.
- 출입구 이동·추가·삭제를 반영한다. 기존 출입구 이동·삭제는 ID가 일치해야 하고 최소 한 개의 출입구를 유지해야 한다.
- 작업구·작업장 폴리곤 변경을 반영한다. 선택된 작업장의 면적이 바뀌면 토지·사용권 면적과 재견적에도 반영한다.

## 충돌 검토

경영 엔진은 충돌을 자체 계산하지 않는다. 부모 지도에서 받은 `transitline.site-design-collision-result/1`만 읽는다.

- 본체 또는 변경한 출입구에 `true`가 하나라도 있으면 승인 불가다.
- 본체나 변경한 출입구 결과가 `null` 또는 누락이면 검토 미완료로 승인 불가다.
- 모든 대상이 명시적으로 `false`일 때만 승인할 수 있다.

따라서 결측을 충돌 없음으로 바꾸지 않는다.

## 경영 상태 갱신

승인 시 다음 상태가 함께 변경된다.

- `StationDeliveryPackage.design`, `estimate`, `awardedBid`
- `designRevision`, `geometryRevision`, `designChanges[]`
- 프로젝트에 내장된 같은 역 패키지 사본
- `project.estimate.totalP50`, `totalP90`, `durationMonths`
- `stationDetailReplacement.awardedP50/P90`, `deltaP50/P90`
- `construction:<projectId>` 자금 약정의 원금과 잔액
- 통합 공정표의 해당 `station-package` 작업 기간과 후속 공정 예측

승인 자체는 즉시 현금을 지급하지 않는다. 증가한 공사비는 기존 프로젝트 공사 약정에 추가되고 이후 기성 지급 과정에서 지출된다. 가용 현금이 부족하면 승인 전체가 취소된다.

## 공개 API

`ManagementGame`:

- `requestStationDesignChange(packageId, { designEdit, collisionResult })`
- `approveStationDesignChange(packageId, changeId)`
- `rejectStationDesignChange(packageId, changeId, reason)`
- `stationDesignChangeReport(packageId?)`

`ScenarioRuntime`:

- `stationDesignRevision(packageId)`
- `requestStationDesignChange(planId, packageId, input)`
- `approveStationDesignChange(planId, packageId, changeId)`
- `rejectStationDesignChange(planId, packageId, changeId, reason)`

## 현재 한계

- 역 구조형식, 승강장 배치, 차량 편성 자체를 3D 편집기에서 바꾸는 기능은 아직 없다.
- 본체 회전·이동은 공간 충돌과 원본 형상에는 기록되지만 현재 공사비 공식에는 방향·좌표별 가산 항목이 없다.
- 고가 높이는 저장하지만 기존 역 공사비 공식에는 고가 높이별 비용 계수가 없다.
- 조건부 설계는 조건 목록과 함께 승인할 수 있다. 확정 위반과 공간 충돌은 승인할 수 없다.

## 테스트

`engine/test/station-design-changes.test.mjs`가 다음을 검증한다.

- 변경안 생성 전후 원본·계약·현금·공정표 불변
- 승인 시 비용·계약·약정·공정표·revision 동시 갱신
- 취소, 오래된 revision, 다른 역, 중복 세션 거부와 ID 비소모
- 거절 후 같은 3D 세션에서 수정·재제출
- 실제 충돌 승인 차단과 거절의 무변경성
- 충돌 결과 누락 승인 차단
- 가용 현금 부족 시 전체 원자적 롤백
- 고가역 음수 깊이의 선로 높이 변환
- 저장·불러오기 후 revision, 변경 이력, 다음 ID 유지
