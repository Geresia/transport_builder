# 지역 지도 제작 순서 (Playbook)

수도권에서 만든 지도 세트를 다른 광역시·도에 그대로 적용하기 위한 절차서.
부산·대구가 첫 적용 사례. 산출물은 전부 정적 HTML 아티팩트(수요 판단용), 게임 CityPack 아님.

## 큰 순서

| 단계 | 산출물 | 수도권 원본 | 재사용 자산 |
|---|---|---|---|
| **0** | 데이터 소스 서베이 (지역 항목 추가) | `docs/data-sources-kr.md` | 아래 §0 |
| **1** | 행정동 인구밀도 지도 | 수도권 인구밀도 | `scripts/build-metro-demand.mjs`, `scripts/density-map.template.html` |
| **2** | 생활이동 데이터 확보 | OA-22300 | §2 |
| **3** | 시·군·구 간 생활이동 플로우 지도 | 72 시군구 이동 지도 | `build_map.mjs` (스크래치패드) |
| **4** | 타깃 행정동 심층 프로파일 | 천호3동 프로파일 | 인구 피라미드 + 시간대별 유출입 + 목적지 |
| **5** | 통합 아틀라스 (탭: 밀도/이동/프로파일) | sudogwon-atlas.html | 탭별 lazy-parse |

1단계까지가 라이선스·데이터 걱정 없이 바로 되는 부분. 2단계가 매번 가장 오래 걸림
(지역마다 생활이동 데이터 출처·라이선스가 다름).

**범위 정하기 — "지하철이 가는 모든 지역".** 광역시 경계로 자르지 말고 도시철도 + 광역철도가
닿는 시·군까지 포함. 대구권 = 대구 + 경산 + 구미 + 칠곡 (구미–경산 광역철도 회랑).
부산권 확장 시 = 부산 + 김해(부산김해경전철) + 양산(2호선 연장) [+ 울산 동해선 구간].

---

## 0. 데이터 소스 서베이

`docs/data-sources-kr.md` 의 "Coverage gap" / "Verdict by dataset" 에 지역 항목 추가.
확인할 것:

- **지하철 승하차** — 각 도시철도공사 (부산·대구·광주·대전). 공공누리 유형 확인
  (상업적 이용 + 변경 허용 = 제1유형만 사용 가능).
- **광역/외곽 철도** — 코레일 광역철도, 경전철, 동해선.
- **생활이동** — §2.
- **경계·인구는 이미 해결** (전국 단위, §1). 지역별로 다시 안 받아도 됨.

## 1. 행정동 인구밀도 지도

### 입력 (전국 파일, 한 번만 받으면 모든 지역 재사용)

작업 디렉터리(`<SP>`)에 두 파일:

| 파일 | 출처 | 라이선스 |
|---|---|---|
| `pop.csv` | 행안부 「지역별(행정동) 성별 연령별 주민등록 인구수」 — <https://www.data.go.kr/data/15097972/fileData.do> (로그인 없이 파일 다운로드, EUC-KR) | 이용허락범위 제한 없음 |
| `hjd.geojson` | admdongkor 전국 행정동 경계 — <https://github.com/vuski/admdongkor> (`hangjeongdong.geojson` 전국본) | SGIS 원자료 공공누리 제1유형 / 저장소 가공물 CC BY 4.0 |

> 두 파일은 크므로 리포에 커밋하지 않음. 공유 스크래치패드나 로컬에 두고 재사용.
> 조인 키: `pop.csv` 의 `행정기관코드`(10자리) == `hjd.geojson` 의 `properties.adm_cd2`.

### 빌드 — `scripts/build-metro-demand.mjs`

```bash
node transitline/scripts/build-metro-demand.mjs <SP> <지역코드,지역코드,...>
```

- 지역코드 = **2자리 시도** 또는 **5자리 시군구** 혼용 (`inScope()`). 생략 시 기본 수도권 `11,28,41`.
- 출력은 **항상 `<SP>/metro.json`** (출력 경로 인자 없음). → **지역마다 `<SP>` 를 따로 쓰거나
  실행 직후 `metro.json` 을 복사해 나올 것.** 안 그러면 다음 지역이 덮어씀.
