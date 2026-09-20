# CityPack Format v1

A **CityPack** is one playable city, as data. It is the boundary between the
data pipeline and the game engine — see [`../LICENSING.md`](../LICENSING.md) for
why that boundary exists and why it is load-bearing.

Design goals, in priority order:

1. **Source-agnostic.** A pack built by hand, from OSM, or from Korean
   government open data is the same format. The engine cannot tell them apart
   and does not care.
2. **License-explicit.** Every pack declares its own obligations. The boundary
   is machine-checkable rather than tribal knowledge.
3. **Gameplay-first.** The format carries what the simulation needs, not
   everything the source happened to contain.

## Layout

```
packs/<pack-id>/
  manifest.json      required   identity, extent, licensing, file map
  demand.json        required   who travels, and where
  obstacles.json     optional   footprints for placement collision
  basemap.pmtiles    optional   visual basemap
  ATTRIBUTION.md     required when data.license != CC0-1.0
  LICENSE-DATA       required when data.license == ODbL-1.0
```

Only `manifest.json` and `demand.json` are needed to play. A pack with neither
basemap nor obstacles is valid and renders as abstract geometry — which is
exactly what Phase 1 uses.

All coordinates are `[longitude, latitude]` in WGS84. The engine handles local
projection; the format stays in a coordinate system every source can produce.
Distances are metres, durations seconds.

## manifest.json

```json
{
  "formatVersion": 1,
  "id": "example-grid",
  "name": "Grid City",
  "version": "0.1.0",
  "bbox": [-0.05, -0.05, 0.05, 0.05],
  "origin": [0.0, 0.0],
  "data": {
    "license": "CC0-1.0",
    "attribution": [],
    "sources": []
  },
  "files": {
    "demand": "demand.json"
  }
}
```

| Field | Meaning |
|---|---|
| `bbox` | Playable extent, `[minLon, minLat, maxLon, maxLat]` |
| `origin` | Anchor for the engine's local metric projection. Usually the bbox centre |
| `data.license` | SPDX id, or `proprietary`. Drives the engine's attribution UI |
| `data.attribution` | Strings the engine must display. Empty only for CC0 |
| `data.sources` | `{name, url, license}` — provenance for the pack, per source |
| `files` | Relative paths. Absent key = that layer is not present |

`data.license` is the field Rule 3 rests on. An OSM-derived pack sets
`ODbL-1.0` and ships `LICENSE-DATA`; a synthetic pack sets `CC0-1.0` and carries
no obligation.

## demand.json

The part with no off-the-shelf answer, and the reason this format exists rather
than reusing an existing one.

Two demand models are supported. A pack declares which one it uses.

### `model: "matrix"` — measured origin–destination

Real trip counts between points. Use when the source actually measured travel:
farecard tap data, transit surveys, mobile OD studies.

```json
{
  "formatVersion": 1,
  "model": "matrix",
  "points": [
    { "id": "n1", "location": [0.01, 0.01], "kind": "mixed" }
  ],
  "flows": [
    { "from": "n1", "to": "n7", "trips": 340, "dayType": "weekday", "period": "am_peak" }
  ]
}
```

### `model: "gravity"` — inferred from land use

Residents and jobs per point; the engine generates trips. Use when the source
describes *land use* rather than *travel*: census, employment statistics,
building attributes.

```json
{
  "formatVersion": 1,
  "model": "gravity",
  "points": [
    { "id": "n1", "location": [0.01, 0.01], "residents": 1200, "jobs": 80 }
  ]
}
```

> This split is deliberate and is where we diverge from `depot`, which models
> only the inferred case. Korean farecard data is *measured* OD; forcing it
> through a home→work inference would discard its main advantage. Conversely US
> LODES is inferential and should not be presented as measured.

### `attractors` — special demand

Optional in both models. Airports, universities, stadiums, beaches, malls,
military bases — places that generate trips out of proportion to their
residents and jobs.

