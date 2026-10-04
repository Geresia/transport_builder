# B14-1 Railway disruptions and M5 operating integration

## Result

The operating simulation now models railway disruptions as a separate physical overlay. A disruption can close a physical section or confirmed signalling block, impose a speed restriction, or stop one identified train. Multiple active events combine conservatively: closure wins and the lowest speed limit applies.

The event contract is `transitline.railway-disruption/1`. Each event records its kind, lifecycle, physical target, start and expected end, operational effect, infrastructure owner, operator, responsibility and source. Unknown ownership or responsibility is not inferred.

Supported event kinds are vehicle failure, signal failure, track obstruction, severe weather and construction incident. Hourly automatic generation currently creates infrastructure events only. Vehicle failures remain an explicit API action until a real train-to-vehicle assignment exists, avoiding duplicate failures beside the existing fleet reliability model.

## Physical operating effects

- A closure prevents entry and stops a train already inside the affected section or block.
- A speed restriction changes actual train movement and junction approach timing.
- Events on a shared physical track affect every service using that track, regardless of which line originally reported the event.
- A vehicle failure affects only its identified train.
- `disruptionDelaySeconds` is retained as a causal subset of ordinary signal and arrival delay, so financial settlement does not charge the same delay twice.
- Disruption exposure is recorded on the calendar day when it happens, while timetable completion remains attributed to the scheduled departure day.

## M5 RailCapacityGeometry integration

`rail-capacity-integration.mjs` maps `transitline.rail-capacity-geometry/1` into the operational network by matching the source station pair to exactly one physical track segment. Stale, missing, ambiguous or unresolved mappings fail before any operational state is changed.

- `sections[].sectionId` is retained as `railCapacitySectionId` on the physical track.
- Confirmed `blocks[]` become deterministic signalling resources on double track.
- `blocks: null` remains unknown and falls back to the conservative whole-section resource.
- Single track always keeps a section-wide shared resource even when block boundaries are known. This prevents opposing trains from entering different blocks and meeting head-on without a route-locking system.
- `junctionResourceIds` and closure targets retain their contract IDs.
- A disruption may target a confirmed `blockId`; a section event with `blockId: null` affects the full section.
- Block boundaries and the rail-capacity revision are included in the operational infrastructure revision. Changing them makes an already assessed timetable stale.

Applications and block facts are part of the operational snapshot, so save and restore preserve the exact mapping. Reports return detached copies and do not migrate old saves merely by being read.

## Determinism

Hourly hazards use a dedicated serializable RNG, separate from passenger demand. Evaluation occurs on fixed simulation-hour boundaries, and physical segments are sorted by stable ID before consuming random values. Input array order therefore cannot change the next event sequence.

## UI

The operations economy panel shows the active count and the eight most recent events. It is read-only. Spatial selection, response choices and map editing belong to the follow-up B14-M6 map contract.

## Known limits

- Automatic hazard rates are temporary balancing values, not empirical Japanese railway rates.
- A block boundary is treated as a signal control point, but detailed overlap, flank protection and moving-block signalling are not yet modeled.
- Single-track passing loops need explicit physical sections and interlocking resources; block boundaries alone do not create a safe passing place.
- Cost allocation, compensation and recovery decisions are intentionally outside this physical-event layer.
