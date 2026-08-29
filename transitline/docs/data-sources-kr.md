# Korean Demand Data — Source Survey

Target extent: 서울 + 경기 + 인천 + 춘천(경춘선) + 충청 남부(1호선 천안·아산·신창).
Roughly `[126.35, 36.72, 127.80, 38.15]` — about 128 × 159 km, ~20,000 km²,
~26.5M people. For scale, that is ~3.7× the area and ~8× the population of the
Tampa Bay pack that `depot` was built for.

Researched 2026-08-29. **Licence terms change — re-verify before launch.**
See [`../LICENSING.md`](../LICENSING.md) for how these feed the three-layer split.

## The filter that decides everything: 공공누리 type

Korean public data uses KOGL (공공누리) types. A commercial game that
*transforms* boarding counts into a demand model needs both commercial use and
derivative works:

| Type | 상업적 이용 | 변경(2차적 저작물) | Usable for us |
|---|---|---|---|
| **제1유형** 출처표시 | ✅ | ✅ | **Yes** |
| 제2유형 +상업금지 | ❌ | ✅ | No |
| 제3유형 +변경금지 | ✅ | ❌ | **No** — we must transform |
| 제4유형 +상업금지+변경금지 | ❌ | ❌ | No |

**제1유형 only.** 제3유형 is the trap: it permits commercial use, which reads as
safe at a glance, but 변경금지 forbids the derivative work that *is* our
pipeline. Attribution is mandatory under every type.

## Verdict by dataset

### ✅ Usable

**서울시 지하철 호선별 역별 시간대별 승하차 인원 정보** — `OA-12252`
<https://data.seoul.go.kr/dataList/OA-12252/S/1/datasetView.do>
- **공공누리 제1유형** — commercial + modification permitted
- Hourly buckets, per line, per station; monthly refresh (5th of the month)
- CSV download + OpenAPI; published since 2015
- Covers **1~9호선, 서울시 관할 운송기관에 한함** — excludes Korail, 신분당선, 인천
- **This is the backbone.** Best licence, finest time granularity, direct download.

**한국철도공사 광역철도 수송인원 및 승하차인원** — `data.go.kr/15154382`
<https://www.data.go.kr/data/15154382/fileData.do>
- **이용허락범위 제한 없음**
- 노선별·역별, 월/시간대별; XLSX direct download
- Covers 경부·경인·경원 등 — fills the Korail gap: 경의중앙, 경춘, 수인분당,
  1호선 외곽 (연천·천안·신창 방면)
- Weekday/weekend separation **not documented** — verify on the actual file

**서울시 대중교통 O/D(출발 도착) 현황** — `OA-20501`
<https://data.seoul.go.kr/dataList/OA-20501/L/1/datasetView.do>
- **공공누리 제1유형**
- Actual origin–destination, 동별 + 지하철, monthly (uploaded on the 10th)
- Source: 한국스마트카드 transaction records
- ⚠️ **The dataset page currently shows "파일이 없습니다."** May be archived or
  discontinued. **Verify manually before planning around it** — this is the only
  licence-clean true OD source found.

### ❌ Not usable

**서울교통공사 역별 일별 시간대별 승하차인원 정보** — `OA-12921`
<https://data.seoul.go.kr/dataList/OA-12921/F/1/datasetView.do>
- **공공누리 제3유형 (출처표시 + 변경금지)**
- Daily dates × hourly buckets, 2008–2025, CSV/XLSX, 24MB
- This is *the* dataset that would answer the weekday/weekend question — real
  dates mean 평일/토/일 falls straight out. **변경금지 makes it unusable for a
  transformed commercial product.** Do not build on it.

