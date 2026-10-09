# B20-C1 campaign-program lifecycle panel

`mountCampaignProgramManagementPanel({ container, runtime, getProgramGeometry, onChange })`
is the scenario-screen command surface for B20-E1.  It closes the remaining
host wiring gap between the player-authored regional-program document and the
transactional campaign-program lifecycle.

## Commands

The panel calls a runtime command only from an explicit button click:

| Map/lifecycle state | Command |
| --- | --- |
| current map program with no lifecycle record | `draftCampaignProgram({ geometry })` |
| draft | `adoptCampaignProgram(id, { geometry })` |
| adopted | `monitorCampaignProgram(id, { geometry })` |
| monitoring | `completeCampaignProgram(id, { geometry })` |
| adopted or monitoring | `delayCampaignProgram(id, reason)` |
| delayed | `resumeCampaignProgram(id, { geometry })` |
| draft, adopted, monitoring, or delayed | `cancelCampaignProgram(id, reason)` |

Before every forward action the panel reads `getProgramGeometry()` again and
calls `assessCampaignProgram`.  A program that changed after the panel was
drawn therefore reaches the engine as stale and is not silently bound to its
new revision.  Delay and cancellation intentionally remain available without
current geometry, matching the lifecycle contract.

The panel does not calculate costs, demand, ridership, fare, capacity, ROI,
success, dates, or milestone completion.  B20 target dates stay display facts
in the timeline.  Recording a milestone remains a separate explicit action in
the timeline panel, and B20-E2 activation remains its own future command
surface; this panel does not infer either action from a lifecycle status.

## Main host wiring

`main.mjs` mounts the panel with the regional-program editor's current export.
Its `onChange` refreshes the map and scenario panels.  Lifecycle records are
already part of `runtime.save()`, so this panel has no independent save
document or browser-storage key.

## Verification

`campaign-program-management-panel.test.mjs` proves mount/refresh are
read-only, every lifecycle transition is click-only, delay reasons stay
player-stated, stale geometry is re-read at click time, cancellation works
without current geometry, output is detached, and the complete draft-to-
completed flow works against a real `ScenarioRuntime` without moving its clock,
operational simulation, or RNG.
