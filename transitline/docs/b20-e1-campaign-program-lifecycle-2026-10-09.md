# B20-E1 캠페인 프로그램 생애주기

경영 기록은 `transitline.campaign-program/1`이며 지도 계약 B20-M1의 `programId`와 별개의 `campaign-program:N` ID를 쓴다. 관리 상태는 `draft → adopted → monitoring → completed`이고, `adopted`/`monitoring`은 `delayed`로 갔다가 이전 상태로 재개할 수 있다. `cancelled`와 `completed`는 종결 상태다.

`adopt`, `monitor`, `complete`, 마일스톤 `reach`, `resume`은 현재 B20-M1 geometry가 필수다. 지도가 없거나 stale·inactive·other program이면 거절된다. `delay`, `cancel`은 지도가 없어도 가능하다. 마일스톤은 목표 월이 도래했다고 자동 완료되지 않으며 플레이어/시나리오가 `reachCampaignMilestone`을 명시 호출해야 한다.

각 마일스톤은 지도에서 복사한 ID·순서·목표 월·기간, 상태, 선언 시각, 그리고 호출자가 적은 `observedRefs`만 보존한다. 비용·수요·승객·운임·원장·RNG를 계산하거나 쓰지 않고 시간을 전진시키지 않는다. transition의 `atMinute`은 기존 `game.clock.minute`를 읽은 값이다.

`ManagementGame`와 `ScenarioRuntime`은 `draft/adopt/monitor/complete/delay/resume/cancelCampaignProgram`, `reachCampaignMilestone`, `assessCampaignProgram`, `campaignProgramReport`, `campaignProgramHooks`를 제공한다. 모든 변경은 `transact`로 원자화되며 저장·복원 시 ID 카운터는 기존 최대 ID와 저장 카운터 중 큰 쪽에서 이어진다.
