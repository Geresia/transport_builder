# B20-E2 마일스톤 원천 활성화 기록

`transitline.campaign-activation/1`은 B20 프로그램의 한 마일스톤이 B19-E4 intake와 B19-E5 명시 수요 원천을 참조한다는 기록이다. 이것은 B15 적용, 수요 노드 생성, 접근 링크 생성, 승객 생성이 아니다.

기록하려면 프로그램 geometry, accepted intake의 검증, applied explicit source의 standing이 모두 `current`여야 한다. 저장값은 intake/source/프로그램 revision tuple을 복사한다. 이후 지도·intake·source가 달라지면 `standing.status: stale`이며 자동으로 새 tuple에 맞추지 않는다. 플레이어는 철회만 할 수 있다.

`ScenarioRuntime.recordCampaignActivation({ campaignProgramId, milestoneId, intakeId, demandSourceId, geometry })`가 런타임의 B19 보고서를 읽어 원자적 management 기록을 만든다. `campaignActivationReport({ geometry })`는 현재 standing을 다시 계산하고, `withdrawCampaignActivation`은 지도 없이 철회한다.
