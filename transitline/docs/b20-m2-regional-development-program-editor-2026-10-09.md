# B20-M2 regional development program editor

`mountRegionalDevelopmentProgramEditor` is a map-side DOM editor for the B20-M1 document. It has no runtime or management import. It records program and milestone reference IDs, target/duration labels, and player policy/priority statements. Blank reference input is `null` (not stated); the literal `[]` is an explicit empty declaration.

```js
const editor = mountRegionalDevelopmentProgramEditor({
  container,
  pack,
  getNewTownDevelopmentExport: () => newTownBridge.output().export,
  getMapExport: () => mapExport,
  getStationSites: () => stationSites,
  getServicePlans: () => servicePlanEditor.output().export.plans,
  onChange: ({ document, export }) => { /* host owns integrated save */ },
});
```

`output()` returns the B20-M1 document and regenerated map export. `serialize()` and `loadDoc(text)` let the host persist it; another pack's document is refused without overwriting current work. The host owns local storage and the integrated game save.

Links are reference statements. A current/missing/inactive/other-pack link fact in the export is not a connection, construction, service, demand, cost, or approval decision. This compact panel is the input surface; a future map overlay can use the same document/export without changing its IDs.
