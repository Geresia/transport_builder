# B21-P2 선택형 3D 클라이언트 어댑터

`transitline.construction-3d-adapter/1`은 Unity WebGL·desktop 또는 다른 3D 클라이언트가 장면 manifest와 change-set 계약을 지원하는지만 확인한다. 클라이언트가 없거나 불완전하거나 호환되지 않으면 항상 `fallback: "2d-only"`이며, 2D 게임 실행에는 영향을 주지 않는다.

세션 문서는 client ID/version, 선택 source ID, 선택 change-set ID만 저장한다. WebGL binary, GPU/카메라 상태, 운영 시뮬레이션 상태는 저장하지 않는다. 실제 Unity 로더와 `main.mjs` 연결은 후속 B21 UI 단계의 소유다.
