# B20-E3 장기 캠페인 사실 보고서

`transitline.campaign-fact-report/1`은 B20 program/milestone/activation과 기존 B19 개발·분담금·명시 수요 원천·서비스·시간표 보고서를 읽기 전용으로 조합한다.

링크가 목록으로 명시되었으나 제공된 보고서에서 찾지 못하면 `status: null`과 `*-not-found` 이유를 낸다. `null` 링크 목록은 `not-stated`, `[]`는 명시된 빈 목록으로 보존한다. activation은 저장 상태가 아니라 현재 standing과 blockers를 함께 보인다.

이 보고서는 합계, ROI, 비용, 수요, 승객, 운임, 성공 판정을 만들지 않고 원본 상태·시계·난수·원장을 바꾸지 않는다. `ScenarioRuntime.campaignFactReport({ geometry })`가 현재 geometry를 받아 source/intake/activation의 stale 여부를 다시 확인한다.
