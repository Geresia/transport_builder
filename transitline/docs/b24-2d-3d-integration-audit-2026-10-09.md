# B24 2D/3D 통합 감사

`transitline.construction-3d-integration-audit/1`은 B20 campaign record, B21 3D client/scene/change-set, B22 spatial review의 pack·revision 안전성만 읽기 전용으로 모은다. 적용, Unity 실행, 시간 전진, 원장/수요/운영 상태 변경은 하지 않는다.

3D 클라이언트가 없거나 호환되지 않아도 `fallback: "2d-only"`로 2D 게임은 계속 가능하다. 반대로 stale·다른 팩·좌표계 불일치 change-set이나 review는 `applicable: false`로 막힌다. 이 감사는 B24 최종 실제 Unity round-trip·성능 측정의 자동 테스트 기반이며, 그 측정 자체를 대신하지는 않는다.
