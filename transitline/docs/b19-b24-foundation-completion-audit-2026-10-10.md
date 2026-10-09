# B19–B24 foundation completion audit

## Scope of this audit

This audit closes the requested **roadmap and foundation** work through B24.
It does not claim that a Unity executable, WebGL bundle, renderer, mesh asset
pipeline, or 2D/3D visual round trip has shipped.  Those are deliberately
separate implementation work after a Unity client project exists.

The authoritative simulation remains JavaScript 2D.  Every optional-3D module
is a data contract, validator, preflight, or display-only boundary and is
covered by the no-management/no-storage boundary test.

## Evidence by milestone

| Milestone | Delivered foundation | Authoritative evidence |
| --- | --- | --- |
| B19 | player-authored new-town geometry; lifecycle, contribution, candidate, intake, and explicit source records; management panels, map overlay, and integrated-save wiring | B19 integration audit; main mounts M2–M6; E1–E5 records are transactional and revision/pack checked |
| B20 | 30-year read-only campaign time; regional-program map document; lifecycle, activation, fact report; lifecycle, activation, and timeline command surfaces | real-runtime B20 campaign audit; main passes per-program geometry collection and current B19 geometry |
| B21 | deterministic scene/change-set contracts, coordinates, client capability gate, session coordinator, persisted coordinate statement, and serialisable handshake/scene/proposal envelope | `construction-3d-*.mjs` contracts and envelope tests |
| B22 | 2D source adapters and `clear`/`conflict`/`unknown` spatial-review contract | source-adapter and spatial-review tests; no engineering/cost verdict is manufactured |
| B23 | deterministic construction-stage manifest that presents existing facts only | stage-manifest tests; no clock/work-progress mutation |
| B24 | preflight composition, integration audit, benchmark helper, source provenance fail-closed behavior, and explicit 2D fallback | preflight, integration-audit, benchmark, boundary, exchange, session, and envelope tests |

## B19 and B20 current command boundaries

The scenario host now contains explicit click-only paths for:

1. B19 development lifecycle, rail-contribution lifecycle, intake decision, and
   explicit demand-source application/withdrawal;
2. B20 campaign-program draft/adopt/monitor/complete/delay/resume/cancel;
3. B20 source-to-milestone activation/withdrawal; and
4. B20 milestone reached declarations with player-observed references.

No target month automatically changes a program or milestone.  Activation is a
reference to an already accepted B19 source, not a B15 demand application.
With several B20 map programs, `ScenarioRuntime.campaignActivationReport()` and
`campaignFactReport()` accept `programGeometries` and check each activation
against its own program ID.  A missing program geometry becomes stale; another
program's geometry is never reused.

## B21–B24 safety properties established now

- A source with missing pack provenance remains `null` in a scene manifest. It
  is never silently attributed to the host pack.
- Unknown, inactive, stale, other-pack, coordinate-mismatched, malformed, and
  no-client inputs keep the path at `2d-only`.
- Handshake, scene, and proposal envelopes require an explicit session ID.  A
  mismatched session is rejected before the payload is assessed.
- A valid proposal is still only a proposal.  The envelope boundary never
  applies it, approves construction, or writes cash, ledger, demand,
  passengers, timetables, RNG, or clock state.
- Session/save data retain only selected identities and facts, never a Unity
  binary, renderer payload, GPU resource, or mutable client world.

## Verification run

On the audited master state, the complete suite reported **2,077 passing, 0
failing, 2 existing skipped** tests.  `npm run validate` accepted all three
packs and `git diff --check` was clean.  The B20 audit exercises a real
`ScenarioRuntime` for a 30-year campaign and B19 source activation; B21–B24
tests exercise deterministic manifests, client fallback, source provenance,
session mismatch, stale proposals, and no-mutation boundaries.

## Explicit post-foundation work

1. Create and version an actual Unity WebGL and/or desktop client project.
2. Implement a host loader that performs transport-origin checks, obtains the
   B21 handshake, and uses the B21-P2 envelope gate.
3. Render only scene-manifest geometry; provide real B22 review interaction and
   B23 stage presentation without calculating simulation state.
4. Run the B24 two-mode (2D-only versus connected client) browser/Unity smoke,
   save/load, Tokyo/synthetic-pack, and measured-performance gates.
5. Make a new product decision before expanding optional construction 3D into
   normal simulation or operations gameplay.