- 출장소(경계 없는 인구행)를 이름이 겹치는 상위 읍/면 경계 인구에 합산 (`folded_chuljangso`).
- `meta.bbox` = 렌더러 뷰포트 초기값.

```bash
# 시도코드: 11 서울 26 부산 27 대구 28 인천 30 대전 31 울산 36 세종
#           41 경기 43 충북 44 충남 47 경북 48 경남 50 제주 51 강원 52 전북
# ※ 2026 광역 통합으로 광주·전남 등 코드가 표준과 다름. 돌리기 전 pop.csv 시도명 /
#   hjd.geojson features[].properties.sido 실제 값을 확인.

# 예: 부산 단독
node build-metro-demand.mjs ./busan 26
# 예: 대구 회랑 (대구 + 경산 + 구미 + 칠곡)
node build-metro-demand.mjs ./daegu 27,47290,47190,47850
```

콘솔 리포트 확인:
- `boundaries_metro` == `rendered`, `boundaries_without_population` 0,
  `population_rows_without_boundary` 0 (0 아니면 대개 출장소 — 수치는 캡션에 자동 반영)
- `density_min` / `density_max` / `density_median` 이 상식적인지
- `folded_chuljangso` 규모 (대구권 48,120명, 부산 0)
- `bbox` 메모

### 렌더 — `scripts/build-density-page.mjs` + `density-map.template.html`

```bash
node transitline/scripts/build-density-page.mjs <지역명> <metro.json> <출력.html>
# 예: node build-density-page.mjs 대구권 ./daegu/metro.json transitline/docs/daegu-density.html
```

`__DATA__`(metro.json)·`__REGION__`(지역명, `<title>` + `CONFIG.region`)를 채워 완성 HTML 을 씀.
자리표시자가 남으면 에러로 죽음.

그 다음 **완성된 출력 파일**에서 `CONFIG.view` 한 값만 손으로 조정:
- `view` : `{ w, s, e, n }` — `meta.bbox` `[w,s,e,n]` 로 시작, 서/남쪽 바다·여백 넓으면 조여서.
  부산 `{ w:128.79, s:34.96, e:129.31, n:35.41 }`, 대구권 `{ w:128.05, s:35.55, e:129.0, n:36.42 }`

**자동으로 채워지는 것** (지역별로 손 안 댐): 제목(`<title>` + 헤더), 행정동 수,
범례 문구(최저~최고 밀도·배율), 정합성 문구(미결합/출장소 합산 수치), 자치구 비교표.
스코프가 2개 이상 시도에 걸치면 자치구 옆에 시도 약칭(경북/경남/…)이 자동으로 붙음.

`transitline/docs/` 에 `<지역>-density.html` + `<지역>.json`(= metro.json) 을 남길 것 (부산 사례).

