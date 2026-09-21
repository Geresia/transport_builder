# Transitline

도쿄권 철도망을 직접 깔아 보는 교통망 건설 게임. 작업 이름이라 바꿔도 된다. 이 이름에 의존하는 코드는 없다.

**대상 범위:** 도쿄도 · 사이타마 · 지바 · 가나가와 (1도 3현). 경도 138.18–140.87, 위도 34.90–37.15 범위의 `tokyo` 팩이 이걸 덮는다.

서울·부산·대구는 초기에 만든 자료가 남아 있지만 더 이어가지 않는다. 자세한 건 아래 "한국 자료" 참고.

## 상태

- **포맷(Phase 0):** 끝. CityPack 스펙, 스키마, 검증기, 가상 팩 2개.
- **엔진(Phase 1):** 가상 팩(`example-radial`)에서 노선 긋기, 열차 운행, 승객 경로 탐색이 돈다. [`engine/`](./engine/) 참고.
- **도쿄 팩:** 뷰어로 볼 수 있는 상태. 인구·종사자·건물·도로·베이스맵이 들어 있다. 엔진에는 아직 안 물렸다.
- **다음:** 도쿄 팩을 엔진에 올리기. 그러려면 역 후보를 정하고, 통근 OD(`od.json`)를 수요 모델에 쓰는 것부터 해야 한다.

## 폴더 구조가 이렇게 생긴 이유

상용으로 팔면서 실제 지리 데이터도 써야 하는데, 이 둘은 데이터를 물리적으로 분리하지 않으면 충돌한다. 그래서 세 층으로 나눴다.

```
scripts/    개발 때만 쓰고 배포 안 함      →   GPLv3 도구를 써도 됨
packs/      지도 데이터, 공개 배포         →   OSM 파생이면 ODbL
engine/     게임, 판매                     →   독점, 팩에서 아무것도 상속 안 함
```

데이터나 의존성을 건드리기 전에 [`LICENSING.md`](./LICENSING.md)를 먼저 읽는다. 규칙은 두 개고 직관과 좀 어긋난다.

1. 데이터 생성 스크립트는 플레이어에게 가면 안 된다. 게임에 묶어 넣으면 GPLv3 파생물이 된다.
2. 검색 가능한 OSM 지오메트리는 팩에만 두고 엔진에는 두지 않는다.

## 파일

| 경로 | 내용 |
|---|---|
| [`docs/citypack-format.md`](./docs/citypack-format.md) | 팩 포맷 스펙. 데이터와 게임의 경계 |
| [`packs/tokyo/`](./packs/tokyo/) | 도쿄권 실데이터 팩 ([README](./packs/tokyo/README.md)) |
| [`packs/example-radial/`](./packs/example-radial/) | 가상 방사형 도시, `gravity` 모델 |
| [`packs/example-corridor/`](./packs/example-corridor/) | 가상 회랑형 도시, `matrix` 모델 + 캘린더 |
| [`engine/`](./engine/) | 게임 루프 |
| [`scripts/validate-pack.mjs`](./scripts/validate-pack.mjs) | 팩 검증기. 형식뿐 아니라 라이선스 규칙도 검사 |
| [`scripts/pack-checks.mjs`](./scripts/pack-checks.mjs) | validate-pack이 부르는 데이터 검사: JSON 서식(BOM), `.gz` 형제 파일이 원본과 일치하는지, 파일 간 불변식(시정촌 코드, O/D 행 합계, 町丁目 합계=시정촌 인구, 건물별 종사자 합계). 입력 파일의 크기·수정시각이 그대로면 결과를 `.cache/`에서 재사용, `--no-cache`로 무시 |
| [`schemas/`](./schemas/) | manifest·demand JSON 스키마. 참고용 |
| [`docs/subway-builder-reference.md`](./docs/subway-builder-reference.md) | Subway Builder 참고 노트 |

## 쓰는 법

```powershell
node scripts/validate-pack.mjs packs/tokyo   # 팩 하나 검증
npm run validate                             # 전체 검증
npm run regen                                # 가상 팩 수요 데이터 재생성
```

설치 단계는 없다. 검증기가 의존성 없이 돌게 만든 건 CI에서 아무것도 설치하기 전에 돌아야 하고, JSON 모양만 보는 게 아니라 라이선스 경계를 강제해야 해서다.

> **JSON 스키마는 강제되지 않는다.** `schemas/*.json`을 읽는 코드는 없다. 에디터 자동완성과 사람이 읽는 참고용이다. 실제 규칙은 `validate-pack.mjs`에 손으로 써 있고 둘이 어긋나면 검증기가 맞다. 동기화는 아직 수작업이다.

뷰어와 엔진 띄우는 법은 루트 [`README.md`](../README.md)에 있다.

## 로드맵

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | CityPack 포맷, 스키마, 검증기 | 끝 |
| 1 | 손으로 만든 팩에서 역·노선·승객 라우팅 | 진행 중 |
| 2 | 도쿄 팩을 엔진에 연결 (실제 인구, 종사자, 통근 OD) | 다음 |
| 3 | 시뮬레이션 깊이. 열차 용량, 혼잡, 경제, 건설비 | 나중 |

Phase 1을 일부러 가상 팩으로 돌린다. 실데이터를 붙이는 비용을 내기 전에 게임이 재밌는지부터 본다.

## 남은 문제

**수요 데이터는 도쿄에서 대부분 해결됐다.** 거주 인구는 町丁 단위 국세조사, 종사자는 町丁 단위 경제센서스, 통근은 시정촌 간 OD 행렬(38,805쌍)이 팩 안에 있고 셋 다 재사용 조건이 맞다. 건물 단위 값은 실측이 아니라 이 통계를 토지이용조사로 나눈 모델이라는 점을 잊으면 안 된다.

남은 건 이런 것들이다.

- 통근 OD가 시정촌 단위라서 역세권 수준의 수요는 여전히 모델이 채운다.
- 경제센서스와 국세조사 합계가 도심 구에서 맞지 않는다. 맞추지 않았다.
- 시간대·요일별 승하차 데이터가 없다. 그래서 `calendar`가 포맷의 1급 개념이고, 하루 평균이 아니라 요일 유형과 시간대를 모델로 만든다.
- OSM 건물이 에도가와·가쓰시카·아다치·이타바시에 적다.

## 한국 자료

서울·부산·대구용으로 만든 조사와 스크립트는 지우지 않고 남겨 뒀다. 새로 손대지 않는다. 다만 데이터 라이선스 판단(공공누리 유형별 사용 가능 여부 등)은 나중에 한국으로 돌아오면 그대로 쓸 수 있다.

- [`docs/data-sources-kr.md`](./docs/data-sources-kr.md): 한국 수요 데이터 출처 조사
- [`docs/region-map-playbook.md`](./docs/region-map-playbook.md): 지역 지도 제작 절차. 지역과 무관하게 재사용할 수 있다
- [`docs/seoul-map-coverage-gap.md`](./docs/seoul-map-coverage-gap.md), [`docs/data-download-howto.md`](./docs/data-download-howto.md), [`scripts/README-korea-map.md`](./scripts/README-korea-map.md)
- `scripts/build-metro-demand.mjs`: 수도권 1,187개 행정동 인구밀도
