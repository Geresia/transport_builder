# B20-C1 campaign-activation panel

`mountCampaignActivationManagementPanel({ container, runtime,
getProgramGeometry, getDevelopmentGeometry, onChange })` is the explicit UI
boundary for B20-E2.

It lists saved B19 explicit demand sources and B20 lifecycle records.  A player
chooses one source for one declared campaign milestone and clicks **Record
selected source**.  The panel then passes the source's exact `intakeId` and
`demandSourceId`, the current B20 program geometry, and the current B19
development export to `runtime.recordCampaignActivation()`.

The runtime remains the authority on eligibility, source standing, map
revision, source-pack identity, and duplicate records.  The panel re-reads both
geometry documents on every command click.  It does not use a stale rendered
snapshot, does not infer a source, and shows the runtime's refusal verbatim.

Existing activation records can be withdrawn only with the player's stated
reason via `runtime.withdrawCampaignActivation()`.

## Boundaries

- Activation records are references only.  They do not alter B15 `demandNodes`,
  `accessLinks`, or allocation links.
- The panel performs no conversion or total of residents/jobs facts; no demand,
  passenger, fare, cost, capacity, ROI, score, clock, or RNG calculation is
  present.
- Map target dates and milestone declarations remain separate B20 timeline
  actions.  Recording an activation never marks a milestone reached.
- There is no independent browser-storage document.  Activation state is part
  of `runtime.save()`.

`main.mjs` mounts this panel between the B20 lifecycle panel and the read-only
timeline, and refreshes it after map or scenario changes.

For the timeline, `main.mjs` also now supplies the full regional-program export
as `programGeometries` to `runtime.campaignFactReport()`.  The runtime resolves
each activation by its own `programId`; a missing program document leaves only
that activation stale instead of accidentally checking it against another
program's geometry.  The older single-`geometry` overload remains available for
callers that inspect one program.

## Verification

`campaign-activation-management-panel.test.mjs` covers command-free mount and
refresh, exact source identity transfer, command-time geometry refresh, stale
runtime rejection, explicit withdrawal, detached output, and teardown.  The
existing B20 campaign audit separately exercises the same activation path with
a real `ScenarioRuntime` and B19 E1–E5 source chain.
