# B21-P1 2D/3D 공사 교환 계약

Unity 또는 다른 3D 클라이언트는 `transitline.construction-3d-scene/1`을 **읽기 전용 장면 입력**으로 받고, `transitline.construction-3d-change-set/1`을 **제안**으로 돌려준다. 2D JavaScript는 계속 정본이며, 이 모듈은 change-set을 적용하지 않는다.

scene은 pack ID/version, 좌표 기준(`originLonLat`, `metersPerUnit`, `east-up-north`, 수직 datum), 그리고 2D source ID/revision/geometry만 가진다. cash, ledger, demand, passengers, timetable, RNG, game clock은 명시적으로 소유하지 않는다.

`assessConstruction3dChangeSet`은 다른 pack, 좌표계 변경, inactive/missing/stale source, proposed가 아닌 상태를 막는다. 검증을 통과해도 경영 승인이나 시공 가능 판정은 아니다. B22/B23에서 2D 도메인별 어댑터가 허용된 제안 필드를 골라 기존 승인 경로에 전달한다.
