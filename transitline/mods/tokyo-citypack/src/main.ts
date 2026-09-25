/**
 * Registers Greater Tokyo as a playable city using data exported from the transitline project
 * (../scripts/export-subway-builder-*.mjs -> ../../subway-builder-export/*.json).
 *
 * Status (proof of concept, not yet tested in-game - see mods/tokyo-citypack/README.md):
 *  - demand_data.chome.json: game-native, chome level (19,614 points, 77,762 pops of exactly 200 people) - the real
 *    2020 census municipality-to-municipality O/D spread over chomes by employed-residents x workers weights.
 *    Follows the internal rules measured on the real game's own Tokyo file (see subway-builder-export/README.md).
 *  - buildings_index.all.json: real, all 23 wards (1,790,011 buildings, ~588 MB).
 *  - roads.all.geojson: real OSM roads (Overpass), all 23 wards, roadClass/structure/name populated
 *    (export-subway-builder-roads.mjs). Outside the 23 wards there are no roads to route driving-demand on.
 */

const MOD_ID = 'com.transitline.tokyo-citypack';
const CITY_CODE = 'TYOTL'; // "TYO" is already used by other Tokyo maps in the community registry; kept distinct
const TAG = `[${MOD_ID}]`;

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found.`);
} else {
  let initialized = false;

  // How game v1.7.1 reads a city's files (learned from its console, 2026-09-26): a path under "/data/" is fetched from
  // the game's local data server, which serves %APPDATA%\metro-maker4\cities\data\<CODE>\ (that is where Railyard
  // installs cities too). Relative paths get a broken URL ("...59330data/x"), other absolute paths need an IPC
  // (loadDataFileAbsolute) the game does not expose, and the buildings index must be the binary format, not JSON.
  // So the data files are NOT inside this mod: scripts/install-subway-builder-city.mjs puts them in that folder.
  const DATA = `/data/${CITY_CODE}/`;

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
          'Real 2020/2021 census commuter flows for Tokyo + Saitama/Chiba/Kanagawa, at chome level. ' +
          'Building footprints are the official Tokyo land-use survey, all 23 special wards.',
        population: 36889715,
        initialViewState: { zoom: 9.7, latitude: 36.02814, longitude: 139.5232, bearing: 0 },
      });

      api.cities.setCityDataFiles(CITY_CODE, {
        buildingsIndex: DATA + 'buildings_index.bin',
        demandData: DATA + 'demand_data.json',
        roads: DATA + 'roads.geojson', // real, 23 wards - see file header
      });

      api.ui.showNotification(`${TAG} Tokyo CityPack registered (code ${CITY_CODE}).`, 'success');
      console.log(`${TAG} Registered city ${CITY_CODE}.`);
    } catch (err) {
      console.error(`${TAG} Failed to initialize:`, err);
      api.ui.showNotification(`${MOD_ID} failed to load. Check console for details.`, 'error');
    }
  });
}
