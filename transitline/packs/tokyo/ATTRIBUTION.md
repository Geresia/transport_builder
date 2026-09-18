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
  Ward boundary polygons (`wards-reference.json`, used to compute
  `demand.json`'s point locations and to draw the choropleth) and the
  surrounding Saitama/Chiba/Kanagawa/Tama municipality boundaries
  (`kanto-region.json`) are both processed from MLIT's administrative-boundary
  open data. Free for
  commercial use and modification, no share-alike, but MLIT's specified
  credit is mandatory per source terms — carried here as the second
  `data.attribution` line.

- **Population figures, 23 wards** (`demand.json[].residents` for the
  `ward-*` points) are the 2020 census values listed in Wikipedia's
  ["Special wards of Tokyo"](https://en.wikipedia.org/wiki/Special_wards_of_Tokyo)
  article, CC BY-SA 4.0.

- **Population figures, tier-1 satellite cities** (`demand.json[].residents`
  for the `kanto-*` points — Saitama/Chiba/Kanagawa/Tokyo-Tama, 219 points)
  are mostly 2020 census values from Wikipedia's "List of cities in
  Saitama/Chiba/Kanagawa Prefecture by population" articles and the
  Japanese-language city articles for さいたま市/千葉市/横浜市/川崎市/
  相模原市/東京都 (ward- and Tama-city-level breakdowns there, CC BY-SA 4.0).
  12 small towns/villages below the Wikipedia lists' population cutoff are
  sourced from official government publications instead: 千葉県's "令和2年
  国勢調査 結果速報" PDF (直接記載: 芝山町; 前回比から逆算: 鋸南町・長南町・
  大多喜町・長柄町) and search-indexed citations of 総務省統計局's official
  2020 census results (御宿町・真鶴町・山北町・中井町・皆野町・東秩父村・
  長瀞町・横瀬町・清川村・神崎町). See `README.md` for `popDate` per point
  and the derivation method for the four back-calculated figures.

  An earlier pass had instead pulled the 30 Tama points and 10 of these small
  towns from a "Local Opendata" aggregator (figures-ranking.local-opendata.jp)
  whose reuse terms were never found. Those figures have since been replaced
  (Tama) or independently re-confirmed (the 10 towns) against the sources
  above and that site is no longer relied on.

None of the above requires payment or registration; all permit commercial
use per their stated terms. The pack's overall `data.license` is set to the
strictest of these sources (`ODbL-1.0`) per
[`../LICENSING.md`](../LICENSING.md) Rule 2.
