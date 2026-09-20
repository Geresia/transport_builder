# Engine — Phase 1

The game loop, per the build order in `../README.md`: draw lines between a
CityPack's stations, trains run them, passengers generated from the pack's
`gravity` demand model find routes and get delivered.

Genre reference is [Subway Builder](https://store.steampowered.com/app/4039140/Subway_Builder/)
(real demand simulation, player-named/colored routes, frequency control),
not Mini Metro's abstract puzzle style — `../LICENSING.md` already carves out
the name/identifiers as a trademark to avoid, which is a signal of how
directly this project takes after it. Phase 1 only borrows the pieces that
fit a small hand-authored pack: route naming/color/frequency are in; real
construction cost and commuter-level tradeoffs are Phase 2/3 territory.

Proprietary layer per `../LICENSING.md` — reads CityPacks only through the
documented format (`../docs/citypack-format.md`), never touches OSM geometry
directly. No basemap or obstacles rendering: a pack with neither "renders as
abstract geometry — which is exactly what Phase 1 uses."

Vanilla JS ES modules + Canvas 2D, no dependency, no build step, matching
every other tool in this repo.

## Run it

`fetch()` refuses `file://`, so this needs an HTTP server. Reuse the one in
`../docs/`:

```powershell
powershell -File ../docs/serve.ps1 -Root .. -Index engine/index.html
```

Then open `http://localhost:8000/engine/index.html`. It loads
`../packs/example-radial` by default; pick another gravity-model pack with
`?pack=../packs/<id>` (matrix-model packs like `example-corridor` aren't
supported yet — see `src/pack.mjs`).

## How it works

| File | What |
|---|---|
| `src/pack.mjs` | Fetches and parses a pack's `manifest.json`/`demand.json` |
| `src/projection.mjs` | lon/lat → local metres → canvas pixels; static fit-to-bbox camera, no pan/zoom yet |
| `src/state.mjs` | Stations (from the pack), lines, trains, passengers |
| `src/network.mjs` | Builds a `(station, line)` routing graph from the drawn lines |
| `src/routing.mjs` | Dijkstra over that graph, with a transfer penalty on line changes |
| `src/demand-engine.mjs` | Gravity-model trip distribution + `calendar` time-of-day factor |
| `src/passengers.mjs` | Spawning, route retries, abandonment, board/alight |
| `src/trains.mjs` | Dispatches trains at the current band's headway and moves them out and back |
| `src/input.mjs` | Drag across stations to lay a line |
| `src/render.mjs` | Canvas drawing |
| `src/loop.mjs` | Fixed-ratio sim tick + render, updates the HTML HUD |
| `src/main.mjs` | Wires everything together; also owns the UI panels: routes list, Route Details (name, per-band frequency, delete), Analysis, and the bottom bar (pause/1x/2x/4x, Day/clock; Space toggles pause) |

## Known Phase 1 simplifications

Not bugs — deliberate scope cuts to get a playable loop first:

- **Stations are exactly `demand.json.points`.** The player never places new
  ones.
- **Attractors aren't boardable.** They have their own `location` in the
  format, but Phase 1 has no notion of a station that isn't a pack point, so
  `demand-engine.mjs` folds each attractor's generated trips into its
  *nearest* station instead. This is an engine choice, not part of the
  format's own semantics — revisit if attractors need their own presence on
  the map.
- **No train capacity or crowding.** Boarding is unlimited. Phase 3
  ("simulation depth — trains, capacity, crowding, economy") owns this.
- **Frequency is trains/hour per demand band** (High/Medium/Low/Very Low),
  after Subway Builder's Route Details panel. Trains are dispatched from the
  line's first station at that headway, run out and back, then retire. The
  hour-to-band table (`BANDS` in `state.mjs`) is the engine's own default
  timetable; it schedules trains only and does not shape passenger demand.
- **No money.** Subway Builder's funds, per-hour cost and per-car operating
  cost have no counterpart yet — the bottom bar has no funds readout on
  purpose rather than a fake one.
- **Analysis shows what this engine actually measures**: delivered vs.
  abandoned, and departure/arrival counts by hour. Subway Builder's
  transit/driving/walking mode share needs a mode-choice model we don't have.
- **No construction cost.** Lines are free and instant. Subway Builder's
  tunnel/viaduct/cut-and-cover tradeoffs are Phase 2/3 economy territory.
- **No pan/zoom.** The camera fits the whole `bbox` once, on load and resize.
- **Only the `gravity` demand model.** `example-corridor`'s `matrix` model
  needs a different demand engine, not built yet.
- **Trip volume is tuned for legibility, not realism** (`demand-engine.mjs`'s
  `TRIPS_PER_RESIDENT_PER_SIM_MINUTE`) — a handful of visible passengers per
  station, not population-accurate throughput.
