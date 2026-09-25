# Transport Builder

실제 도시 데이터로 노선을 그리고 승객을 실어 나르는 교통망 건설 게임을 만드는 저장소다. 게임 엔진, 지도 데이터 팩, 그 데이터를 만드는 스크립트가 같이 들어 있다. 도쿄 1도 3현(도쿄·사이타마·지바·가나가와)만 다룬다. 처음에 만든 서울·부산·대구 자료는 남겨 두었지만 더 이어가지 않는다.

아직 게임이라고 부르기엔 이르다. 엔진은 노선 긋기, 열차 운행, 승객 경로 탐색까지만 돌아가고 돈·건설비가 없다. 도쿄 팩은 뷰어로 볼 수 있고, 엔진도 통근 OD와 기존 철도망을 읽어 도쿄에서 돌아간다(역은 시정촌 단위 수요 점 242개에 고정). 역 후보를 자유롭게 정하고 건설·경제를 얹는 건 다음 단계다.

## 지금 되는 것

| | 상태 |
|---|---|
| CityPack 포맷과 검증기 | 끝. 스펙은 `transitline/docs/citypack-format.md` |
| 엔진 (노선·열차·승객 라우팅·수단 선택) | 가상 팩 2개와 도쿄 팩에서 동작. 돈, 건설비, 팬/줌 없음. 알려진 엔진 버그 7건 미수정 ([`code-review-2026-09-22.md`](./transitline/docs/code-review-2026-09-22.md)) |
| 도쿄 팩 뷰어 | 동작. 23구 + 3현 시정촌, 町丁 단위 인구·종사자, 건물 단위 추정치 |
| 도쿄 팩 → 엔진 | 일부. 통근 OD(`od.json`)와 기존 철도망(`existing-network.json`)은 연결됨. 특수 수요·건물·지형은 엔진에 반영 안 됨 |
| 도쿄 팩 → Subway Builder 모드 | 변환·빌드까지. 실제 게임에서 로드해 본 적은 없음 ([`subway-builder-export/`](./transitline/subway-builder-export/README.md)) |
| 서울·부산·대구 | 중단. 인구밀도 지도와 데이터 조사만 남아 있음 |

## 폴더

```
transitline/
  engine/     게임 루프. 바닐라 JS + Canvas, 의존성 없음
  packs/      지도 데이터 팩 (example-radial, example-corridor, tokyo)
  schemas/    manifest·demand JSON 스키마 (참고용, 검증은 validate-pack.mjs가 한다)
  scripts/    팩 생성·검증 스크립트
  docs/       포맷 스펙, 데이터 출처 조사, 지역별 제작 절차, 개발 서버
```

루트의 `bot/`, `depot/`, `monorepo/`, `registry/`, `template-mod/`는 Subway Builder 커뮤니티 저장소를 읽으려고 받아 둔 참고용 클론이라 `.gitignore`에 들어 있고 이 저장소 코드가 아니다. 읽고 정리한 내용은 `subway-builder-modded.md`와 `transitline/docs/subway-builder-reference.md`에 있다.

## 실행

설치할 게 없다. 브라우저가 `fetch`로 파일을 읽기 때문에 `file://`로는 안 열리고 정적 서버가 필요한데, Windows PowerShell용 `docs/serve.ps1`이 있다. `.pmtiles`에 필요한 HTTP Range 요청도 처리한다.

```powershell
# 도쿄 팩 뷰어  → http://localhost:8020/viewer.html
powershell -NoProfile -File transitline\docs\serve.ps1 -Port 8020 -Root transitline\packs\tokyo -Index viewer.html

# 엔진 (가상 도시)  → http://localhost:8000/engine/index.html
powershell -NoProfile -File transitline\docs\serve.ps1 -Port 8000 -Root transitline -Index engine/index.html
```

엔진은 기본으로 `example-radial`을 열고, `?pack=../packs/example-corridor`처럼 다른 팩을 고를 수 있다.

Range 요청을 못 하는 서버(예전 버전 `serve.ps1` 인스턴스 등)에서는 `.pmtiles`가 안 뜬다. 건물이 안 보이면 서버부터 의심하면 된다.

팩 검증과 스크립트는 Node가 필요하다(개발은 v24).

```powershell
cd transitline
npm run validate                                # 전체
node scripts/validate-pack.mjs packs/tokyo      # 하나만
```

## 도쿄 팩

`transitline/packs/tokyo/`. 뭐가 실측이고 뭐가 추정인지가 이 팩에서 제일 중요해서 구분해서 적는다.

**실측 (출처가 있는 통계)**

