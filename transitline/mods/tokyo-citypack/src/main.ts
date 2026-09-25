/**
 * Registers Greater Tokyo as a playable city using data exported from the transitline project
 * (../scripts/export-subway-builder-*.mjs -> ../../subway-builder-export/*.json).
 *
 * Status (proof of concept, not yet tested in-game - see mods/tokyo-citypack/README.md):
 *  - demand_data.chome.json: game-native, chome level (17,529 points, 74,445 pops of exactly 200 people) - the real
 *    2020 census municipality-to-municipality O/D spread over chomes by employed-residents x workers weights.
 *    Follows the internal rules measured on the real game's own Tokyo file (see subway-builder-export/README.md).
 *  - buildings_index.all.json: real, all 23 wards (1,790,011 buildings, ~588 MB).
 *  - roads.chiyoda.geojson: real OSM roads (Overpass), Chiyoda ward only so far - 1,986 ways, roadClass/
 *    structure/name all populated (export-subway-builder-roads.mjs). Every other ward still has nothing to
 *    route driving-demand paths on; run that script per ward to extend it.
 */

const MOD_ID = 'com.transitline.tokyo-citypack';
const CITY_CODE = 'TYOTL'; // "TYO" is already used by other Tokyo maps in the community registry; kept distinct
const TAG = `[${MOD_ID}]`;

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found.`);
} else {
  let initialized = false;

  api.hooks.onMapReady(() => {
    if (initialized) return;
    initialized = true;

    try {
      // bbox/origin match transitline/packs/tokyo/manifest.json (our own CityPack format, unrelated to this
      // file format); zoom picked to fit the whole Kanto-region bbox, same figure jelegend-tokyo's registry
      // listing uses for a comparable extent.
      api.registerCity({
        name: 'Greater Tokyo (Transitline)',
        code: CITY_CODE,
        description:
          'Real 2020/2021 census commuter flows for Tokyo + Saitama/Chiba/Kanagawa, at chome level (Tama-area cities: one point each). ' +
          'Building footprints are the official Tokyo land-use survey, all 23 special wards.',
        population: 36889715,
        initialViewState: { zoom: 9.7, latitude: 36.02814, longitude: 139.5232, bearing: 0 },
      });

      api.cities.setCityDataFiles(CITY_CODE, {
        buildingsIndex: 'data/buildings_index.all.json',
        demandData: 'data/demand_data.chome.json',
        roads: 'data/roads.chiyoda.geojson', // real, Chiyoda ward only - see file header
      });

      api.ui.showNotification(`${TAG} Tokyo CityPack registered (code ${CITY_CODE}).`, 'success');
      console.log(`${TAG} Registered city ${CITY_CODE}.`);
    } catch (err) {
      console.error(`${TAG} Failed to initialize:`, err);
      api.ui.showNotification(`${MOD_ID} failed to load. Check console for details.`, 'error');
    }
  });
}
