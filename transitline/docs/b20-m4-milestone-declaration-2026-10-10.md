# B20-M4 milestone declaration handoff

The campaign timeline now supports a deliberate milestone-reached command in
the game host. It remains a declaration; neither target month nor any linked
map fact automatically completes a milestone.

## Host wiring

`main.mjs` mounts `mountCampaignTimelinePanel` with:

- `getGeometryForProgram(programId)`, which obtains the **current** B20-M1
  program geometry by its stable `programId`;
- `onReachMilestone(intent)`, which calls
  `runtime.reachCampaignMilestone(intent.campaignProgramId, intent.milestoneId,
  intent.observedRefs, { geometry: intent.geometry })`.

The engine still performs the authoritative state and revision checks. A
missing or stale current geometry is rejected by the engine, with no automatic
repair.

## Player statement boundary

When the host supplies the current-geometry getter, the selected planned
milestone shows an evidence editor. A player must do exactly one of these
before recording the milestone:

1. Add one or more observed references. Every row needs a reference kind and
   ID; state is optional.
2. Explicitly choose **Declare no observed references**. Only this explicit
   action permits an empty `observedRefs: []` declaration.

An untouched empty editor is refused locally. This distinguishes “I have not
provided evidence yet” from a player's explicit no-reference declaration.
The statement is not a feasibility verdict or proof: it records only the
player-provided reference facts and the simulation minute that the management
engine assigns.

## Compatibility

The panel's earlier generic callback remains supported. If a host supplies an
`onReachMilestone` callback without `getGeometryForProgram`, it still receives
the prior minimal intent (`campaignProgramId`, `programId`, `milestoneId`).
The full game host uses the stricter geometry/evidence path.

## Verification

The panel tests cover: a due target remaining planned, an untouched evidence
editor being refused, a reference declaration forwarded with the current
geometry, and an explicitly declared empty reference list. The full test suite
and pack validation are run when this handoff is committed.