### QA (게시 전 필수)

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B stop; sleep 2; $B viewport 1280x1520
$B load-html ./daegu-density.html && $B wait --load && sleep 3
$B js "document.querySelectorAll('path.d').length + ' / sgg ' + document.getElementById('sgg').children.length"
$B screenshot ./qa.png    # Read 로 눈으로 확인
```

- `path.d` 개수 == 행정동 수, `sgg` 행 == 자치구·군 수 여야 함. **0 이면 다시.**
- browse `load-html`(setContent)은 인라인 스크립트 실행이 자주 씹힘. **`$B goto "file:///C:/…/out.html"`
  (윈도우 절대경로) 가 훨씬 안정적** — 실제 내비게이션이라 스크립트가 정상 실행됨.
  그래도 0 이면 `$B js "var s=[...document.querySelectorAll('script')].pop();(0,eval)(s.textContent);document.querySelectorAll('path.d').length"`
  로 진짜 JS 에러인지 데몬 레이스인지 가린다 (에러면 TDZ 의심 — 함정 메모 참고).
- 지도 모양이 그 지역으로 보이는지 (섬·반도·외곽군 위치).

### 게시

```
Artifact 툴: title "<지역> 인구밀도", favicon 🗺️,
description "<지역> N개 행정동의 주민등록 인구밀도 지도 — 노선 계획용"
```

## 2. 생활이동 데이터 확보

수도권은 서울시가 KT와 만든 **OA-22300 「수도권 생활이동」** (공공누리 제1유형, 시간대별 행정동 OD,
이동목적 분리)을 썼음. 다운로드·컬럼·시간코드·목적코드 세부는 메모리 `seoul-living-migration-data`.

지금까지 확인된 것 (`data-sources-kr.md` 「대구권」·「부산권」):
- **KT 생활이동 공개본은 수도권(OA-22300) 전용.** 대구·부산판 없음 (PLIP 은 유료).
- 대신 **각 도시철도공사 역별 일자별 시간대별 승하차** 가 gravity 백본. 전부 **이용허락범위
  제한 없음**, 실일자라 평일/주말 분리 가능 (서울 OA-12252 보다 나음).
  대구 `data.go.kr/15002503`, 부산 `data.go.kr/3057229`.
- **§3 플로우 지도**는 통계청 인구총조사 통근·통학 시군구 OD 로 축소 (통근·통학만, 5년 주기).

새 지역이면: 해당 도시철도공사 승하차 데이터 검색 → 라이선스 확인 → `data-sources-kr.md` 에 섹션 추가.

이 단계 입력 파일(승하차·통근통학)은 **로그인 게이트** 라 사람이 받아야 함 —
받는 법은 [`data-download-howto.md`](./data-download-howto.md).

## 3. 시·군·구 간 이동 플로우 지도

2단계 데이터 확보 시: 자치구·군 간 OD 를 집계해 플로우 맵. 수도권 스크래치패드의
`build_map.mjs` + `map_slim.json` + `map_template.html` 패턴 재사용 (72 시군구 → 부산 16 구·군).
warm 램프, 뷰포트는 §1 의 bbox.

## 4. 타깃 행정동 심층 프로파일

노선 그을 후보지 1곳 선정 후 (밀도 지도 + 철도 공백 보고 판단):
- **인구 피라미드** — `pop.csv` 의 연령·성별 컬럼 (0세남자 … 110세이상 여자).
- **시간대별 유출입** — 생활이동 데이터, 20분 버킷(7–9·17–19시)·1시간 버킷.
  아침 순유출 피크 시각·뾰족함, 저녁 순유입 폭.
- **목적지 분포** — 구 내부 vs 외부, 상위 도착지 시·군·구, 출근만 따로.
- 함의 한 줄: 어느 역이 어떤 수요(단거리 순환 / 도심 방사 / 부도심 방사)를 받나.

천호3동 사례: 메모리 `cheonho3-demographics`.

## 5. 통합 아틀라스

1·3·4 산출물을 탭 하나로 (`<지역>-atlas.html`). 탭별 데이터 lazy-parse (초기 로드 가볍게).
밀도 = teal 램프, 이동 = warm 램프 유지. 수도권: `sudogwon-atlas.html`.

---

## 함정 메모 (부산·대구 작업에서 실제로 겪음)

- **`metro.json` 은 고정 출력 경로** — §1 참고. 지역마다 `<SP>` 분리 or 즉시 복사.
- **템플릿 자리표시자 중복** — `build-density-page.mjs` 가 `__DATA__` 개수를 검증함. 템플릿
  주석 등에 그 글자를 리터럴로 두면 빌드가 죽음 (실제로 한 번 겪음).
- **JS TDZ** — 템플릿 스크립트에 헬퍼(`shortName` 등) 추가 시 **사용 위치보다 위에** 선언.
  안 그러면 스크립트가 중간에 조용히 멈춰서 지도만 그려지고 표·범례가 빈다.
- **시도코드는 확인 후 사용** — 2026 광역 통합. 스크립트 전에 실제 값 확인.
- **browse 데몬 레이스** — §1 QA 참고.
- **면적/밀도는 단순화 전 좌표로 계산** — `build-metro-demand.mjs` 가 그렇게 함
  (단순화 허용오차 약 35m, 표시용). 템플릿은 표시만.
- **`build-density.mjs` 는 없음** — 한때 만들었다가 `build-metro-demand.mjs` 로 통합하며 삭제.
  스크립트는 `build-metro-demand.mjs` 하나뿐.
