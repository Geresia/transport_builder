# B20-M3 Campaign timeline panel

`campaign-timeline-panel.mjs` is a host-mounted display for the B20-E3 campaign fact report. It receives only `getFactReport()` and `getClockMinute()`; it has no `ScenarioRuntime`, storage, polling timer, or game-clock write access.

```js
const timeline = mountCampaignTimelinePanel({
  container,
  getFactReport: () => runtime.campaignFactReport(context),
  getClockMinute: () => runtime.managementClockMinute(),
  onReachMilestone: ({ campaignProgramId, milestoneId }) => {
    // The host supplies the current M1 geometry and player-observed references.
    runtime.reachCampaignMilestone(campaignProgramId, milestoneId, observedRefs, { geometry });
  },
});
```

The optional callback is the only command boundary. It is called only after the player selects a `planned` milestone and clicks **Record milestone reached**. It receives IDs only; it never fabricates geometry, observed references, a date, or a success decision. If no callback is supplied, the panel is entirely read-only.

`refresh()` must be called by the host after a program/milestone change or when it chooses to refresh the campaign clock label. The panel does not poll. `select(programId, milestoneId)`, `clearSelection()`, `output()`, and `destroy()` are available for host integration. `output()` is a detached copy.

The target display (`upcoming`, `due`, or `past due`) is a comparison with the existing B20 time label only. It does not change the recorded milestone state. Missing campaign facts render as unknown rather than as an empty campaign.

This is not the B20-C1 integration: the host still owns `main.mjs`, integrated saves, layout/style, current map geometry, observed-reference entry, and runtime error handling.
