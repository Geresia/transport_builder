# B15-E1 — 역 접근권 수요 입력 판정

`engine/src/station-demand-access-assessment.mjs`는 B15-M1 지도 계약을 엔진 입력으로 해석한다. 지도는 숫자를 계산하지 않고, 이 모듈만 원본 CityPack의 수요 노드를 찾아본다. 이 단계는 승객을 만들거나, 운임·혼잡·경로를 계산하거나, 수요를 역에 배분하지 않는다.

## 안전 규칙

- `high` 또는 `medium` 품질이며 `individual-demand-node`, `point`, `node`, `building`, `parcel`, `block`, `mesh-250m`, `mesh-500m`으로 명시된 수요 출처만 사용할 수 있다.
- `municipality`, `ward`, `city`, `prefecture`, `district`, `centroid` 같은 거친 해상도와 품질 미상/low 출처는 `unknown`으로 남긴다. 따라서 현재 도쿄 시구 중심점 수요는 작은 역 접근권의 승객 수로 바뀌지 않는다.
- 접근권끼리 겹치면 각 노드는 `shared` 후보로만 남고 `allocated: null`이다. 비율 분할·중복 제거 정책은 다음 단계 B15-E3가 명시적으로 정한다.
- 접근권을 아직 안 그린 것(`not-drawn`)과, 그린 접근권 안에 수요 노드가 없는 사실(`empty`)을 구분한다.

## P0 보강: 0과 미상, 중복 주장

- 접근권을 아직 안 그렸으면 `not-drawn`이고 합계는 `null`이다.
- 접근권을 그렸더라도 출처가 저품질·거친 해상도라 노드가 보이지 않으면 `empty-unseen`, 합계는 `null`이다.
- 국소·확인된 출처에서 노드가 없을 때만 `empty-confirmed`와 `{ residents: 0, jobs: 0 }`이 된다.
- `catchmentOverlaps` 도형 기록만 믿지 않는다. 같은 `demandNodeId`가 서로 다른 `stationAccessId`의 평가에 나오면 `claimedByStationAccessIds`를 통해 반드시 `shared`로 바꾼다. 반대로 다각형이 겹쳐도 실제 노드가 한 역에만 있으면 그 노드는 단독이다.

## API

```js
assessStationDemandAccess({ stationDemandAccess, pack, demand: pack.demand })
```

입력 지도 내보내기는 `transitline.station-demand-access-export/1`이어야 하며 pack id/version이 일치해야 한다. 결과는 `transitline.station-demand-access-input/1`이고, 역별 `demandNodeInputs`, 독점·공유 후보 합계, 미상 사유와 배분 보류 상태를 낸다.

런타임 저장·보고 연결은 B15-E2에서 끝났다. 다음 단계 B15-E3가 실제 접근 시간과 수요 배분 정책을 명시적으로 선택한다.
