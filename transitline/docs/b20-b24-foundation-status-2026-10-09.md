# B20~B24 기반 상태와 다음 구현 경계

이 문서는 2026-10-09 현재 **구현된 기반**과 아직 구현하지 않은 Unity/UI 단계를 구분한다. 계약·테스트가 있다는 사실을 Unity 런타임이나 플레이 가능한 화면이 있다는 주장으로 읽으면 안 된다.

## 구현됨

| 영역 | 정본 / 커밋 | 증명 |
| --- | --- | --- |
| B20 시간 | `campaign-time.mjs` (`edc117e`) | 기존 30일 월을 읽기 전용 캠페인 월/분기/연도로 표시 |
| B20 지도 프로그램 | `regional-development-program/1` (`f8d3265`) | 결정적 map ID, milestone/link/pack/stale 사실 |
| B20 관리 | `campaignPrograms` (`a9bdac3`) | transaction, 저장/복원, 명시 전이와 rollback |
| B20 활성화 | `campaignActivations` (`fd3de66`) | B19 accepted intake + current E5 source 참조만 기록 |
| B20 보고/표시 | fact report / timeline view (`5598142`, `a4f7480`) | 합계/ROI/자동 완료 없이 읽기 전용 |
| B21 교환 | scene/change-set + adapter (`58134b7`, `ae6c67d`) | pack/revision/좌표 검증, 2D fallback |
| B22 검토 | spatial review (`cebe02a`) | clear/conflict/unknown 사실만, 판정 아님 |
| B23 단계 | stage manifest (`d707cf4`) | 제공된 공사 사실의 읽기 전용 time slice |
| B24 검사 | integration audit (`83e87bf`) | B20~B23 artifact 안전성/2D fallback 검사 |

## 아직 구현하지 않음

1. B20-M2 지도 패널: 프로그램 문서의 실제 클릭/그리기 편집과 지도 오버레이.
2. B20-M3 명령 패널: timeline view를 DOM에 붙이고 E1/E2 명령을 클릭에만 연결.
3. B20-C1: `main.mjs` mount, 프로그램 문서와 패널 초안의 통합 저장.
4. 실제 Unity WebGL/desktop build와 loader. B21 adapter는 capability 계약일 뿐 Unity binary가 아니다.
5. B22의 실제 scene source adapters(B13 rail geometry/B8 station/depot/new-town)와 실제 메시/terrain rendering.
6. B23의 실제 time slider와 workfront/package adapters.
7. B24 실제 Unity round-trip, Tokyo/합성 팩 측정, 30년 성능/저장 크기 기준선.

## 절대 넘지 않을 경계

- Unity는 cash, ledger, demand nodes, passengers, timetables, RNG, game clock을 읽거나 쓰지 않는다.
- Unity change-set은 proposed 상태의 입력이며, 2D의 source pack/revision/coordinate 검사와 도메인별 승인 없이는 적용하지 않는다.
- B20 activation은 B15 적용이 아니다. `demandNodes`, `accessLinks`, `stationDemandAllocationLinks` 자동 변경은 금지한다.
- 3D client가 없거나 호환되지 않으면 2D 게임은 `2d-only` 상태로 계속 동작해야 한다.

## 다음 구현 순서

1. B20-M2/M3의 독립 mount와 브라우저 상호작용 시험.
2. B20-C1 통합 저장과 `main.mjs` 연결.
3. Unity project 외부 저장소/빌드 설정을 만든 뒤 B21 adapter handshake를 실제 loader에 연결.
4. B22/B23 source adapters와 change-set을 기존 2D 승인 경로에 하나씩 연결.
5. B24에서 2D only와 Unity enabled 양쪽의 저장→복원→재열기와 성능을 실제 측정한다.
