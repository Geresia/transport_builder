# B23 3D 공사 단계 manifest

`transitline.construction-3d-stage-manifest/1`은 현재 선택한 simulation minute에 호출자가 제공한 공사 package, workfront, event, disruption의 ID·revision·상태·위치만 표시한다. 위치가 없으면 0이나 중심점으로 대체하지 않고 `location-unknown`/`location-not-provided`으로 남긴다.

이 manifest는 시간 슬라이더의 표시 입력일 뿐, 공정 진척·비용·지연·보상·위험·운영 정산을 계산하거나 시간을 전진시키지 않는다. 3D change-set의 적용은 B22와 마찬가지로 기존 2D 승인 경로가 맡는다.
