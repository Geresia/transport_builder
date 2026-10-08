# B16-E3/M7 시간표 철회·대체 생애주기

기준 master `9bd3f59`. 변경 파일: `engine/src/management/railway-timetable.mjs`, `engine/src/management/game.mjs`, `engine/src/scenario-runtime.mjs`, `engine/src/railway-timetable-lifecycle-ui.mjs`, 테스트 `engine/test/railway-timetable-withdraw.test.mjs`(신규 15개)·`engine/test/railway-timetable-lifecycle-ui.test.mjs`(+11개). `main.mjs`·`index.html`·`style.css`는 수정하지 않았다.

## 왜 철회인가

재심사하면 예전 `assessed` / `approved` 시간표가 엔진에 남는다. 지우면 감사 이력과 저장 재현성이 깨지므로(ID가 재사용될 수도 있다) **삭제하지 않고 상태 전이로 관리**한다. 새 상태는 `withdrawn` 하나다.

## 상태 전이

```
assessed ──approve──▶ approved ──activate──▶ active ──(같은 요일 유형의 다른 시간표 활성화)──▶ superseded
   │                     │
   └──────withdraw───────┴──▶ withdrawn   (끝. 승인·개통·재철회 모두 거부)
```

| 현재 상태 | withdraw | approve | activate |
|---|---|---|---|
| `assessed` | **가능** | 가능(판정이 possible일 때) | 거부 |
| `approved` | **가능** | 거부 | 가능 |
| `active` | **거부** (`cannot be withdrawn from active`) | 거부 | 거부 |
| `superseded` | **거부** | 거부 | 거부 |
| `withdrawn` | **거부** (`cannot be withdrawn from withdrawn`) | 거부 | 거부 |

- **active는 철회하지 않는다.** 현재 규칙 그대로, 같은 `dayType`의 다른 시간표를 `activate`하면 기존 active가 `superseded`가 되고 서비스의 `activeTimetableId`가 새 것으로 바뀐다. 이 규칙은 바꾸지 않았다.
- 철회된 시간표는 대체(supersede) 대상이 아니다. 대체는 `active`만 건드리므로 `withdrawn` 기록은 한 바이트도 바뀌지 않는다(테스트).
- 철회는 서비스의 `activeTimetableId`, 지도/운영 상태, 현금, 난수를 건드리지 않는다.

## API

```js
game.withdrawRailwayTimetable(timetableId, { reason? })      // ManagementGame
runtime.withdrawRailwayTimetable(timetableId, { reason? })   // ScenarioRuntime: game에 그대로 위임
withdrawRailwayTimetable(timetable, atMinute, reason)        // management/railway-timetable.mjs 순수 전이 (index.mjs로 내보냄)
WITHDRAWABLE_RAILWAY_TIMETABLE_STATUSES                      // ["assessed", "approved"]
```

반환값은 철회된 시간표의 복사본. 시간표 객체에 다음이 **철회할 때만** 더해진다.

| 필드 | 뜻 |
|---|---|
| `status` | `"withdrawn"` |
| `withdrawnFromStatus` | 철회 직전 상태(`assessed` / `approved`) |
| `withdrawnAtMinute` | 게임 시계 분 |
| `withdrawalReason` | 선택. 1~200자 문자열(앞뒤 공백 제거). 비었거나 200자 초과, 문자열이 아니면 거부 |

심사 결과(`acceptedPaths`, `rejectedPaths`, `assessment`)와 `approvedAtMinute`는 그대로 남아 감사 기록이 된다. `railwayTimetableReport()`·`runtime.report().railwayTimetables`에 withdrawn 기록이 그대로 나오고, 이벤트 로그에 `railway-timetable-withdrawn`이 남는다.

## 트랜잭션·롤백

`ManagementGame.transact`로 실행한다. 실패(없는 ID, 철회 불가 상태, 잘못된 사유, 그리고 전이 뒤 원장 불변식 오류 같은 사후 실패)하면 `snapshot()` 전체가 되돌아간다 — 시간표 상태, 이벤트 로그, RNG 상태, ID 시퀀스(`nextRailwayTimetableSequence`) 모두. 테스트는 전이 뒤에 `ledger.assertInvariant`를 던지게 해서 실제 롤백을 확인하고, 이후 새 심사가 정확히 다음 ID를 받는지 본다.

## 저장·복원·기존 저장본

- 새 게임 수준 필드가 없다. `snapshot()` 구조는 그대로이고 기존 `railwayTimetables`에 철회 필드만 얹힌다.
- **철회하지 않은 시간표에는 철회 필드가 생기지 않는다.** 기존 저장본을 복원해 다시 저장해도 한 바이트도 달라지지 않는다(테스트가 `JSON.stringify(snapshot)` 동일을 확인).
- 옛 저장본(시간표 컬렉션 자체가 없는 것)도 그대로 복원되고 이후 철회 시도는 `Unknown railway timetable`이다.
- 철회된 시간표는 `save()`/`load()`와 `runtime.save()`/`load()`를 거쳐도 같고(`snapshot()` 동일), 그 ID는 다시 발급되지 않는다. (`save()` 문자열에는 벽시계 `savedAt`이 들어 있어 문자열 자체는 매번 다르다 — 기존 동작이며 비교는 `snapshot()`으로 한다.)

## 시간표 수명주기 패널(M5)의 변경

`engine/src/railway-timetable-lifecycle-ui.mjs`

