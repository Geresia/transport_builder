# Attribution — `tokyo` CityPack

Required by `manifest.json`'s `data.license` (`ODbL-1.0`) and by the
non-ODbL sources this pack also carries (Rule 3, [`../LICENSING.md`](../LICENSING.md)).

- **© OpenStreetMap contributors.** `obstacles.json` (19,495 building
  footprints across Marunouchi/Tokyo Station/Ginza, Shinjuku, Shibuya and
  Ikebukuro) is derived from OpenStreetMap data, made available under the
  Open Database License (ODbL) 1.0 — see [`./LICENSE-DATA`](./LICENSE-DATA).
  As a Derivative Database, any public use of this pack (or of extracts
  from it) must carry this same attribution and remain under ODbL
  (share-alike, Rule 4.4 of the license).

- **国土交通省 国土数値情報（行政区域）, via
  [smartnews-smri/japan-topography](https://github.com/smartnews-smri/japan-topography).**
  `demand.json`'s ward geometry (used only to compute point locations —
  the polygons themselves are not shipped in this pack) is processed from
  MLIT's administrative-boundary open data. Free for commercial use and
  modification, no share-alike, but MLIT's specified credit is mandatory
  per source terms — carried here as the second `data.attribution` line.

- **Population figures** (`demand.json[].residents`) are the 2020 census
  values listed in Wikipedia's
  ["Special wards of Tokyo"](https://en.wikipedia.org/wiki/Special_wards_of_Tokyo)
  article, CC BY-SA 4.0.

None of the above requires payment or registration; all permit commercial
use. The pack's overall `data.license` is set to the strictest of the
three (`ODbL-1.0`) per [`../LICENSING.md`](../LICENSING.md) Rule 2.
