# B17-E0 — Timetable dispatch provenance

An active B16/B13 timetable already drives the existing train simulation through
`line.timetableDispatches`.  This change keeps the source of each dispatched
train as operational facts:

- `train.timetableId` — the active RailwayTimetable that scheduled the trip.
- `train.managementServiceId` — the management service named by that timetable.

Both fields are written only for a valid scheduled dispatch. Legacy frequency
trains and older/manual schedule records without those fields keep the fields
absent; absence is not rewritten as an invented identifier.

The fields do not change dispatch timing, routing, passenger behavior, traffic
control, RNG, clock handling, or economics. They are persisted by the existing
operational snapshot automatically and let a later B17 report group observed
trains by their real timetable without guessing from a line name or route.
