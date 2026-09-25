# Subway Builder export (proof of concept, 2026-09-22 → updated 2026-09-24)

Converts our real Tokyo CityPack data into the file shapes the Subway Builder game reads through its Modding API
(`api.cities.setCityDataFiles()`). Target shapes come from
[`compatibility-test-mod`](https://github.com/subway-builder-modded/compatibility-test-mod)'s
`src/types/{game-state,index}.d.ts` (MIT-licensed API type definitions - reused as a target format we validate
against, not copied code). This directory is generated output; regenerate it with the scripts below rather than
editing by hand. **This folder was wiped once by an `rm -rf` reproducibility test** - the generated
`.json`/`.geojson` files come back from the scripts, this README does not, so re-check it exists after any
"regenerate from scratch" test.

## What's here

| File | What it is | Status |
|---|---|---|
| `demand_data.chome.json` | **The file the mod loads.** Game-native, chome level: 19,614 points, 77,762 pops of exactly 200 people, 12.3 MB. | Real census O/D, spread over chomes by a **modeled** split (see below). Follows the four internal rules of the game's own Tokyo file. |
| `demand_data.json` | Exact-O/D reference: 242 municipality points, 39,047 pops with the real census flow counts as sizes. | Real, but does **not** follow the game's internal rules (variable pop sizes, census-valued points). Kept for analysis, not loaded. |
| `buildings_index.all.json` | All 23 special wards: 1,790,011 official-survey building footprints, 588 MB. | Real. `foundationDepth` is 0 (see gaps). |
| `buildings_index.chiyoda.json` | Chiyoda only, 11,338 buildings. | Small test fixture. |
| `roads.all.geojson` | ROADS_SUMMARY | Real OSM. |
| `roads.<ward>.geojson` | One per ward, with the OSM way id kept as the Feature `id` (used to de-duplicate boundary-crossing ways). | Intermediate. |
| `roads.geojson` | Empty placeholder from the first pass. | Superseded, not loaded. |

Regenerate everything:

```
node scripts/export-subway-builder-demand.mjs                    # exact-O/D reference, 242 points
ALLOW_SHRINK=1 node --max-old-space-size=4096 scripts/export-subway-builder-demand-chome.mjs   # the mod's file (ALLOW_SHRINK only if the point count drops on purpose)
node --max-old-space-size=6144 scripts/export-subway-builder-buildings.mjs <tokyo23-survey.ndjson> all
node scripts/export-subway-builder-roads.mjs all                 # resumable; needs network (Overpass), ~20+ min
node --max-old-space-size=4096 scripts/check-subway-builder-export.mjs   # validates all of the above
```

`tokyo23-survey.ndjson` is `tokyo-survey-buildings.mjs`'s intermediate output (regenerate it first if you no longer
have it). The buildings export streams that file twice and writes building by building: a 588 MB result cannot be
held as one JS string (V8's ~536 MB limit), which the checker's streaming path also works around.

## Verified against the real game (read-only comparison)

Subway Builder is installed on this machine, with its own built-in Tokyo (`TOK`) and Osaka (`OSA`) data under
`%APPDATA%\metro-maker4\cities\data\`. We read those files locally to check our output against real ground truth.
**Never copied into this repo**; only a few summary statistics (below) were kept.

**Structure**
- `homeDepartureTime`/`workDepartureTime` are not in the file at all (0 of 82,662 pops) - runtime-only fields of a
  different type. An early version of our exporter wrongly added them; removed.
- Roads use exactly three `roadClass` values (`highway`/`major`/`minor`) and three `structure` values
  (`bridge`/`normal`/`tunnel`); ~7.4% of segments carry a `name`.
- The built-in `buildings_index` is a proprietary binary (`SBBI`); mods use the documented JSON shape we target.

**Four internal rules of the game's demand file** (each holds for 100% of the real records)
1. Every pop is exactly **200** people (duplicate residence/job pairs are allowed).
2. Every point's `residents` and `jobs` are exactly the sums of pop sizes naming it as residence / job.
3. No pop has `residenceId === jobId`.
4. No point has both `residents` and `jobs` at 0.

Our first chome-level attempt broke all four (pop sizes 1 to 125,235; points carrying census values; same-chome
pops; unused points). The game may well rely on them, so `demand_data.chome.json` is now built to satisfy them and
`check-subway-builder-export.mjs` **enforces** them (mutation-tested).

**Scale and coverage**
- Real `TOK` is the whole Greater-Tokyo region: 4,973 points in Tokyo (13), 3,585 Kanagawa (14), 2,408 Chiba (12),
  1,921 Saitama (11), 8 Ibaraki - 16,532,400 commuters, all three totals (residents = jobs = pop sizes) equal.
  Our `employed.json` totals 16.35M for the same four prefectures - two unrelated methods within 1%.
- Ours now has 5,196 Tokyo points (23 wards + 2,034 in the 30 Tama-area municipalities) to their 4,973, plus
  Saitama 5,046 / Chiba 4,638 / Kanagawa 4,734 (theirs 1,921 / 2,408 / 3,585): we keep one point per census chome
  that has residents or workers, the real file evidently merges some. Until 2026-09-25 the Tama municipalities were
  one point each (3,132 Tokyo points); `subward-tama.json` / `jobs-tama.json` (`scripts/tama-*.mjs`) fixed that.
- Pop count: 77,762 (real: 82,662). Densest job point: Marunouchi 1-chome (`13101001001`) - 68,000 for us
  (the exporter's OD-derived share), 92,000 in the real file; the same chome tops both.
- Commute distance is shorter in ours (median 10 km vs 19 km, routed). That is a difference between real census
  commuting and the game's own model, not something to "fix" toward theirs.

**Driving distance/time** use `scripts/subway-builder-driving.mjs`: a detour factor (~1.35-1.5) and a
distance-dependent speed (20 km/h under 1 km rising to 55 km/h beyond 64 km), taken as medians over the real
file's 82,662 pops. Still an approximation of *our* geography (no routing engine); but on the scale the game's own
data uses, unlike the flat 25 km/h straight-line guess it replaces.

## What's modeled and what isn't

`demand_data.chome.json`
- **Real**: the municipality-to-municipality commuter flows (2020 census table 3, `od.json`), and the chome-level
  weights - employed residents (`employed.json`, census table 16-2) for where people live, workers by workplace
  (`jobs*.json`, Economic Census) for where they work.
- **Modeled, not measured**: the chome-to-chome split (the census O/D is only measured per municipality pair) and
  the rounding into 200-person pops. Each flow of N people = N/200 units, spread over chome pairs in proportion to
  (origin employed residents x destination workers) by *systematic sampling* along one global ordering. That keeps
  every chome pair's expected count equal to its exact share (no bias toward big chomes, unlike a top-K cut) and
  bounds the running error below one unit, so every municipality pair re-aggregates to `od.json` within 200
  people (measured worst case: 199) and the total within 83 people. Same technique as this project's per-building
  splits (`job-coefficients.json`).
- **Dropped, reported**: inside every municipality the same-chome share is removed and renormalised over the
  other chome pairs (a same-point pop would break rule 3). Nothing else is dropped since the Tama municipalities
  got chome data (previously 663,385 within-municipality Tama workers were). Outside the file: commutes leaving the
  region (`out`, 141,603) and workplace-unknown (`unknown`, 188,009), which have no destination point.
- 2,810 chomes with neither employed residents nor jobs appear in no pop and so are not points (rule 4).
- **Tama chome weights**: residents/boundaries from the 2020 census small-area layer (`subward-tama.json`; disjoint
  pieces of one chome merged), employed residents from census table 16-2 (same as the other prefectures), workers
  from the Economic Census by name-matching town names (`jobs-tama.json`, 99.90% of workers matched; unmatched are
  post-2020 new chome names in Machida - 金井ヶ丘, 藤の台 - and a few "その他" rows).

## Known gaps

- Tama has chome-level demand now, but no per-building data: buildings and roads still cover the 23 wards only.
- `foundationDepth` is 0 for every building. A real value needs basement counts, which exist only for a *different*
  building set (`obstacles.json`'s OSM footprints, `levels_underground`).
- Roads cover the 23 wards only (the area buildings cover); the demand region is four prefectures.
- Driving distance/time are calibrated approximations; `drivingPath` is omitted (optional, and never populated in
  the real file either).
- **Never enabled in the game.** Everything here is static validation plus a structural comparison with the game's
  own files, not "the game accepted this and I saw it load" - see `../mods/tokyo-citypack/README.md`.

## Not needed for this path

Community map ZIPs on the `Subway-Builder-Modded/registry` carry a `config.json` next to `demand_data.json`; that
belongs to an older community map-manager pipeline, not to the documented Modding API used here
(`registerCity` + `setCityDataFiles`).
