# B19-M5: new-town demand intake panel

`mountNewTownDemandIntakePanel({ container, runtime, getGeometryExport, onChange })`
is the host panel for the B19-E4 decision record and B19-E5 explicit source
record. It lists candidates from each existing lifecycle record, lets the
player select the exact stated fact IDs to accept, and sends commands only
from button clicks.

The panel calls only these read methods while mounting or refreshing:

- `newTownDevelopmentReport()`
- `assessNewTownDemandIntake()` / `newTownDemandIntakeReport()`
- `assessNewTownExplicitDemandSources()` / `newTownExplicitDemandSourceReport()`

Its click commands are `accept`, `hold`, `reject`, `revoke`, `apply explicit
source`, and `withdraw explicit source`. Before acceptance or source
application it reads the current geometry and asks the runtime again, so a
stale map fact is not silently used.

An applied B19-E5 source is still only a copy of the chosen player-stated
fact. The panel neither creates a B15 demand node nor changes `accessLinks`,
`stationDemandAllocationLinks`, passenger routing, fares, costs, or a policy.

`serialize()`/`loadDoc()` preserve only the selected candidate and unsent text
and checkbox choices. They reject documents from another pack. `main.mjs`
stores this string as `newTownDemandIntakePanelDoc` in the integrated save;
the actual B19-E4/E5 records remain in `runtime.save()`.
