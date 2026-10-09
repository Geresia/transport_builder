# B20-M3 캠페인 타임라인 표시 기반

`buildCampaignTimelineView({ clockMinute, factReport })`는 기존 경영 시계의 30일 월을 캠페인 월·분기·연도 표시로 바꾸고, 각 B20 마일스톤의 목표 월 도래 사실을 보여 준다. `due`와 `past-due`는 상태 전이가 아니며 마일스톤의 `planned/reached` 상태를 바꾸지 않는다.

팩트 보고서가 없으면 빈 캠페인으로 꾸미지 않고 `programs: null`과 경고를 낸다. 호스트 UI는 이 view를 읽기만 하며, 실제 상태 변경은 B20-E1의 명시 명령을 사용해야 한다.
