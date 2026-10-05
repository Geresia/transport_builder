# B15-E2 — 역 접근권 수요 런타임 연결

## 완료 범위

`ScenarioRuntime.applyStationDemandAccess(export)`가 지도 편집기의 원문 문서가 아니라 검증된 `transitline.station-demand-access-export/1`만 받는다. 팩 ID와 버전이 다르거나 계약 버전이 다르면 적용하지 않으며, 실패하면 운영 상태는 이전 스냅샷으로 돌아간다.

성공하면 운영 상태에 `transitline.station-demand-access-application/1`을 저장한다. 이 안에는 다음 두 층이 함께 있다.

- `access`: 지도에서 확정된 공간 사실의 복사본
- `assessment`: E1이 원본 CityPack 수요 파일에서 해석한 엔진 입력

`ScenarioRuntime.report().stationDemandAccess`와 `stationDemandAccessReport()`는 모두 복사본을 돌려준다. 통합 저장은 운영 상태 전체를 저장하므로 별도 저장 스키마 변경 없이 보존되며, 이전 저장본에는 이 필드가 없어도 `null`로 정상 복원된다.

## 의도적으로 하지 않은 일

- 기존 `accessLinks`, 승객 발생, 노선 탐색, 운임, 혼잡에 변경을 가하지 않는다.
- 지도 접근권 편집 문서의 저장은 지도 UI(M2)의 책임이다. 메인 통합 저장 봉투가 그 문서를 보관하고, 그 UI가 다시 export를 만들면 런타임은 위 API로 갱신한다.
- 접근권 중복 배분과 도보 길이→시간 변환은 B15-E3의 명시적 정책이다. E2는 `shared`를 배분하지 않고 `allocated: null`로 유지한다.

## UI 연결

```js
const accessExport = stationDemandAccessUi.output().export;
runtime.applyStationDemandAccess(accessExport);
```

지도 export가 바뀔 때 자동 적용하지 않는다. 플레이어가 적용을 누르거나, UI가 현재 export가 유효함을 보인 뒤 명시적으로 호출해야 한다. 그래야 편집 중인 경계가 조용히 운영 수요를 바꾸지 않는다.