**교통카드 빅데이터 통합정보시스템 (STCIS)** — <https://stcis.go.kr>
- Opened 2025-04-01 by 국토교통부 / 한국교통안전공단
- The richest OD source in the country: real farecard taps, nationwide
- ⚠️ Access is through the **데이터안심구역** (<http://dsz.kdata.or.kr>) —
  membership, application, and approval, with analysis performed *inside* their
  secure environment. **Raw data is not extractable**, and export is subject to
  review. Unusable for data that must ship inside a game binary.
- Still worth applying for as a *calibration reference* — you may be able to
  export aggregate ratios rather than the data itself.

## Coverage gap for the chosen extent

The extent spans at least six operators, and no single dataset covers it:

| Segment | Source | Status |
|---|---|---|
| 1~9호선 (서울 관할) | OA-12252 | ✅ 제1유형 |
| 경의중앙·경춘·수인분당·1호선 외곽 | 코레일 15154382 | ✅ 제한 없음 |
| 인천 1·2호선 | 인천교통공사 | ❓ not yet surveyed |
| 신분당선 | 네오트랜스 | ❓ not yet surveyed |
| 김포골드라인, 의정부·용인 경전철 | 각 운영사 | ❓ not yet surveyed |
| 춘천 (경춘선 종점) | 코레일 | likely covered above |

Expect to stitch **6+ sources with independent licences**, and to reconcile
station naming across them — 환승역 appear under different codes per operator,
and this is normally the single largest data-cleaning cost in the pipeline.

## The weekday/weekend problem

**No licence-clean source of weekday vs weekend demand was found.**

- OA-12252 is hourly but **aggregated monthly** — it yields an hour-of-day
  profile, not a day-of-week one.
- OA-12921 has real dates and would solve it outright, but is 제3유형.
- STCIS has it, but cannot leave the 안심구역.

### Recommendation: model it, don't source it

This is a **game**, not a transport study. It needs demand that is *plausible and
fun*, not ground-truth weekend OD. So:

1. Take the hour-of-day profile from OA-12252 (제1유형, clean).
2. Apply **modelled** day-type multipliers — weekday / Saturday / Sunday-holiday
   — as tunable pack parameters.
3. Calibrate those multipliers against published aggregate ratios, or against
   whatever STCIS permits exporting.

Modelled coefficients are our own work and carry no licence obligation. This
converts a hard legal blocker into a tuning problem, and it is the reason the
CityPack format carries `calendar` as first-class data rather than baking a
single average day into the numbers.

## Consequence for the format

Seoul is a **`gravity`** pack, not `matrix`:

- Boarding/alighting counts are **per-station volume**, not origin–destination.
  **승하차 인원 ≠ OD 행렬.** They calibrate a gravity model; they cannot
  populate `flows`.
- The `matrix` path stays reachable only if OA-20501 turns out to be live, or if
  STCIS grants an export.

Design both paths, ship `gravity` first.

## Verified usable — boundaries and residents

**SGIS 행정동 경계** — **공공누리 제1유형**, explicitly permitting commercial use,
modification and redistribution with attribution. Practical access via
<https://github.com/vuski/admdongkor>, which corrects and time-extends the SGIS
release; that repo's own processing is CC BY 4.0. 3,558 dong nationwide, 1,187 in
서울·인천·경기.

**행정안전부 「지역별(행정동) 성별 연령별 주민등록 인구수」** —
<https://www.data.go.kr/data/15097972/fileData.do>, **이용허락범위 제한 없음**,
monthly, no login required for the file download. 3,619 rows keyed by 10-digit
행정기관코드, which joins 1:1 to the boundaries' `adm_cd2`.

Joined 2026-08-29: **1,187 / 1,187 boundaries matched**, 0 unmatched. Six
population rows had no boundary — all 출장소, which have no separate geometry.
Total 26,066,115. Density spans 2/km² (연천군 중면) to 51,366/km² (강동구 천호3동).

This closes `residents`. **`jobs` remains open** — see below.

## Not yet surveyed

- **`jobs` per point** — the remaining half of the gravity model. 전국사업체조사
  / SGIS 사업체 통계 is the likely source. **Highest-priority next check.**
- 인천교통공사 / 신분당선 / 경전철 operator data
- **V-World, 국가공간정보포털** — Korean building/road geometry. A licence-clean
  domestic alternative to OSM would sidestep ODbL for the basemap entirely.

---

# 대구권 (대구 + 경산 + 구미 + 칠곡)

지하철 닿는 범위 = 대구 도시철도 1·2·3호선 + 대구권 광역철도(대경선, 구미–왜관–대구–경산).
`[128.05, 35.55, 129.00, 36.42]` 안, 행정동 198개, 주민등록 312만 (§1 로 확정).
Researched 2026-08-30. **재검증 필수.**

## Verdict by dataset

### ✅ Usable

**대구교통공사 역별일별시간별승하차인원현황** — `data.go.kr/15002503`
<https://www.data.go.kr/data/15002503/fileData.do>
- **이용허락범위 제한 없음** (공공누리 유형 표기 없음, 무제한)
- 도시철도 1~3호선, **역·일자·시간대(05–24시 1시간 버킷)·승/하차**, CSV + OpenAPI, 월갱신
- 서울 OA-12252 의 대응물이자 **한 수 위** — 서울판은 월합산이라 요일 정보가 없는데
  이건 실일자별이라 평일/토/일이 그대로 나옴 (서울에서 못 푼 weekday/weekend 문제가
  대구에선 라이선스 걱정 없이 풀림). **이게 gravity 백본.**

**한국철도공사 광역철도 수송인원 및 승하차인원** — `data.go.kr/15154382`
- **이용허락범위 제한 없음** (서울 파트에서 이미 검증)
- 대경선(대구권 광역철도, 2024-12 개통) 수록 여부는 **파일에서 직접 확인** — 개통이 최근이라
  아직 안 들어갔을 수 있음. 안 들어갔으면 구미·경산·칠곡 광역철도역은 당분간 공백.

**통계청 인구총조사 통근·통학 인구 (거주지 ↔ 통근통학지)** — KOSIS
- 통계청 공표통계, **이용 제한 없음** (출처표시). SGIS 통계주제도 버전은 `data.go.kr/15140470`.
- **시군구 간 통근·통학 통행 방향** — §3 플로우 지도의 데이터. 단 **통근·통학만**,
  시간대·쇼핑·귀가 없음. 5년 주기(인구총조사).

### ❌ / ⚠️

**KT 「생활이동」 대구판** — **없음.** OA-22300 은 수도권 전용. data.daegu.go.kr,
data.go.kr 검색해도 대경권 시간대별 행정동 OD 는 공개본이 없다.

**국가교통DB(KTDB) 여객 기종점통행량** — <https://www.ktdb.go.kr>
- 시군구·존 단위 O/D, 목적·수단별. **자료신청 후 제공**, 라이선스는 신청 시 별도 —
  보통 재배포·2차가공에 제약. **게임 바이너리 내장용으로는 리스크.** calibration 참고용만.

**대구 D-데이터허브 SKT 유동인구 / 생활인구** — <https://data.daegu.go.kr>
- 존별 체류·유동 인구(=인구 분포), **OD 아님.** 라이선스 미확인. gravity 보정 보조자료.

## Consequence

대구권도 **`gravity` 팩** (서울과 동일 이유 — 승하차량 ≠ OD).
- **hour-of-day + day-type**: 대구교통공사 15002503 에서 직접. 서울처럼 요일 배수를
  모델링할 필요 없음 (실일자 있음).
- **§3 플로우 지도**: 통계청 통근통학 시군구 OD 로 축소 제작 — 방향은 나오나 시간대·비통근
  목적은 없음.
- **§4 시간대별 유출입 프로파일**: 생활이동 대신 **역별 시간대 승하차**(15002503)로.
  행정동 단위가 아니라 역 단위가 되지만 후보지 판단엔 충분.

---

# 부산권 (부산 [+ 김해 + 양산])

기본 범위 = 부산광역시 (도시철도 1~4호선 + 부산김해경전철 부산 구간 + 동해선).
확장 시 = 부산 + 김해(부산김해경전철) + 양산(2호선 연장). §1 부산 단독 = 행정동 206개,
주민등록 323만. `[128.79, 34.99, 129.30, 35.39]`. Researched 2026-08-30. **재검증 필수.**

## Verdict by dataset

### ✅ Usable

**부산교통공사 시간대별 승하차인원** — `data.go.kr/3057229`
<https://www.data.go.kr/data/3057229/fileData.do>
- **이용허락범위 제한 없음**
- 도시철도 1~4호선, **역·일자(YYYY-MM-DD)·요일·시간대(24 버킷)·승/하차**, CSV + OpenAPI,
  롤링 6개월(현재 2026-01~06), ~40,544행. 2022년부터 요일 항목.
- 대구 15002503 과 동급 — 실일자라 평일/토/일 분리 가능. **이게 gravity 백본.**
- 환승역: 호선별 게이트 분리 역은 호선별 제공, 통합 게이트 역은 한 호선에 합산.

**부산교통공사 월별 역별 권종별 승하차** — `data.go.kr/15128561` — 보조(권종=일반/청소년/경로 등).

**한국철도공사 광역철도 수송인원 및 승하차인원** — `data.go.kr/15154382`
- **제한 없음** (서울 파트에서 검증). 동해선(부전–태화강) 역 승하차. 부산김해경전철은
  코레일 소속이 아니라 **불포함** — 부산김해경전철㈜ 별도 확인 필요.

**통계청 인구총조사 통근·통학 인구** — KOSIS. 대구권과 동일 (§3 플로우용, 통근·통학만, 5년 주기).

### ❌ / ⚠️

**KT 「생활이동」 부산판 / 동남권판** — **공개본 없음.** KT PLIP(생활이동분석솔루션)은
부산시가 도입해 쓰지만 유료 솔루션이라 서울 OA-22300 같은 무료 공개 파일이 없다.
data.busan.go.kr / bigdata.busan.go.kr 에도 시간대별 행정동 OD 공개본 없음.

**부산 Big-데이터웨이브 / 빅데이터 플랫폼** — <https://data.busan.go.kr/bdip/> ,
<https://bigdata.busan.go.kr> — 유동·생활인구(분포, OD 아님), 라이선스 개별 확인.

**부산김해경전철 승하차** — 운영사 부산김해경전철㈜. data.go.kr 수록 여부·라이선스 미확인.
범위를 김해까지 넓힐 때만 필요.

## Consequence

부산권도 **`gravity` 팩**. 대구권과 사실상 동일한 데이터 상황:
- hour-of-day + day-type: 부산교통공사 3057229 에서 직접.
- §3 플로우: 통계청 통근통학 시군구 OD.
- §4 프로파일: 역별 시간대 승하차(3057229) + `pop.csv` 인구 피라미드.
- 김해·양산 확장 시 부산김해경전철·양산 광역철도 승하차를 추가 수배.
