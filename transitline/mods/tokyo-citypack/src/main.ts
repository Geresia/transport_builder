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

      // 2026-09-28 playtest: the bay read as barely darker than the land at the default colors. A stronger blue
      // gives the coastline actual contrast; game-native (setLayerOverride), no tile regeneration needed.
      api.map.setLayerOverride({ layerId: 'water', paint: { 'fill-extrusion-color': '#0a3d63' } });

      // 2026-09-28 playtest: rename the built-in US-flavoured train types to their closest Japanese-operator
      // equivalent (name/description/livery colour only - stats are untouched, so balance doesn't change).
      const trainTypeRenames: Record<string, { name: string; description: string; color: string }> = {
        'heavy-metro': {
          name: '지하철 (Chikatetsu)',
          description: '도쿄메트로/도영지하철 스타일의 대형 지하철 차량 (예: 도쿄메트로 10000계).',
          color: '#009944', // Tokyo Metro Ginza-line-adjacent green
        },
        'light-metro': {
          name: '신교통 시스템 (Shinkotsu)',
          description: '유리카모메 같은 고무바퀴 자동운전 신교통시스템 차량.',
          color: '#f39800',
        },
        'commuter-rail': {
          name: '통근형 전차 (JR 스타일)',
          description: 'JR 동일본 통근형 전차 스타일 (예: E231계/E233계).',
          color: '#00b2e5', // JR East Yamanote/Keihin-Tohoku blue-green family
        },
        'light-rail': {
          name: '노면전차 (LRT)',
          description: '도쿄 아라카와선 같은 노면전차/LRT 차량.',
          color: '#f9c900',
        },
        tram: {
          name: '노면전차 (Tram)',
          description: '시내를 달리는 소형 노면전차.',
          color: '#e6002d',
        },
      };
      for (const [id, { name, description, color }] of Object.entries(trainTypeRenames)) {
        if (!api.trains.getTrainType(id)) continue; // skip if the game ever renames/removes a built-in id
        api.trains.modifyTrainType(id, { name, description, appearance: { color } });
      }

      api.ui.showNotification(`${TAG} Tokyo CityPack registered (code ${CITY_CODE}).`, 'success');
      console.log(`${TAG} Registered city ${CITY_CODE}.`);
    } catch (err) {
      console.error(`${TAG} Failed to initialize:`, err);
      api.ui.showNotification(`${MOD_ID} failed to load. Check console for details.`, 'error');
    }
  });
}
