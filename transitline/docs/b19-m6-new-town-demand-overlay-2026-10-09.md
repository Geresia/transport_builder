# B19-M6 신도시 개발·승인 수요 원천 지도 오버레이 (2026-10-09)

지도 위에서 신도시 **단계(phase)마다** 엔진이 가진 사실을 그대로 보여 주는 읽기 전용 오버레이입니다. 수요·인구를 계산하지 않고, 아무것도 고치거나 승인하거나 전달하지 않습니다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/new-town-demand-overlay-view.mjs` | 순수 모델 `buildNewTownDemandOverlayView` + 캔버스 그리기 `drawNewTownDemandOverlay` |
| `engine/src/map/new-town-demand-overlay-ui.mjs` | `mountNewTownDemandOverlay` (캔버스 레이어 + 패널, `createShell` 사용) |
| `engine/test/new-town-demand-overlay.test.mjs` | 12개 테스트 (실제 ScenarioRuntime + E2 후보 빌더 + 가짜 브라우저) |

수정하지 않은 곳: `main.mjs`, `index.html`, `style.css`, `management/**`, `scenario-runtime.mjs`. 아직 `main.mjs`에는 연결되지 않았습니다(호스트 연결은 별도 작업).

## Host integration update (2026-10-10)

`main.mjs` now mounts this overlay for scenario play and exposes the **신도시
수요 현황** toggle. The host supplies the current M2 geometry export, E1
development records, E2 candidates built from each current lifecycle hook,
E4 intake records, and E5 explicit-source records. It refreshes with the map
overlay. This remains read-only: toggling, refreshing, selecting, or drawing
the overlay does not issue a runtime command, alter B15 links, or write a save
field.

## mount API

```js
const overlay = mountNewTownDemandOverlay({
  canvas, projection, pack,
  getGeometryExport,   // B19-M2: 지도 geometry export
  getDevelopments,     // B19-E1: runtime.newTownDevelopmentReport()
  getCandidates,       // B19-E2: 개발마다 buildNewTownDemandCandidates({hooks, geometry})
  getIntakes,          // B19-E4: runtime.newTownDemandIntakeReport(null, {geometry})
  getSources,          // B19-E5: runtime.newTownExplicitDemandSourceReport({geometry})
  onChange, enabled = true, autoRefreshMs = 250,
});
overlay.output();   // { view, selected, warnings }
overlay.refresh(); overlay.select(developmentId, phaseId); overlay.deselect();
overlay.setEnabled(bool); overlay.destroy();
```

- 입력은 모두 getter가 건네는 평범한 객체입니다. 마운트는 엔진·runtime을 부르지 않고, 명령(command)이 없고, 저장소·시계·난수를 쓰지 않습니다.
- 유일한 조작은 "지도에서 강조"/"선택 해제"(Esc 포함)이며, 이는 보기 상태일 뿐 결정이 아닙니다.
- getter가 던지거나 null을 주면 빈 값으로 두고 `input-unreadable` 경고를 냅니다.
- 이벤트: `transitline:new-town-demand-overlay` (detail = `output()`).

## 단계마다 보이는 사실

1. **생애주기**: 개발 상태 / 단계 상태 (E1).
2. **지도 일치**: `current` / `stale` / `inactive` / `other-pack` / `unknown` + 이유 (M2 geometry 대 E1 기록 비교).
3. **후보** (E2): candidateId, 입력 완전성, `eligibleForB15`(true / false / **null=미상**), 명시 사실 건수. 후보가 없으면 "후보 없음 — 입주 사실이 기록되지 않음".
4. **승인 기록** (E4): none / pending / accepted / held / rejected / stale / revoked, 근거 검증(current/unverified/stale)과 이유, 철회된 이전 기록 id.
5. **B15 입력 원천** (E5): `전달됨`은 원천이 적용되어 있고 standing이 current일 때만. 아니면 `전달 안 됨 — 원인 <코드>`.
   - 원인 코드 예: `candidate-not-eligible:null`, `intake-not-accepted:<state>`, `source-not-created`, `source-stale`, `source-withdrawn`, `geometry-<status>`.
6. **명시 수치**: 단계를 선택했을 때만, 플레이어가 적은 그대로 한 건씩 `residents 120 · jobs 0`. 합계·예측·환산 없음. 선택하지 않으면 건수만 표시.

## 그리기 규칙

- 면 채움 색 = 승인 기록 상태(대기/승인/보류/거절/낡음/철회). 외곽선 = 지도 일치 상태. 속이 빈/찬 표식 = 원천이 만들어졌는지.
- **색은 상태를 구분할 뿐 좋고 나쁨을 뜻하지 않습니다.** 인구·수요 수량은 원 크기나 색 농도에 전혀 쓰이지 않습니다(수량 1과 987654321이 같은 픽셀을 그리는 것을 Chrome에서 확인).
- stale·revoked·withdrawn·inactive는 숨기지 않고 **채움을 절반으로 줄여 흐리게** 그립니다.
- 지도에 매칭되지 않는 승인 기록/원천은 버리지 않고 `intake-not-on-the-map` / `source-not-on-the-map` 경고로 남깁니다.

## 호스트 연결 시 주의 (다음 작업)

- 후보는 호스트가 개발마다 E2 빌더로 계산해 `getCandidates`로 줍니다. 이 모듈은 빌더를 부르지 않습니다.
- 이 오버레이는 B15 수요 노드를 바꾸지 않습니다. "전달됨"은 E5 원천 기록이 current라는 뜻이며, B15 모델은 마운트 때 한 번 만들어지므로(`main.mjs`) 실제 반영 시점은 B20 감사 문서의 경계를 따릅니다.

## 검증

- `node --test test/new-town-demand-overlay.test.mjs`: 12/12.
- 변이 검사 10건(V1–V10) 모두 테스트가 잡아냄, 원본 복원.
- 실제 headless Chrome(HeadlessChrome 154) 21/21: 실제 `<canvas>`에서 `getImageData`로 상태별 색·흐림 확인, 패널 문구, 선택/Esc, 켜기/끄기/destroy, 엔진 snapshot 불변, 수량 1과 987654321이 같은 픽셀, storage·timer·console error 0건.
- 전체 `npm test`: 2019개 중 2017 통과 / 0 실패 / 2 건너뜀.

## 한계

- 단계 다각형이 geometry export에 없으면 그리지 못하고 `phase-polygon-unknown` 경고만 냅니다.
- 라벨은 단계 대표점(`labelAt`)에 놓이며 겹침 회피는 하지 않습니다.
