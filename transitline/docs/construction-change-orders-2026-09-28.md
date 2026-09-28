# A7-3 설계변경·계약변경 경영 엔진 구현 보고서

- 기준일: 2026-09-28
- 통화·가격 기준: 2026년 일본 엔(JPY)
- 현재 적용 범위: A7 공구별 시공계약(`tunnel`, `cutCover`, `viaduct`, `systems`)
- 경계: 지도와 3D 화면은 편집 결과와 공간 리비전만 제공하며 비용·책임·공기는 경영 엔진이 결정한다.

## 플레이 흐름

```text
설계 편집안 제출
→ 원본/변경 리비전 검사
→ 잔여 계약물량 기준 변경견적
→ 발주자·시공사 책임 배분
→ 제안 / 책임분쟁
→ 승인 또는 반려
→ 계약금액·총사업비·현금약정·공정표 동시 갱신
```

제안만 만든 상태에서는 현금, 프로젝트 견적, 시공계약과 공정표가 바뀌지 않는다. 승인 명령 하나가 성공했을 때만 모든 상태가 함께 변경된다. 가용현금 부족이나 잘못된 공정 상태로 한 항목이라도 실패하면 거래 전체를 원상복구한다.

## 상태와 식별자

스키마는 `transitline.construction-change-order/1`이다. ID는 `construction-change-order:<sequence>`로 단조 증가하며 실패한 거래는 번호를 소비하지 않는다.

상태:

- `proposed`: 금액과 책임이 확정돼 승인·반려 가능
- `disputed`: 책임 주체가 미확정이라 승인 불가
- `approved`: 계약과 공정에 한 번 반영된 종결 상태
- `rejected`: 아무 회계·공정 영향 없이 반려된 종결 상태

같은 `(constructionSiteId, geometryRevisionBefore, geometryRevisionAfter)` 변경안을 두 번 만들 수 없다. 한 변경안이 승인되면 해당 공구의 현재 리비전은 `geometryRevisionAfter`가 되며, 예전 리비전을 기준으로 만든 병렬 변경안은 승인할 수 없다.

## 지원 변경 사유

- `owner-design-change`: 발주자 설계변경
- `contractor-proposal`: 시공사 시공성 제안
- `utility-conflict`: 지장물 충돌
- `unexpected-ground`: 예상 외 지반
- `safety-requirement`: 안전 요구 변경
- `community-agreement`: 주민·지자체 협의 반영
- `value-engineering`: 가치공학·원가절감

각 사유는 잔여 계약노출액에 적용하는 비용·불확실성·기간 계수가 다르다. 이 계수는 실제 법정 요율이 아니라 게임 밸런스 초기값으로 `REASON_TERMS` 한곳에 분리돼 있다.

## 견적 계산

```text
잔여 계약노출액 = 현재 공구 계약 P50 × (1 - 공구 진행률)
변경 P50 = 잔여 계약노출액 × 범위변화율 × 사유별 비용계수
변경 P90 = 변경 P50 × 사유별 불확실성계수
```

범위변화율은 -25%에서 +50%까지만 허용한다. 음수는 `value-engineering`에서만 가능하다. 금액은 백만 엔 단위로 반올림하고, 기존 계약금액 자체는 다시 반올림하지 않아 이미 확정된 낙찰가를 훼손하지 않는다.

## 책임 분담

책임 어휘:

- `owner`: 발주자 100%
- `contractor`: 시공사 100%
- `shared`: 기본 50:50
- `force-majeure`: 기본 50:50
- `disputed`: 금액 분담 미확정, 승인 불가

예상 외 지반의 공동책임은 공구 계약의 `ownerGroundRiskShare`를 사용한다. 책임분쟁은 별도 명령으로 `owner`, `contractor`, `shared`, `force-majeure` 중 하나로 해결해야 `proposed`가 된다.

## 승인 효과

승인하면 다음 값이 같은 거래 안에서 갱신된다.

- 공구 계약 `currentPriceP50`, `priceP90`, `durationMonths`
- 계약의 `changeOrders[]`
- 프로젝트 `estimate.totalP50`, `estimate.totalP90`
- A7 기존 예정액 대체 집계
- 프로젝트 건설 현금 약정
- 연결된 미완료 통합 공정 작업의 추가 지연
- 예상 개통월과 임계경로
- 공구의 현재 승인 공간 리비전

이미 지급한 금액은 환불하거나 다시 계산하지 않는다. 원가절감안도 프로젝트 총사업비를 기지급액 아래로 낮출 수 없다.

## 3D 편집 계약

선택적으로 `transitline.site-design-edit/1`을 변경안에 첨부할 수 있다.

- `status`가 `submitted`인 편집안만 접수
- `baseRevision`이 `geometryRevisionBefore`와 일치해야 함
- `draft`나 오래된 리비전은 계약변경으로 접수하지 않음
- 편집안의 형상 자체로 금액을 임의 계산하지 않으며, 승인된 공간 리비전과 변경 범위만 계약에 사용

현재 A7-3은 토목·시스템 공구 계약에 적용된다. Claude 2의 역 3D 편집 결과를 역별 시공계약에 직접 적용하는 어댑터는 B8 통합에서 `StationDeliveryPackage` 재견적 규칙과 함께 연결해야 한다.

## API

- `proposeConstructionChangeOrder()`
- `resolveConstructionChangeResponsibility()`
- `approveConstructionChangeOrder()`
- `rejectConstructionChangeOrder()`
- `constructionChangeOrderSummary()`
- `ManagementGame.request/approve/rejectConstructionChangeOrder()`
- `ScenarioRuntime.request/approve/rejectConstructionChangeOrder()`
- `ScenarioRuntime.report().constructionChangeOrders[]`

## 검증 범위

- 제안 단계의 무변이
- 책임별 발주자·시공사 금액 배분
- 책임분쟁 해결 전 승인 차단
- 승인 시 계약·사업비·약정·공정표 동시 변경
- 반려 시 금액·공정 무변경
- 같은 리비전 중복 견적 차단
- 병렬 편집안의 오래된 기준 리비전 차단
- 제출된 3D 편집안만 접수
- 가치공학 절감액 반영
- 가용현금 부족 시 전체 거래 롤백
- 저장·복원과 단조 증가 ID

## 다음 단계

1. 역 3D 편집 결과를 `StationDeliveryPackage` 재설계·재견적에 연결
2. 발주자·시공사 클레임, 협상, 중재
3. 승인 전 공사 계속·부분중지·전면중지 선택
4. 설계변경 이력을 3D 전후 비교 화면에 표시

