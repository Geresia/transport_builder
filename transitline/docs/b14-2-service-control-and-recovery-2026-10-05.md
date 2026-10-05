# B14-2 Service control and disruption recovery

## Implemented scope

The operating engine can issue a short-turn or partial-suspension order against an ongoing railway disruption. The original B14-2 API retains one contiguous part of the original line. B14-3 extends the same order schema with `retainedServices[]`, so a middle suspension can operate both disconnected sides at once. See `b14-3-m7-control-integration-2026-10-05.md`. Trains already in service retain their original stopping pattern and are listed in `pendingTrainIds`; this avoids teleporting or reversing a train between stations.

The order contract is `transitline.railway-control-order/1`. It records the disruption, operational line, selected map candidate, retained and omitted stations, turnback resource, issue/end times and lifecycle. Only one active order may control a line. Resolving its disruption ends the order and restores the full route automatically.

Waiting passengers whose remaining route uses the controlled line are invalidated and routed again against the shortened network. Onboard passengers remain with their already dispatched train.

## Recovery choices

An active disruption offers four deterministic responses:

| Response | Remaining duration | Direct cost | Reputation |
| --- | ---: | ---: | ---: |
| Emergency recovery | 45% | 200% of event base | +1 |
| Standard recovery | 100% | 100% | 0 |
| Safety investigation | 150% | 75% | +3 |
| Wait for natural/external recovery | 120% | 0 | -2 |

Base direct costs depend on the physical event kind and are expressed in 2026 JPY balancing values. Selecting a response changes an event from `active` to `responding`; its closure or speed restriction remains fully effective until resolution.

`ScenarioRuntime.respondRailwayDisruption()` posts the direct cost and reputation change in the same logical operation as the operational event update. If payment fails, both the management game and operational state return to their prior snapshots.

## Save, determinism and reporting

Events, selected responses and control orders live in the operational snapshot and survive integrated save/load. IDs are monotonic and are not reused. Reports return detached copies. Read-only reporting does not add migration fields to older saves.

## Deferred to later B14 steps

- Replacement-bus operation and its road/fleet requirements.
- Detours over another company's track and access-contract settlement.
- Immediate reversal or evacuation of a train already inside the affected segment.
- Compensation allocation and responsibility settlement between through-service parties.
- Full map UI mounting for M7 candidates. B14-3 already validates and executes M7 `partialSuspension` and `turnback` selections through `ScenarioRuntime.issueRailwayControlSelection()`.