- 23구 + 3현 시정촌 242곳의 인구 (2020년 국세조사, 일부는 2026-08 추계, 점마다 `popDate`에 표기)
- 23구 3,150개 町丁 단위 인구·경계 (e-Stat 소지역, NII Geoshape)
- 町丁별 종사자 수 (2021 경제센서스)
- 시정촌 간 통근 OD 38,805쌍, 15.9M명 (2020 국세조사)
- 건물 윤곽: 23구 1.12M동, 사이타마·지바·가나가와 5.12M동 (OpenStreetMap)
- 도로·보행로, 베이스맵(도로·철도·물·토지, z0–12)

**모델 (추정치)**

- 건물별 거주자 수: 町丁의 실제 인구를 도쿄도 토지이용현황조사(R3)의 용도·층수로 가중해서 건물에 나눈 값이다. 계수는 町丁 3,114곳에 비음수 최소제곱을 걸어 맞췄고 R²는 0.74다.
- 건물별 종사자 수: 같은 방식으로 경제센서스 총량을 나눴다. 오피스 약 40명/1,000m², R² 0.85.
- 뷰어의 건물 팝업에는 전부 "모델 추정치 — 실측 아님"이 붙는다. 이 문구는 빼면 안 된다.

**알려진 구멍**

- OSM 건물이 에도가와·가쓰시카·아다치·이타바시에 유독 적다. 지도가 성기게 보이고, 건물 수로 뭔가 계산하면 이 구에서 값이 부풀어 오른다.
- 사이타마·지바·가나가와 건물 타일에는 건물별 거주자 값(OSM 태그 기반 모델)만 있다. 건물별 종사자는 PLATEAU가 되는 4개 시(사이타마·가와사키·사가미하라·요코스카)만 있고, 나머지는 町丁 단위뿐이다.
- 도쿄 다마 지역 건물은 없고, 정목 단위 인구·종사자 데이터도 없다.
- 엔진의 수요는 통근 OD(`od.json`)로 목적지를 고른다. OD가 없는 점만 중력 모델이고, `?od=0`이면 전부 중력 모델이다.
- 경제센서스(사업소 기준)와 국세조사(거주지 기준) 합계는 도심 구에서 안 맞는다. 맞추지 않았다.

세부는 [`transitline/packs/tokyo/README.md`](./transitline/packs/tokyo/README.md), 출처 표기는 [`ATTRIBUTION.md`](./transitline/packs/tokyo/ATTRIBUTION.md).

## 라이선스 구조

상용 판매와 실제 지리 데이터를 같이 하려고 세 층으로 나눴다.

| 층 | 라이선스 | 비고 |
|---|---|---|
| 데이터 생성 스크립트 | GPL 도구를 써도 됨 | 개발 때만 쓰고 플레이어에게 배포하지 않는다 |
| 지도 데이터 팩 | OSM 파생이면 ODbL | 공개해서 share-alike를 여기서 끝낸다 |
| 엔진 | 독점 | 팩을 포맷 문서대로만 읽는다 |

OSM 지오메트리(벡터 타일, 건물 인덱스, 도로 그래프)는 엔진이 아니라 팩 안에만 둔다. 한국 공공데이터는 공공누리 제1유형만 쓸 수 있다. 제3유형(변경금지)은 상업 이용은 되지만 가공이 안 되어서 걸러냈다. 자세한 건 [`transitline/LICENSING.md`](./transitline/LICENSING.md). 법률 자문은 아니고 작업 메모다.

SGIS 집계구 데이터는 비영리 연구·교육 승인 자료라 배포판에 넣으면 안 된다. 연구용 산출물과 배포용 산출물을 나눠 빌드하는 이유가 이것이다(`transitline/scripts/README-korea-map.md`).

## 문서

| | |
|---|---|
| [`transitline/README.md`](./transitline/README.md) | 단계별 로드맵과 현재 상태 |
| [`transitline/docs/citypack-format.md`](./transitline/docs/citypack-format.md) | 팩 포맷 스펙 |
| [`transitline/engine/README.md`](./transitline/engine/README.md) | 엔진 구조와 의도적으로 뺀 것들 |
| [`transitline/docs/data-sources-kr.md`](./transitline/docs/data-sources-kr.md) | 한국 수요 데이터 출처별 사용 가능 여부 |
| [`transitline/docs/region-map-playbook.md`](./transitline/docs/region-map-playbook.md) | 새 지역 지도를 만드는 순서 |
| [`transitline/docs/subway-builder-reference.md`](./transitline/docs/subway-builder-reference.md) | Subway Builder 참고 노트 |

## 참고

장르는 Subway Builder 쪽이다. 게임 이름, 로고, `SubwayBuilderAPI` 같은 식별자, GPL 저장소의 코드는 가져오지 않는다. 게임 메커니즘 자체는 저작권 대상이 아니라서 문제 삼지 않는다.
