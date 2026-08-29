# Licensing Architecture

> Working notes for the project's legal boundary. Not legal advice.
> Get counsel on the CityPack boundary **before launch**, not before starting.

The game is intended to be **sold commercially** while using **real-world
geographic data**. Those two goals conflict unless the encumbered data is kept
physically separate from the sellable software. That separation is the whole
reason this repo is structured the way it is.

## Three layers

| Layer | Ships to players? | License | Why |
|---|---|---|---|
| **Pipeline** (`pipeline/`) | **No** — dev-time only | May be GPLv3 | Free to fork GPLv3 tools (e.g. `depot`) as long as it never reaches a player |
| **CityPack** (`packs/`) | Yes, as data | ODbL when OSM-derived | Share-alike is satisfied here and stops here |
| **Engine** (`engine/`) | Yes | Proprietary | Reads CityPacks through a documented format; inherits nothing |

ODbL is a *database* license. It does not reach the software that reads the
database. Publishing the derived database (the CityPack) discharges share-alike;
the engine, simulation, UI, art and audio remain proprietary and sellable.

## Rule 1 — the pipeline never ships

GPLv3 §5 attaches to a work **as distributed**. The "separate program" argument
holds only while the pipeline stays a build-time tool.

It collapses the moment the pipeline is:

- bundled into the game binary,
- exposed as an in-game map importer,
- shipped as a downloadable companion tool for players.

If any of those become product requirements, that pipeline **must be written
from scratch** under our own license. Maps are baked at authoring time and
shipped only as CityPacks.

## Rule 2 — queryable OSM geometry lives only in the CityPack

Treat all of the following as an ODbL **Derivative Database**:

- vector tiles (PMTiles / MVT) containing OSM geometry
- building footprint indexes used for placement collision
- road / rail graphs derived from OSM

Whether vector tiles qualify as a "Produced Work" (attribution only) rather than
a Derivative Database (share-alike) is genuinely contested. We take the
conservative reading as a **design constraint**, not as a question to resolve
later. Betting a commercial product on the optimistic reading is the worst
available option, and the three-layer split already absorbs the cost.

Rendered raster images produced from OSM *are* Produced Works, and may be used
under attribution alone — but do not design gameplay around that distinction.

## Rule 3 — every pack declares its own license

`manifest.json` carries `data.license` and `data.attribution`. This makes the
legal boundary machine-checkable: a pack built from public-domain or synthetic
sources is marked as such and carries no obligation, while an OSM-derived pack
is marked ODbL and must be published. The engine surfaces attribution from this
field; nothing is hardcoded.

## Data source notes

| Source | License | Notes |
|---|---|---|
| OpenStreetMap | ODbL 1.0 | Attribution + share-alike on derived databases |
| Overture Maps | CDLA-Permissive 2.0 | **But** OSM-sourced records inside carry ODbL — filter by source |
| US Census LODES | Public domain | US only |
| Natural Earth | Public domain | Coarse; good for basemap context |
| KR 서울 지하철 시간대별 승하차 `OA-12252` | **공공누리 제1유형** | ✅ Usable. Hourly, 1~9호선, CSV+API |
| KR 코레일 광역철도 `15154382` | 이용허락범위 제한 없음 | ✅ Usable. Fills the non-Seoul rail gap |
| KR 서울 대중교통 O/D `OA-20501` | **공공누리 제1유형** | ⚠️ Files appear missing — verify manually |
| KR 서울교통공사 일별·시간대별 `OA-12921` | 공공누리 제3유형 (변경금지) | ❌ **Unusable** — we must transform |
| KR 교통카드 빅데이터 (STCIS) | 데이터안심구역 승인 필요 | ❌ Not extractable from their environment |
| KR SGIS (통계지리정보서비스) | Terms vary — verify | Population / establishment grids. Not yet surveyed |
| Synthetic / hand-authored | Ours | No obligation at all |

Korean public data uses **공공누리 (KOGL)** types, and only **제1유형** works
for us: a commercial product that *transforms* the data needs both commercial
use and derivative works. 제3유형 is the trap — it permits commercial use but
forbids 변경, which is exactly what our pipeline does. Each source needs its own
check, separate from the ODbL analysis above.

Full source-by-source verdict, including the weekday/weekend blocker and the
recommended way around it: [`docs/data-sources-kr.md`](./docs/data-sources-kr.md).

## What we do not touch

- The name "Subway Builder", its logo, and identifiers such as
  `SubwayBuilderAPI` or `metro-maker4`. Trademark is the one place with real
  exposure from the game's side, and compliance costs nothing.
- Verbatim code from any GPLv3 repo, inside the engine.

Game *mechanics and genre* are not copyrightable and are not a concern.
