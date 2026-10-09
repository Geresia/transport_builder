# B21–B24 Unity construction mode: execution roadmap

## Decision boundary

The game remains a JavaScript 2D simulation at every stage of this roadmap.
Unity is an optional, construction-only spatial client.  It may inspect a
versioned scene manifest and return a proposed change set, but it never owns or
calculates cash, the ledger, demand, passengers, timetables, RNG, or the game
clock.  A missing, failed, incompatible, or stale client must leave the 2D
game usable in `2d-only` mode.

This is an execution roadmap, not a claim that a Unity binary has been shipped.
There is no Unity project or WebGL/desktop loader in this repository yet.

## What is already implemented and integrated

| Boundary | Current artifact | Host status |
| --- | --- | --- |
| B20 programme data | regional-development editor, campaign lifecycle, activation, fact report, timeline panel | mounted in `main.mjs`, serialised with the integrated save |
| B21 exchange | `construction-3d-exchange.mjs` | deterministic scene/change-set contracts and source/revision/coordinate checks |
| B21 client gate | adapter, session coordinator, coordinate profile and preflight panel | mounted in `main.mjs`; no client is invented, therefore it currently reports `2d-only` |
| B22 source/review | source adapters and spatial-review contract | converts existing rail/station/depot/new-town facts only; no mesh or engineering verdict is invented |
| B23 staging | stage manifest | presents existing construction/workfront facts; it does not advance work or time |
| B24 guard | preflight, integration audit, benchmark | checks pack, source identity, revisions, coordinate frame and 2D fallback without loading a renderer |

The relevant source modules are under `engine/src/construction-3d-*.mjs` and
their tests are under `engine/test/construction-3d-*.test.mjs`.

## Non-negotiable data flow

```text
2D map documents + current runtime facts
        -> B22 source adapters
        -> B21 deterministic scene manifest
        -> optional Unity client
        -> proposed B21 change set / B22 review
        -> JavaScript validation + existing 2D approval route
        -> saved 2D state only
```

No arrow may bypass source-pack, revision, or coordinate-frame validation.
The saved host document retains client identity and selected reference IDs, not
a Unity/WebGL binary, renderer state, GPU resource, or mutable Unity world.

## Delivery order after B20

### B21-P2 — real client loader and handshake

Add a small host-owned loader behind an explicit player action.  It must load a
WebGL build or desktop bridge only after `assessConstruction3dSession()` reports
`3d-available`.  The loader supplies the existing adapter handshake:

- protocol `transitline.construction-3d-adapter/1`;
- client ID, version, and capability list;
- the exact scene-manifest JSON;
- a timeout/error path that returns the host to `2d-only` without changing game
  state.

Acceptance evidence: unavailable, incompatible, timeout, malformed message,
and successful handshake tests; a browser smoke test; and proof that a failed
load leaves the game snapshot unchanged.

### B22 — Unity scene presentation and spatial review transport

Render only the geometry carried by the scene manifest.  Rail alignments,
station/depot locations, and new-town polygons are visual inputs, not inferred
terrain or hidden engineering data.  Missing source geometry stays visibly
unknown rather than receiving a plausible substitute.

Unity may return `clear`, `conflict`, or `unknown` spatial facts in the existing
review/change-set vocabulary.  JavaScript must reject foreign-pack, stale,
inactive, missing-source, or mismatched-coordinate results before an existing
2D approval path sees them.

Acceptance evidence: a fixture scene for Tokyo and a synthetic pack; round-trip
tests for all three review states; and screenshots that distinguish missing
geometry from a measured clear result.

### B23 — construction-stage presentation

Use the current stage manifest as a time-slice input.  The Unity view can show
the declared package/workfront/site status and approved temporary geometry, but
may not calculate construction progress, completion dates, cost, or delay.

Acceptance evidence: stage switching changes presentation only; no stage event
or clock movement is emitted by Unity; and stale package/site references are
refused rather than rebound automatically.

### B24 — end-to-end release gate

Run two comparable scenarios: 2D-only and a connected optional client.  Verify
that the same source snapshot produces the same scene manifest, that all
proposals still pass JavaScript validation, and that save/load contains no
renderer payload.  Measure startup, manifest construction, and teardown with
the existing benchmark helper; publish measured results rather than estimates.

The release gate must cover:

1. unavailable and failed client fallback;
2. wrong pack, stale source revision, unknown source pack, and incompatible
   coordinate profile;
3. malformed/partial proposed change set;
4. Tokyo plus a synthetic pack save/load and manifest determinism;
5. no mutation of cash, ledger, demand, passengers, timetable, RNG, or clock
   from the optional-client path.

## Explicitly deferred decisions

- Whether the first concrete client is Unity WebGL, a desktop Unity bridge, or
  both.  The adapter keeps this choice outside simulation state.
- Asset pipeline, terrain textures, rendering quality, and GPU minimum specs.
- Any expansion from construction-only 3D into normal gameplay.  This requires
  a new product decision after B24 evidence; it is not an implied consequence
  of adding a loader.
