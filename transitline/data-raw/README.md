# data-raw

내려받은 원본 데이터를 두는 폴더다. 용량이 커서 대부분 git에 올리지 않는다(`.gitignore`). 이 폴더를 통째로 잃어도 아래 표대로 다시 받을 수 있다. 다만 시간이 걸리는 것들이 있어서 백업해 두는 게 낫다.

2026-09-21 기준 약 3.0GB.

| 폴더 | 크기 | git | 무엇 | 다시 받는 법 |
|---|---|---|---|---|
| `terrain/` | 1.3GB | 무시 | 国土地理院 標高タイル DEM10B (z14 12,793장)와 거기서 만든 경사도 | [`terrain/README.md`](./terrain/README.md). `scripts/tokyo-dem-download.mjs`, 약 40분 |
| `plateau/` | 1.1GB | 무시 | PLATEAU 3D Tiles, 사이타마시 (`11100_saitama-shi_2020_3Dtiles_etc_1_op.zip`. 여기서는 `saitama-3dtiles-etc.zip`으로 저장) | G空間情報センター(geospatial.jp)의 PLATEAU 사이타마시 3D Tiles. 자세한 건 `docs/data-sources-kanto-3pref.md` |
| `od2020/` | 465MB | 결과 JSON 5개만 추적, 나머지 무시 | 令和2年国勢調査 통근 OD(`e03-{11,12,13,14}-01.xlsx`)와 시정촌 인구(`t1-1.xlsx`) | e-Stat. statInfId 000032214185 / 188 / 196 / 199 (도도부현 11·12·13·14 순서), 인구는 000032214141. 파싱은 `scripts/od-parse-2020.mjs`, `scripts/muni-pop-2020.mjs` |
| `mlit/` | 154MB | 무시 | 国土数値情報 P29-23 학교(2023), P04-20 의료기관(2020). 도도부현 11–14 | 国土数値情報 다운로드 사이트에서 코드별, 도도부현별 GML. 사용은 `scripts/tokyo-special-demand.mjs` |
| `emp2020/` | 8MB | 무시 | 令和2年国勢調査 町丁 단위 취업자 CSV (`h16_02_{11..14}.csv`, Shift-JIS) | e-Stat. statInfId 000032226887 / 888 / 889 / 890 (사이타마·지바·도쿄·가나가와). 사용은 `scripts/tokyo-employed.mjs` |
| `rail-network/` | 38MB | 무시 | OSM route=train/subway/light_rail/tram 관계 원본 (Overpass, 간토 bbox) — 여기서 `packs/tokyo/existing-network.json`(실제 철도망, 게임 시작 노선)을 만듦 | Overpass API (kumi.systems / monicz.dev). `scripts/tokyo-existing-network.mjs`, 약 5분 |

도도부현 번호는 11 사이타마, 12 지바, 13 도쿄, 14 가나가와다.

## git에 올라간 것

`od2020/`의 `muni-pop-2020.json`, `od-11.json` ~ `od-14.json` 5개는 크기가 작고 팩을 다시 만들 때 바로 쓰여서 추적한다. 원본 xlsx와 압축 해제 폴더(`x*/`), `mismatch.json`은 무시한다.

## 백업

원본 전체를 클라우드나 외장 디스크에 zip으로 따로 둔다. GitHub에는 파일당 100MB 제한이 있고, 올리면 히스토리에 영구히 남기 때문이다. 다시 받기 번거로운 순서는 이렇다.

1. `terrain/gsi-dem10/` — 받는 데 40분
2. `plateau/` — 1.1GB
3. `od2020/`, `emp2020/` — e-Stat 화면에서 직접 눌러 받아야 하는 파일이라 번거롭다

## 라이선스

재배포 조건은 원본마다 다르다. 이 폴더는 로컬 작업용이고 배포하지 않는다. 팩에 들어가는 파생물의 출처 표기는 `packs/tokyo/ATTRIBUTION.md`에 있다.