```json
{
  "attractors": [
    {
      "id": "apt",
      "name": "International Airport",
      "kind": "airport",
      "location": [0.03, 0.02],
      "capacity": 20000,
      "maxDistance": 30000,
      "residentialSplit": 0.0
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `capacity` | Daily people generated or absorbed |
| `maxDistance` | Metres beyond which this attractor draws nobody. `null` = unbounded |
| `residentialSplit` | `0.0`–`1.0`. Share of `capacity` that *lives* on site rather than travelling in. A university with dorms is `> 0`; an airport is `0` |

`kind` is a free string. The engine may style known kinds and falls back to a
generic marker for unknown ones — packs must never be blocked by an engine that
has not heard of a category yet. Prefer the ids of the special-demand taxonomy
in [`subway-builder-reference.md`](./subway-builder-reference.md) §4
(`airport`, `university`, `sports_facility`, `hospital`, …) so engines can
share per-kind behaviour.

`decayExponent` (optional number > 0) sets how far this attractor draws from:
lower means it pulls harder from a distance, `2` is the plain gravity
baseline. Absent, the engine picks a default for the `kind`. Additive field —
does not bump `formatVersion`.

### `calendar` — day types and time of day

Optional in both models. Demand is not flat across the week or the day, and the
Korean sources make this unavoidable: the licence-clean feed (`OA-12252`) gives
an **hour-of-day** profile with no day-of-week split, so the weekday/weekend
dimension has to be carried as tunable pack data rather than baked into a single
averaged number. See [`data-sources-kr.md`](./data-sources-kr.md) for why.

```json
{
  "calendar": {
    "dayTypes": [
      { "id": "weekday",  "name": "평일",         "weight": 5 },
      { "id": "saturday", "name": "토요일",       "weight": 1 },
      { "id": "holiday",  "name": "일요일·공휴일", "weight": 1 }
    ],
    "periods": [
      { "id": "early",   "startMinute": 240,  "endMinute": 420 },
      { "id": "am_peak", "startMinute": 420,  "endMinute": 560 },
      { "id": "midday",  "startMinute": 560,  "endMinute": 1020 },
      { "id": "pm_peak", "startMinute": 1020, "endMinute": 1200 },
      { "id": "evening", "startMinute": 1200, "endMinute": 1500 }
    ],
    "factors": {
      "weekday":  { "early": 0.3, "am_peak": 2.6, "midday": 0.8, "pm_peak": 2.3, "evening": 0.7 },
      "saturday": { "early": 0.2, "am_peak": 0.9, "midday": 1.2, "pm_peak": 1.1, "evening": 0.8 },
      "holiday":  { "early": 0.1, "am_peak": 0.6, "midday": 1.1, "pm_peak": 0.9, "evening": 0.6 }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `dayTypes[].weight` | Days per week of this type. Used to derive an average day |
| `periods[].startMinute` / `endMinute` | Minutes from service-day start. May exceed 1440 for after-midnight service, matching how Korean feeds bucket "24시 이후" |
| `factors[dayType][period]` | Multiplier on baseline demand |

Periods must tile the service day without gaps or overlaps, and `factors` must
cover every `dayType` × `period` combination. The validator enforces both.

Under `gravity`, factors scale generated trips. Under `matrix`, a flow may name
its own `dayType` and `period`; flows that do not are treated as daily totals
and scaled by `factors`.

Packs without a `calendar` behave as a single undifferentiated average day.

## obstacles.json

Footprints that block track and station placement. **Optional, and possibly
unnecessary** — a Mini Metro-style abstraction has no per-building collision at
all, and that decision belongs to Phase 1, not here.

```json
{
  "formatVersion": 1,
  "obstacles": [
    { "kind": "building", "polygon": [[0.01,0.01],[0.011,0.01],[0.011,0.011]] }
  ]
}
```

Note that this is a **separate structure from the basemap**, and intentionally
so. Rendering and collision are different problems: a renderer such as MapLibre
draws tiles but cannot answer "is a building here", so gameplay queries this
file rather than the tiles. Do not merge them.

Both files are ODbL Derivative Databases when OSM-derived (Rule 2).

## Versioning

`formatVersion` is an integer, incremented on breaking change. The engine
refuses packs whose `formatVersion` it does not implement. Additive fields do
not bump it — unknown keys must be ignored, never rejected.
