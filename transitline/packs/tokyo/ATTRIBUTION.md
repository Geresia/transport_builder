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

- **Sub-ward population, all 23 wards** (`subward.json`, started as a
  Minato+Chuo pilot then extended pack-wide the same day) — 3,150 town-level
  (町丁・字) areas, each with 2020 census population, households, area, and a boundary polygon
  (used for the ward-detail panel in `viewer.html`). Sourced from
  [NII Geoshapeリポジトリ's "国勢調査町丁・字等別境界データセット"](https://geoshape.ex.nii.ac.jp/ka/resource/13103.html)
  (`r2ka<prefix>.topojson` per ward, e.g. 港区 [13103], 中央区 [13102]),
  itself NII's processing of e-Stat's official "令和2年国勢調査
  町丁・字等別境界データ". The topology's own metadata states:
  `cc:license: https://www.e-stat.go.jp/terms-of-use`,
  `cc:attributionText: 「令和2年国勢調査町丁・字等別境界データ」をもとにNIIが加工`,
  `cc:attributionURL: https://www.e-stat.go.jp/` — carried above as a
  `data.attribution` line, and the page itself is marked `CC BY 4.0`. Free for
  commercial use and modification with attribution; no share-alike beyond
  that. Per-area population figures were cross-checked by summing each ward's
  areas against `demand.json`'s existing per-ward totals (also 2020 census):
  all 23 wards matched exactly, zero mismatches. Converted from
  TopoJSON to this pack's polygon format with a one-off PowerShell script (no
  Node/Python on this machine at conversion time, same constraint as the
  original hand-conversion — see `README.md`); the totals agreeing exactly is
  the cross-check that the arc-stitching was done correctly.

