# B18-C1 — 운영일력 기반

운영일력은 수요 캘린더와 별개다. 수요 캘린더는 통행량 계수이고, 운영일력은 어떤 시간표 dayType을 dispatch할지 정한다.

`transitline.operational-calendar/1`은 `dayTypesByOperatingDay`에 시뮬레이션 day 번호를 명시해 `weekday`, `weekend`, `holiday` 중 하나로 덮어쓴다. 없는 날은 기존 월~금 평일, 토·일 주말 규칙을 그대로 쓴다. 공휴일은 추론하지 않으며 명시된 경우만 생긴다.

이 기반 위에서만 holiday 시간표의 개통과 dispatch가 가능하다. 달력 자료가 없으면 기존처럼 holiday 시간표를 안전하게 거절한다.
