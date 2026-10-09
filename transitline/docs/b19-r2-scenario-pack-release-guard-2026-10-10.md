# B19-R2 scenario-pack release guard

`ScenarioRuntime.releaseNewTownRailContribution()` now compares the supplied
B19 geometry's stated `sourcePackId` with the runtime scenario pack before it
delegates to the transactional management release.

If both IDs are stated and differ, the runtime throws before the contribution,
ledger, cash, event log, RNG, or ID counters can change. The lifecycle modules
continue to handle missing or malformed source-pack facts as `invalid` or
`stale`; this guard deliberately does not invent a pack for those cases.

The guard is deliberately at release, the sole B19-E3 transition that posts a
ledger entry. A player can still inspect, delay, or terminate an old or foreign
record without needing current map geometry, but a foreign map statement
cannot credit the active scenario.

`b19-integration-audit.test.mjs` now executes the previous F-3 regression as
an ordinary test: a foreign-pack lifecycle and contribution may be assembled,
but its release throws and the ledger cash remains byte-for-byte unchanged.
