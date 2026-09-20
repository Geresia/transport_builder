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

- **Sub-ward population, Minato + Chuo ward pilot** (`subward.json`) —
  118 town-level (町丁・字) areas within 港区/Minato and 99 within 中央区/Chuo,
  each with 2020 census population, households, area, and a boundary polygon
  (used for the ward-detail panel in `viewer.html`). Sourced from
  [NII Geoshapeリポジトリ's "国勢調査町丁・字等別境界データセット"](https://geoshape.ex.nii.ac.jp/ka/resource/13103.html)
  (港区 [13103] `r2ka13103.topojson`, 中央区 [13102] `r2ka13102.topojson`),
  itself NII's processing of e-Stat's official "令和2年国勢調査
  町丁・字等別境界データ". The topology's own metadata states:
  `cc:license: https://www.e-stat.go.jp/terms-of-use`,
  `cc:attributionText: 「令和2年国勢調査町丁・字等別境界データ」をもとにNIIが加工`,
  `cc:attributionURL: https://www.e-stat.go.jp/` — carried above as a
  `data.attribution` line, and the page itself is marked `CC BY 4.0`. Free for
  commercial use and modification with attribution; no share-alike beyond
  that. Per-area population figures were cross-checked by summing each ward's
  areas: Minato 260,486 and Chuo 169,179, an exact match to `demand.json`'s
  existing `ward-minato`/`ward-chuo` totals (also 2020 census). Converted from
  TopoJSON to this pack's polygon format with a one-off PowerShell script (no
  Node/Python on this machine at conversion time, same constraint as the
  original hand-conversion — see `README.md`); the totals agreeing exactly is
  the cross-check that the arc-stitching was done correctly.

- **Chōme-name readings** (`subward.json[].areas[].reading_kana`) — added so
  the ward-detail panel can show a Korean reading for users who can't read
  Japanese kanji. The base-name furigana (カタカナ) comes from
  [日本郵便's postal-code CSV](https://www.post.japanpost.jp/zipcode/download.html)
  (`utf_ken_all.csv`, filtered to 港区/13103 and 中央区/13102); the postal data
  groups multiple chōme under one entry (e.g. "芝（１〜３丁目）"), so the
  chōme-number suffix (一丁目, 二丁目, ...) is appended using Japanese's fixed,
  name-independent chōme-counter reading (いっちょうめ, にちょうめ, ...) rather
  than being looked up per name. Japan Post explicitly disclaims copyright on
  this data ("郵便番号データに限っては日本郵便株式会社は著作権を主張しません。
  自由に配布していただいて結構です") — free commercial use and redistribution,
  no attribution technically required, credited here anyway per this pack's
  own convention. `viewer.html` converts the katakana reading to Hangul
  client-side (`kanaToKo()`), an approximation of 국립국어원's Japanese
  transliteration rules — spot-checked against known standard forms (e.g.
  六本木 → ロッポンギ → 롯폰기) but not exhaustively verified for every rare
  sound combination.

- **© OpenStreetMap contributors, building-population.json.** 65,376 building
  footprints across the full extent of 港区/Minato and 中央区/Chuo (not just
  the 4 hub districts `obstacles.json` covers), fetched via the Overpass API,
  ODbL-1.0 same as the other OSM-derived data in this pack — see
  [`./LICENSE-DATA`](./LICENSE-DATA), same share-alike obligation applies.
  **The per-building `estimated_population` values are a model, not measured
  data** — no public source publishes population at building granularity.
  Real inputs (building footprints + `subward.json`'s real chōme totals) are
  combined via a dasymetric weighting formula (footprint area × floor count ×
  a residential-type multiplier) described in `README.md`'s "Building-level
  population model" section; that section and every UI surface showing these
  numbers should keep saying so.

None of the above requires payment or registration; all permit commercial
use per their stated terms. The pack's overall `data.license` is set to the
strictest of these sources (`ODbL-1.0`) per
[`../LICENSING.md`](../LICENSING.md) Rule 2.
