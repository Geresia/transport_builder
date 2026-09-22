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
`../packs/example-radial` by default; pick another pack with
`?pack=../packs/<id>` (e.g. `../packs/example-corridor` for the matrix model).

## Two start modes

A pack that carries `files.existingNetwork` (currently only `tokyo`, see
`../packs/tokyo/README.md` § "Existing rail network") can be played two ways,
picked by a `?network=` param on the same URL — the pack and its data are
identical either way, only what's already drawn on the map at load differs:

- **existing** (default): today's real rail/subway/tram network is pre-drawn
  as starting lines. Play from there — extend it, add branches, leave it be.
- **scratch** (`?network=scratch`): the file is ignored and play starts from
  a blank map, same as any pack without `existingNetwork`.

`src/main.mjs`'s `seedExistingNetwork()` does this once at load, via the same
`addLine()` every player-drawn line goes through — a preloaded line is a
completely ordinary line afterwards (renameable, deletable, extendable). The
legend's **기존 철도망 / 빈 지도** row (`syncNetworkModeUI()`) shows which mode
is active and links to the other one. A player can also reach the "scratch"
state from "existing" mid-game with the existing **Clear lines** button —
`?network=` only controls what's on the map when the pack first loads.

## How it works

| File | What |
|---|---|
| `src/pack.mjs` | Fetches and parses a pack's `manifest.json`/`demand.json` |
| `src/projection.mjs` | lon/lat → local metres → canvas pixels; static fit-to-bbox camera, no pan/zoom yet |
| `src/state.mjs` | Stations (from the pack), lines, trains, passengers |
| `src/network.mjs` | Builds a `(station, line)` routing graph from the drawn lines |
| `src/routing.mjs` | Dijkstra over that graph, with a transfer penalty on line changes |
| `src/demand-engine.mjs` | Gravity and matrix demand models behind one `rate`/`pick` interface, plus the `calendar` time-of-day factor |
| `src/mode-choice.mjs` | Walking / driving / transit choice per trip |
| `src/passengers.mjs` | Spawning, route retries, abandonment, board/alight |
| `src/trains.mjs` | Dispatches trains at the current band's headway and moves them out and back |
| `src/input.mjs` | Drag across stations to lay a line |
| `src/geometry.mjs` | Transit-diagram geometry: 0/45/90-degree legs between stations, shared legs fanned side by side, point-along-polyline for trains |
| `src/render.mjs` | Canvas drawing: the network as a transit diagram (line legs, white station markers, larger at interchanges, letter badges, station names), demand discs, attractors, trains |
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
- **Capacity is scaled down.** A car holds 12 passengers (Subway Builder: 240)
  because this engine's passenger volume is tuned small; a full train leaves
  the rest waiting. Cars per train (1-15) is set per line. Trains dwell 20 s
  at each stop (Subway Builder's `STATION_STOP_TIME`) but still run at a
  constant speed — no acceleration, gradients or signals.
- **Riders board regardless of direction on the outbound leg**, and only for
  stations still ahead on the return leg, so nobody is stranded when a train
  retires. A real timetable-aware boarding rule is not implemented.
- **Frequency is trains/hour per demand band** (High/Medium/Low/Very Low),
  after Subway Builder's Route Details panel. Trains are dispatched from the
  line's first station at that headway, run out and back, then retire. The
  hour-to-band table (`BANDS` in `state.mjs`) is the engine's own default
  timetable; it schedules trains only and does not shape passenger demand.
- **No money.** Subway Builder's funds, per-hour cost and per-car operating
  cost have no counterpart yet — the bottom bar has no funds readout on
  purpose rather than a fake one.
- **Mode choice is a lowest-noisy-travel-time pick** among walking (1 m/s),
  driving (30 kph x 1.3 road factor + 5 min parking) and transit (in-vehicle
  time + half the headway). Only transit riders reach stations; drivers and
  walkers are just counted in the mode share. The speeds are engine choices,
  not calibrated. Departure times count every trip, but "Transit Arrival
  Times" counts transit deliveries only — walkers and drivers have no
  arrival event.
- **No construction cost.** Lines are free and instant. Subway Builder's
  tunnel/viaduct/cut-and-cover tradeoffs are Phase 2/3 economy territory.
- **The diagram is schematic in line shape only.** Stations keep their projected positions; each leg between two stations is one diagonal run plus one straight run. Legs shared by several lines are offset per leg, so a line's stroke can step sideways at a station where the set of lines sharing changes. Station names are drawn only for points the pack actually names (`name`), and on packs over 40 stations only where a line stops.
- **No pan/zoom.** The camera fits the whole `bbox` once, on load and resize.
- **Demand models**: `gravity` and `matrix` both run. Matrix flows follow
  `../docs/citypack-format.md` (a flow naming a period is that many trips in
  the period; otherwise a daily total scaled by the calendar factor), then
  scaled to a legible rate like gravity. Matrix packs have no residents/jobs,
  so station size on screen comes from each point's total trip volume.
- **Measured O/D (optional).** If the pack declares `files.od` (`od.json`: census home->work flows between the demand points' municipalities) and/or `files.odSchool` (`od-school.json`, same shape, home->school flows), `gravity` takes two things from them (`src/od-flows.mjs`, wired in `buildDemandModel(state, demand, od, odSchool)`): destinations are picked from the measured shares, and each origin's spawn volume is proportional to its real trip-makers (`od.workers + odSchool.students`) instead of total residents. When both files are present their rows are merged into one pool per origin — this engine has no separate "commuter" vs "student" trip kind, so a station just sees more trips, not two kinds of them. The pack-wide spawn volume is unchanged (same total as gravity) either way, so it redistributes trips rather than adding any. Own-municipality, unknown-workplace/school and out-of-region flows are dropped; an origin without a row in either file keeps its gravity volume and destinations. `?od=0` forces plain gravity, ignoring both files. Note: before 2026-09-22 the tokyo pack's demand points carried no `jobs`, so plain gravity had no destinations there at all; every point now carries an O/D-derived workplace-here count (`scripts/tokyo-demand-jobs.mjs`), so plain gravity (`?od=0`) works too, just less accurately than the measured O/D. Test: `node engine/test/od-demand.test.mjs`.
- **Attractor decay exponent** (`decayExponent`, or a per-`kind` engine
  default) sets how far an attractor pulls trips from — see the format doc.
  The per-kind defaults are this engine's own numbers.
- **Trip volume is tuned for legibility, not realism** (`demand-engine.mjs`'s
  `TRIPS_PER_RESIDENT_PER_SIM_MINUTE`) — a handful of visible passengers per
  station, not population-accurate throughput.