- 버튼 **철회**(`ttlife-withdraw`)가 승인·개통 옆에 생겼다. 클릭할 때만 `runtime.withdrawRailwayTimetable(timetableId)`를 부른다(이 패널의 엔진 명령 호출 위치는 여전히 클릭 핸들러 두 곳뿐).
- 패널은 전이를 계산하지 않는다. 버튼은 **엔진이 보고한 상태**가 `assessed`/`approved`이고 심사 기록이 낡지 않았을 때만 켜지며, 엔진이 거절하면 그 오류를 그대로 보여 주고 기록은 그대로다.
- 철회 불가:
  - **낡은(stale) 기록**: 버튼이 꺼지고, 클릭이 와도 엔진을 부르지 않는다("낡은 심사라서 실행하지 않았습니다").
  - **다른 계획의 기록**: 계획은 자기 `servicePlanId`의 기록만 철회한다. 지도에서 사라진 계획의 기록(고아 기록)에는 철회 버튼이 없고 "기록 지우기"만 있다.
  - **active**: 버튼이 꺼지고 "개통된 시간표는 철회할 수 없습니다(엔진 규칙)…" 안내가 나온다.
  - 화면이 오래돼 엔진 상태가 이미 바뀌었으면, 클릭 시점에 상태를 다시 읽어 더 이상 열려 있지 않은 단계는 엔진을 부르지 않는다.
- 철회된 시간표: "엔진 상태: 철회됨 (withdrawn)", "철회 이력: assessed 상태에서 N분에 철회 · 사유…", 철회 전 심사 결과(감사용)가 보이고, 승인·개통·철회 버튼은 꺼지며 **다시 심사**할 수 있다(새 시간표가 생기고 기록이 그쪽으로 바뀐다). 상단 요약에 "철회됨" 개수가 생겼다.
- 여러 계획이 한 시간표를 공유하면(일괄 심사) "이 시간표는 다른 계획과 함께 심사됐습니다: …" 안내가 나온다. 철회하면 그 계획들의 기록도 철회됨으로 보인다.
- `results()`에 `canWithdraw`가 더해졌다. 마운트 시 runtime에 `withdrawRailwayTimetable`이 없으면 던진다(호스트가 쓰는 `ScenarioRuntime`에는 있다).
- 철회 사유 입력칸은 없다(엔진은 받을 수 있다). 필요하면 호스트가 `runtime.withdrawRailwayTimetable(id, { reason })`을 직접 부를 수 있다.

## 호스트(Codex) 참고

- `main.mjs`는 바꾸지 않았다. 이미 마운트한 패널에 버튼이 생기고 `style.css`의 `.ttlife-actions` 안에서 보인다. 새 클래스: `ttlife-withdraw`(버튼), `ttlife-withdrawn`(철회 이력 줄).
- 저장 문서 형식(`transitline.railway-timetable-lifecycle-doc/1`)은 바뀌지 않았다. 철회 상태는 엔진 기록에서 읽는다.
- 일괄 심사로 만든 시간표를 철회한 뒤 같은 계획들을 다시 일괄 심사하면 새 시간표가 생긴다. `assessmentEnabled: false`인 호스트에서는 패널의 개별 "시간표 심사"가 꺼져 있으므로 재심사는 일괄 심사 경로로 한다.

## 검증

- `engine/test/railway-timetable-withdraw.test.mjs` 15개: 가능 상태 목록, assessed 철회와 감사 필드·이벤트, approved 철회와 이력, 반복 철회 거부, active·superseded 철회 거부와 서비스 연결 유지, 철회 뒤 approve/activate 거부, 대체 활성화(superseded)와 withdrawn 기록 불변, 없는 ID·잘못된 사유, 트랜잭션 롤백(상태·이벤트·RNG·시퀀스), 저장·복원과 ID 비재사용, 기존 저장본 호환(필드 무추가·바이트 동일·옛 저장본), 보고서 복사본, `ScenarioRuntime` 위임·지도 상태 불변·저장 복원·거부 시 저장 불변.
- `engine/test/railway-timetable-lifecycle-ui.test.mjs`: 철회 버튼 활성 조건, assessed/approved 철회 후 상태·재심사, active 철회 불가, 대체 활성화 속 withdrawn 유지, stale·고아 기록 철회 불가(엔진 호출 0회), 다른 계획의 기록 불변, 공유 시간표 안내, 화면이 오래된 상태에서의 클릭, 더블클릭·엔진 호출 중 재진입·엔진 오류, 저장 복원.
- 변이 확인(엔진): active 철회 허용, 철회가 상태를 바꾸지 않음, 이전 상태 기록 누락 — 각각 테스트가 실패. 변이 확인(패널): stale 무시, active 허용, 철회 클릭이 개통을 부름, 철회 뒤 재심사 불가, 클릭 시 검증 생략 — 각각 테스트가 실패.
- headless Chrome: 실제 `ScenarioRuntime`으로 마운트 → 심사 → 철회 더블클릭(엔진 1회) → 철회 이력 표시 → 재심사·승인·개통 → active 철회 클릭 차단 → 저장·불러오기. 콘솔 오류 0, localStorage 접근 0.

## 한계

- 철회는 되돌릴 수 없다. 다시 쓰려면 새로 심사한다(새 ID).
- 낡은 기록·고아 기록은 패널에서 철회할 수 없다(요구사항). 이런 기록이 가리키던 `assessed`/`approved` 시간표는 엔진에 남는다. 호스트가 `runtime.withdrawRailwayTimetable`을 직접 부르는 정리 경로가 필요하면 별도 단계에서 정한다.
- 서비스가 열려 있는지, 판정이 possible인지 같은 규칙은 여전히 엔진(approve/activate)의 몫이다. 철회는 그런 검사를 하지 않는다(상태 전이만).
