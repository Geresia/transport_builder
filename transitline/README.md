# Transitline

A transit network building game for the Seoul metropolitan rail area.
*(Working name — rename freely; nothing depends on it yet.)*

**Target extent:** 서울 · 경기 · 인천 · 춘천(경춘선) · 충청 남부(1호선 천안·아산·신창)
— roughly `[126.35, 36.72, 127.80, 38.15]`, ~128 × 159 km, ~26.5M people.

## Status

**Phase 0 — CityPack format.** Complete. The format, its schemas, a validator
with teeth, and two synthetic packs exercising both demand models.

Nothing here touches OpenStreetMap or any licensed data yet, by design.

## Why the structure looks like this

The project sells commercially **and** uses real-world geographic data. Those
goals conflict unless the encumbered data is kept physically separate from the
sellable software. Everything follows from that:

```
pipeline/   dev-time only, never ships   →   may be GPLv3
packs/      the map data, published      →   ODbL when OSM-derived
engine/     the game, sold               →   proprietary, inherits nothing
```

Read [`LICENSING.md`](./LICENSING.md) before touching data or adding a
dependency. The two rules that matter are short and non-obvious:

1. **The pipeline never ships to players.** Bundling it collapses the separate-
   program argument and makes the game a GPLv3 derivative work.
2. **Queryable OSM geometry lives only in a CityPack**, never in the engine.

## Layout

| Path | What |
|---|---|
| [`docs/citypack-format.md`](./docs/citypack-format.md) | The format spec — the boundary between data and game |
| [`docs/data-sources-kr.md`](./docs/data-sources-kr.md) | Korean demand data survey: what is usable, what is not, why |
| [`schemas/`](./schemas/) | JSON Schema for manifest and demand — **reference only**, see note below |
| [`scripts/validate-pack.mjs`](./scripts/validate-pack.mjs) | Pack validator — shape *and* licensing rules |
| [`packs/example-radial/`](./packs/example-radial/) | Synthetic radial city, `gravity` model |
| [`packs/example-corridor/`](./packs/example-corridor/) | Synthetic corridor, `matrix` model + calendar |

## Usage

```bash
node scripts/validate-pack.mjs packs/example-radial   # validate one pack
npm run validate                                       # validate all packs
npm run regen                                          # regenerate example demand data
```

No dependencies, no install step. The validator is dependency-free on purpose:
it runs in CI before anything is installed, and it enforces the licensing
boundary rather than just JSON shape.

> **The JSON Schemas are not enforced.** Nothing loads `schemas/*.json` — they
> exist for editor autocomplete and as human-readable reference.
> `validate-pack.mjs` hand-rolls its checks and is the authoritative definition
> of the format. The two can drift; when they disagree, the validator wins.
> Keeping them in sync is currently manual.

## Build order

| Phase | What | State |
|---|---|---|
| **0** | CityPack format, schemas, validator | **done** |
| **1** | Game loop on a hand-authored pack — stations, lines, passenger routing | next |
| **0.5** | One-off: 수도권 population density render (exploration, not the pipeline) | done |
| **2** | Pipeline: OSM + Korean open data → real CityPacks | blocked on data access, see below |
| **3** | Simulation depth — trains, capacity, crowding, economy | later |

Phase 1 deliberately uses `example-radial` and touches no real data. Prove the
game is fun before paying the cost of Phase 2.

## Population density render

A one-off exploration, not Phase 2. `scripts/build-metro-demand.mjs` joins
행정안전부 주민등록 인구 to SGIS-derived 행정동 boundaries for 서울·인천·경기 —
1,187 dong, 26,066,115 people, zero unmatched — and emits per-dong area and
density. Both inputs permit commercial use and modification; **both require
attribution unconditionally**, which the render carries on-page.

## The open question for Phase 2

**No licence-clean source of weekday-vs-weekend demand was found.** The dataset
that would answer it outright (`OA-12921`, daily × hourly, 2008–2025) is
공공누리 **제3유형 — 변경금지**, so a transformed commercial product cannot use
it. The richest source (교통카드 빅데이터 / STCIS) is reachable only inside a
데이터안심구역 and cannot be extracted.

The recommended answer is to **model** the day-type dimension rather than source
it, calibrated against the licence-clean hourly profile. That is why `calendar`
is first-class in the format instead of a single averaged day.

**Half of the hole behind it is now closed.** Boarding/alighting counts only
*calibrate* a gravity model — they cannot populate one, which needs `residents`
and `jobs` per point. `residents` is **solved**: 행정안전부 주민등록 인구
gives all 1,187 수도권 행정동 under 이용허락범위 제한 없음, joined 1:1 against
SGIS-derived boundaries (see the density render below). **`jobs` is the
remaining gap** and is now the highest-priority unknown.

Full source-by-source verdict:
[`docs/data-sources-kr.md`](./docs/data-sources-kr.md).
