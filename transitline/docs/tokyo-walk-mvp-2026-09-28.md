# 도쿄 워크 MVP — 기술 정리

- 기준일: 2026-09-28
- 파일: [`packs/tokyo/walk.html`](../packs/tokyo/walk.html) (독립 페이지, `viewer.html`과 분리)
- 계기: [sf.thijs.gg](https://sf.thijs.gg/) ("San Francisco — The Game", Thijs Simonian 제작)를 보고
  "우리도 실제 도시를 걸어다니는 걸 만들 수 있나" 질문에서 시작. 다만 프로젝트 본 방향은
  건설 시뮬레이션([work-division-after-depot-2026-09-26.md](work-division-after-depot-2026-09-26.md))이라
  워크 모드는 부가 MVP로 취급한다.

## 1. sf.thijs.gg는 뭘로 만들었나 (조사 결과)

공식 저장소나 기술 블로그 글은 찾지 못했고, 아래는 언론 보도와 Hacker News 댓글 스레드에서
나온 설명을 종합한 것이다 (1차 소스 아님, 참고용).

- 데이터: Apple Maps/MapKit 유래 지도 데이터
- 제작 도구: OpenAI GPT-5.6 "Sol" 모델을 Codex 안에서 사용해 제작했다고 본인이 밝힘
- 렌더링: Hacker News 댓글들이 "포토그래메트리 렌더링과 WebGL 타일 스트리밍"이라고 설명 —
  즉 실사에 가까운 3D 메시를 WebGL로 그리고, 카메라 이동에 맞춰 타일을 점진적으로 불러오는 방식
- 기능: 1인칭/3인칭 도보, 차량 탈취, 행글라이더, 주소 텔레포트, 실시간 멀티플레이어
- 출처: [Thijs's Portfolio](https://thijs.gg/), [San Francisco — The Game](https://sf.thijs.gg/),
  [Hoodline 기사](https://hoodline.com/2026/08/stanford-student-turns-real-san-francisco-into-a-gta-style-web-game/),
  [Runtimewire 기사](https://runtimewire.com/article/a-stanford-builder-turns-apple-maps-into-a-playable-san-francisco-game),
  [IBM Think 기사](https://www.ibm.com/think/news/ai-video-game-recreates-san-francisco),
  GitHub [tandpfun](https://github.com/tandpfun) (본인 계정이지만 이 프로젝트 저장소는 공개돼 있지 않음 — 확인 시점 기준)

## 2. 우리가 실제로 쓴 기술

sf.thijs.gg와 달리 **새 3D 엔진이나 포토그래메트리 파이프라인을 만들지 않았다.** 이 저장소에
이미 있던 지도 스택을 그대로 재사용해서 "걷는 느낌"만 얹었다 (ponytail: 이미 있는 것 재사용 > 새로 만들기).

| 구성 요소 | 실제 사용 기술 | 참고 |
|---|---|---|
| 렌더러 | [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) (WebGL 기반 벡터 타일 지도 라이브러리, BSD 오픈소스, Mapbox GL JS의 커뮤니티 포크) | `viewer.html`이 이미 쓰던 것과 동일 버전(5.24.0) |
| 타일 포맷/전송 | [PMTiles](https://github.com/protomaps/PMTiles) — 단일 파일에 벡터 타일을 담아 HTTP Range 요청으로 필요한 부분만 읽는 포맷 (Protomaps 프로젝트) | `basemap.pmtiles`, `tokyo-survey-buildings.pmtiles` |
| 3D 건물 | MapLibre의 `fill-extrusion` 레이어 타입 — 폴리곤을 속성값(층수) 기반 높이로 압출(extrude) | 새 지오메트리 계산 없이 MapLibre 내장 기능만 사용 |
| "걷는" 카메라 | 포토그래메트리·게임 카메라가 아니라 **MapLibre 지도 카메라를 pitch 82°까지 눕힌 것** — 원래 새를 보는 시점인 지도를 거의 눕혀서 street-level처럼 보이게 하는 트릭 | MapLibre `pitch`/`maxPitch` 옵션 |
| 이동(WASD) | 새 물리엔진·충돌판정 없음. `bearing` 각도로 회전한 전/측 방향 벡터를 구 표면 근사식(위도 1도≈111,320m)으로 위경도 변화량으로 환산해 `map.jumpTo()`로 카메라 중심을 옮기는 30줄 내외 직접 구현 | `walk.html`의 `moveBy()` |
| 색 팔레트 | `viewer.html`의 `THEME`(light, 네이버 지도풍 배색)을 그대로 복사 | 두 파일이 같은 색을 쓰게 하기 위함 |

## 3. 데이터 출처와 라이선스

- **건물**: `tokyo-survey-buildings.pmtiles` — 東京都 令和3年度 区部土地利用現況調査
  (도쿄도 23구 토지이용현황조사, CC BY 4.0). `levels`(층수) 실측값 보유, 폴리곤은 실제 건물 footprint.
  높이는 `층수 × 3.2m`(층수 미상 시 2층 가정) — `viewer.html`의 `TOKYO_HEIGHT` 규칙과 동일.
- **도로·수역·토지피복**: `basemap.pmtiles` — OpenStreetMap 유래 데이터(ODbL), Protomaps로 가공.
- 두 파일 모두 이 팩(`packs/tokyo/`)에 이미 존재하던 것을 재사용했다. 새로 내려받거나 가공하지 않았다.

## 4. 지금 버전이 하는 일 / 안 하는 일

**함:**
- 도쿄 23구 아무 지점이나 실제 건물 배치·층수 기반 3D 매스로 렌더링
- WASD로 이동, 드래그로 시점 회전 (MapLibre 기본 제스처)
- 지도(`viewer.html`)와 동일한 배색

**의도적으로 안 함 (ponytail — 필요해지면 그때 추가):**
- 건물 충돌 판정 없음 (벽을 그냥 통과)
- 차량 탈취·행글라이더·멀티플레이어 없음
- 23구 밖(사이타마·지바·가나가와 등) 건물 소스는 아직 안 이어붙임
- 지형 고도(언덕·경사) 미반영 — 평면 위를 걷는 것처럼 보임

## 5. 참고 자료

- MapLibre GL JS 공식 문서: <https://maplibre.org/maplibre-gl-js/docs/>
- MapLibre `fill-extrusion` 레이어 스펙: <https://maplibre.org/maplibre-style-spec/layers/#fill-extrusion>
- PMTiles 포맷/프로토콜: <https://github.com/protomaps/PMTiles>
- sf.thijs.gg 관련 보도 (§1의 출처 목록과 동일)
- 이 저장소 안 선행 문서: [map-plan-contract.md](map-plan-contract.md) (지도 쪽 데이터 계약·라이선스 규칙)