- **Chōme-name readings** (`subward.json[].areas[].reading_kana`) — added so
  the ward-detail panel can show a Korean reading for users who can't read
  Japanese kanji. The base-name furigana (カタカナ) comes from
  [日本郵便's postal-code CSV](https://www.post.japanpost.jp/zipcode/download.html)
  (`utf_ken_all.csv`, filtered per ward by its e-Stat prefix); the postal data
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

- **© OpenStreetMap contributors, `tokyo-buildings.pmtiles`.** 1,119,872
  building footprints across all 23 special wards (OSM `way`s tagged
  `building=*`, fetched through public Overpass API mirrors and compiled with
  Planetiler into one vector-tile file), ODbL-1.0 — same Derivative Database
  obligations as `obstacles.json`: attribution, share-alike, see
  [`./LICENSE-DATA`](./LICENSE-DATA). Rendering only. Coverage in OSM is uneven
  (north-east wards sparse) — see `README.md`'s "Buildings, all 23 wards".

- **© OpenStreetMap contributors, `{saitama,chiba,kanagawa}-buildings.pmtiles`.**
  5,123,728 building footprints for Saitama, Chiba and Kanagawa prefectures
  (OSM `building=*` ways and multipolygon relations, from Geofabrik's
  `kanto-latest.osm.pbf` of 2026-09-20, compiled with Planetiler), ODbL-1.0 —
  same Derivative Database obligations as `tokyo-buildings.pmtiles`:
  attribution, share-alike, see [`./LICENSE-DATA`](./LICENSE-DATA). Rendering
  only. See `README.md`'s "Buildings, Saitama / Chiba / Kanagawa".

- **© OpenStreetMap contributors, © Natural Earth, `barriers.json`.** Water
  polygons derived from `basemap.pmtiles`'s water layer and bridge lines derived
  from `{tokyo,saitama,chiba,kanagawa}-roads.pmtiles`, both OSM-derived. ODbL-1.0 —
  same Derivative Database obligations as the other OSM-derived files, see
  [`./LICENSE-DATA`](./LICENSE-DATA). See `README.md`'s "Walking barriers".

- **© OpenStreetMap contributors, `existing-network.json`.** 195 real rail/subway/tram lines (OSM
  `route=train|subway|light_rail|tram` relations and their ordered stop members), fetched via the
  Overpass API and collapsed onto `demand.json`'s 242 points. ODbL-1.0 — same Derivative Database
  obligations as the other OSM-derived files, see [`./LICENSE-DATA`](./LICENSE-DATA). Line colours,
  where present, are also from OSM's own `colour` tag. See `README.md`'s "Existing rail network".

- **© OpenStreetMap contributors, `building-labels.pmtiles`.** 15,081 named
  building footprints (OSM `building=*` with a `name` tag; name, `name:ko`,
  `name:en`), from Geofabrik's `kanto-latest.osm.pbf` of 2026-09-20, compiled
  with Planetiler. ODbL-1.0 — same Derivative Database obligations as the other
  OSM-derived files, see [`./LICENSE-DATA`](./LICENSE-DATA). Rendering only.
  See `README.md`'s "Building names".

- **© OpenStreetMap contributors, `{tokyo,saitama,chiba,kanagawa}-roads.pmtiles`.**
  OSM `highway=*` lines (car roads and pedestrian ways) for Tokyo, Saitama,
  Chiba and Kanagawa, from Geofabrik's `kanto-latest.osm.pbf` of 2026-09-20,
  compiled with Planetiler. ODbL-1.0 — same Derivative Database obligations as
  the other OSM-derived files, see [`./LICENSE-DATA`](./LICENSE-DATA).
  Rendering only. See `README.md`'s "Roads and pedestrian ways".

- **© OpenStreetMap contributors, © Natural Earth, `basemap.pmtiles`.**
  Protomaps daily planet build of 2026-09-19 (planetiler 0.10.2), extracted to
  this pack's bbox at zoom 0-12 with go-pmtiles. Layers used for rendering:
  water, earth, landuse, roads (incl. rail). ODbL-1.0 — same Derivative
  Database obligations as the other OSM-derived files, see
  [`./LICENSE-DATA`](./LICENSE-DATA). Rendering only.

- **東京都都市整備局「土地利用現況調査」令和3年度 (区部), CC BY 4.0.**
  Building use class and floor count, used only to derive the residents-per-floor-area
  coefficients (`pop-coefficients.json`) and to tag each OSM building with `lu` in
  `tokyo-buildings.pmtiles`. The survey geometry itself is not redistributed.

None of the above requires payment or registration; all permit commercial
use per their stated terms. The pack's overall `data.license` is set to the
strictest of these sources (`ODbL-1.0`) per
[`../LICENSING.md`](../LICENSING.md) Rule 2.

- 通勤OD (`od.json`): 出典 総務省統計局「令和2年国勢調査 従業地・通学地による人口・就業状態等集計」第3表 (e-Stat)。加工: 市区町村別に領域内へ集約。政府標準利用規約2.0。

- 通学OD (`od-school.json`, 2026-09-22 追加): `od.json` と同じ第3表・同じファイルの別列（15歳未満を含む全年齢通学者）。出典・利用規約は同上。

- 時間帯別発生係数・平日 (`demand.json` の `calendar.factors.weekday`, 2026-09-23 追加): 出典 総務省統計局「令和3年社会生活基本調査」第10表「時間帯，行動の種類別主行動の行動者率－平日，15歳以上」(e-Stat)。加工: 通勤(131)・通学の15分刻み全国行動者率を1時間単位に集約し、本パック独自の `od.json`/`od-school.json` 合計（就業者:通学者 ≈ 82:18）で加重合成、平均1.0に正規化。政府標準利用規約2.0。

- 時間帯別発生係数・土休日 (`demand.json` の `calendar.factors.saturday`/`.holiday`, 2026-09-23 追加): 出典 JR東日本 公式デジタル時刻表 (`timetables.jreast.co.jp`) — 山手線（新宿駅）・中央線快速（高尾→東京）の平日・土休日時刻表、実際の列車本数を時間帯別に集計。加工: 各路線の土休日/平日の時間帯別シェア比を算出し2路線平均、上記の平日実測係数に適用して平均1.0に再正規化。運行本数（供給側）を需要の代理指標として使用したモデルであり、乗車人員の直接測定ではない。JR東日本の著作物のうち本数の集計値のみを利用（時刻表原文は転記していない）。

- 경사 구간과 봉우리 (`slope-zones.pmtiles`, `peaks.json`): 出典 国土地理院 標高タイル DEM10B (https://cyberjapandata.gsi.go.jp/xyz/dem_png/, 国土地理院コンテンツ利用規約、出典明記で利用可)。加工: 標高から傾斜を算出し(Horn法、約31mメッシュ平均)、傾斜10°・20°・30°以上の領域を入れ子のポリゴンにした。봉우리 위치·이름·표고(`ele`)는 OpenStreetMap contributors (ODbL)、`dem_ele`(地点の標高)と`slope_mean_200m`は上記DEMから算出。閾値は歩行可否の基準ではなく判断値。
- **Terrain shading (`viewer.html`, fetched live, not shipped):** AWS Terrain Tiles (Terrarium, open data; derived from SRTM, GSI and other sources), `https://registry.opendata.aws/terrain-tiles/`. Used only for the optional hillshade layer; the pack works without it.

- 学校・病院 (`special-demand.json`): 出典 国土交通省 国土数値情報ダウンロードサイト「学校データ (P29-23, CC BY 4.0)」「医療機関データ (P04-20)」(https://nlftp.mlit.go.jp/ksj/)。加工: 大学・短大・高専と100床以上の病院を抽出し、収容人数(`capacity`)を推定値として付与。「国土数値情報（学校データ・医療機関データ）」（国土交通省）をもとに作成。文化施設 (P27) は2013年版が非商用のため使用していない。

- 観光客数 (`tourism.json`): 出典：モバイル空間統計。東京都産業労働局「東京都観光データカタログ」(https://data.tourism.metro.tokyo.lg.jp/)「モバイルデータを活用した訪都旅行者動態調査」(NTTドコモ モバイル空間統計, R7=2025) および「国・地域別外国人旅行者行動特性調査」(R7=2025) のローデータを加工して作成（モバイル空間統計を加工して作成）。この加工物は東京都が作成したものではない。モバイルデータの利用規約は出典表記と加工の明示を求める。国・地域別調査データ・サイトポリシーには個別のライセンス表示が見当たらず、著作権は東京都産業労働局観光部に帰属する旨のみ — 再配布・商用利用の可否は未確認。

- 宿泊施設の稼働率 (`lodging-demand.json`): 出典 観光庁「宿泊旅行統計調査」令和7年（2025年）第2・7・8・9表 (https://www.mlit.go.jp/kankocho/tokei_hakusyo/shukuhakutokei.html, e-Stat)。政府標準利用規約2.0。加工: 東京・神奈川・千葉・埼玉の月別客室稼働率・利用客室数・延べ宿泊者数を施設タイプ別に集計。地域差の重みは「モバイル空間統計」（出典：モバイル空間統計、モバイル空間統計を加工して作成）と東京都観光データカタログの観光地点パラメータ調査・国・地域別外国人旅行者行動特性調査の宿泊施設の回答割合、施設の客室数は `hotels.json` (OSM, ODbL-1.0)。曜日の重みは根拠のない仮定値。「宿泊旅行統計調査」（観光庁）をもとに作成。

- 宿泊施設 (`hotels.json`): © OpenStreetMap contributors, ODbL-1.0 (tourism=hotel 等 / building=hotel を Overpass API 経由で取得, 2026-09-25)。客室数は OSM の `rooms` タグ、なければ建物面積×階数からの推定値（`sizeBasis` 参照）で、実測ではない。派生データベースとして同じ ODbL-1.0 で提供する。

- 新幹線・特急の都道府県間流動 (`tourism.json` の `railInbound`): 出典 国土交通省「幹線鉄道旅客流動実態調査」平成27年 都道府県間相互発着表 (e-Stat, 政府統計の総合窓口)。政府標準利用規約2.0。加工: 埼玉・千葉・東京・神奈川以外から同4都県への片道旅客数(平休年拡大値)を集計。「幹線鉄道旅客流動実態調査」（国土交通省）をもとに作成。

- 市区町村別人口 (`demand.json`, 2026-09-21 更新): 総務省統計局「令和2年国勢調査 従業地・通学地による人口・就業状態等集計」第1-1表 (e-Stat)。政府標準利用規約2.0。

## Bathymetry (`bathymetry.json`)
GEBCO Bathymetric Compilation Group 2026 (2026). The GEBCO_2026 Grid - a continuous terrain model for oceans and land
at 15 arc-second intervals. doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa — read via the BODC/CEDA archive.
Terms (https://www.gebco.net/data-products/gridded-bathymetry-data, checked 2026-09-21): the GEBCO Grid is placed in the
public domain and may be used free of charge; GEBCO asks that the source is acknowledged in publications/presentations.

- **© OpenStreetMap contributors, `areas.pmtiles`.** Parks, schools, hospitals, water and land-use polygons from Geofabrik `kanto-latest.osm.pbf`. ODbL-1.0, same Derivative Database obligations as the other OSM-derived files, see [`./LICENSE-DATA`](./LICENSE-DATA).

- **© OpenStreetMap contributors, `bridges-3d.pmtiles`.** Elevated-road (`bridge=*`) footprints derived from the `<area>-roads.pmtiles` files, buffered and given an estimated deck height for the 3D view. ODbL-1.0, same Derivative Database obligations as the other OSM-derived files, see [`./LICENSE-DATA`](./LICENSE-DATA).

- さいたま市の用途別従業者係数 (`job-coefficients-saitama.json`, `jobs-buildings-saitama.json`): 出典 国土交通省 Project PLATEAU 3D都市モデル さいたま市 (2020年度) (https://www.geospatial.jp/ckan/dataset/plateau-11100-saitama-shi-2020)、PDL1.0。加工: 建物属性 (都市計画基礎調査 建物利用現況) を町丁別・用途別に集計し、経済センサスの従業者数と回帰して係数を推定。建物ごとの従業者数は町丁の従業者数を用途別係数で配分した推定値 (`jobs-buildings-saitama.json`)。

- 川崎市の用途別従業者係数 (`job-coefficients-kawasaki.json`, `jobs-buildings-kawasaki.json`): 出典 国土交通省 Project PLATEAU 3D都市モデル 川崎市 (2020年度) (https://www.geospatial.jp/ckan/dataset/plateau-14130-kawasaki-shi-2020)、PDL1.0。加工: さいたま市と同じ方法。建物属性に地下階数 (`basement_levels`) を含む(さいたま市データにはない項目)。

- 相模原市の用途別従業者係数 (`job-coefficients-sagamihara.json`, `jobs-buildings-sagamihara.json`): 出典 国土交通省 Project PLATEAU 3D都市モデル 相模原市 (2020年度) (https://www.geospatial.jp/ckan/dataset/plateau-14150-sagamihara-shi-2020)、PDL1.0。加工: さいたま市と同じ方法。

- 横須賀市の用途別従業者係数 (`job-coefficients-yokosuka.json`, `jobs-buildings-yokosuka.json`): 出典 国土交通省 Project PLATEAU 3D都市モデル 横須賀市 (2020年度) (https://www.geospatial.jp/ckan/dataset/plateau-14201-yokosuka-shi-2020)、PDL1.0。加工: さいたま市と同じ方法。

- 就業者数 (`employed.json`, 建物別 `emp`): 総務省統計局「令和2年国勢調査 小地域集計」第16-2表 (e-Stat)。加工: 秘匿された町丁は合算値を居住人口で按分。政府標準利用規約2.0。

- 建物ポリゴン・用途・階数 (`tokyo-survey-buildings.pmtiles`): 東京都都市整備局「令和3年度 区部土地利用現況調査」(CC BY 4.0)。加工: 座標変換 (平面直角座標系IX系→WGS84)、建物単位の推計人口・従業者数・就業者数を付与。
