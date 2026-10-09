# B22 3D 선로·역·부지 공간 검토 계약

`transitline.construction-3d-spatial-review/1`은 3D 클라이언트가 특정 2D source revision에 대해 기록한 `clear`, `conflict`, `unknown` 공간 관측이다. 다른 pack, inactive/missing source, stale revision은 적용 대상이 아니다.

`conflict`는 시공 불가·비용·허가 거절을 의미하지 않고, `clear`도 승인을 의미하지 않는다. 실제 적용은 B13/B8/B14 등 각 2D 도메인의 기존 검토·승인 경로가 맡는다. 레이어가 없거나 관측하지 못한 것은 `unknown`으로 남기며 그럴듯한 3D 지형이나 건물을 지어내지 않는다.
