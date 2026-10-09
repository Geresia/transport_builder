import { DeterministicRng } from "./rng.mjs";
import { ManagementGame } from "./management/game.mjs";

export const INTEGRATED_SAVE_VERSION = 1;

function mapEntries(map) {
  return [...map.entries()].map(([key, value]) => [key, structuredClone(value)]);
}

export function snapshotOperationalState(state) {
  // The keys go out in sorted order: a state object keeps the order its keys were added in, and a key added after a restore (a B15 or B19
  // application) would otherwise sit somewhere else than in a run that never restored.  Equal states must give equal bytes.
  const plain = {};
  for (const key of Object.keys(state).sort()) {
    if (["stations", "demandNodes", "rng"].includes(key)) continue;
    plain[key] = structuredClone(state[key]);
  }
  return {
    ...plain,
    stations: mapEntries(state.stations),
    demandNodes: mapEntries(state.demandNodes ?? new Map()),
    rngState: state.rng?.snapshot?.() ?? null,
  };
}

export function restoreOperationalState(snapshot) {
  const state = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (["stations", "demandNodes", "rngState"].includes(key)) continue;
    state[key] = structuredClone(value);
  }
  state.stations = new Map(snapshot.stations.map(([key, value]) => [key, structuredClone(value)]));
  state.demandNodes = new Map((snapshot.demandNodes ?? []).map(([key, value]) => [key, structuredClone(value)]));
  state.rng = new DeterministicRng(1);
  if (snapshot.rngState !== null) state.rng.restore(snapshot.rngState);
  for (const line of state.lines ?? []) {
    // JSON encodes the initial -Infinity dispatch sentinel as null. Restore its operational meaning.
    if (line.lastDispatch === null) line.lastDispatch = -Infinity;
  }
  for (const operation of state.railReplacementOperations?.operations ?? []) {
    // JSON encodes the initial -Infinity dispatch sentinel as null.
    if (operation.lastDispatchMinute === null) operation.lastDispatchMinute = -Infinity;
  }
  return state;
}

export function saveIntegratedGame({ game, operationalState, packId, packVersion }) {
  if (!packId || !packVersion) throw new Error("Integrated saves require pack id and version");
  return JSON.stringify({
    schemaVersion: INTEGRATED_SAVE_VERSION,
    packId,
    packVersion,
    management: game.snapshot(),
    operations: snapshotOperationalState(operationalState),
  });
}

export function loadIntegratedGame(text, expectedPack) {
  const save = JSON.parse(text);
  if (save.schemaVersion !== INTEGRATED_SAVE_VERSION) throw new Error(`Unsupported integrated save schema ${save.schemaVersion}`);
  if (expectedPack?.id !== undefined && save.packId !== expectedPack.id) throw new Error(`Save requires pack ${save.packId}, not ${expectedPack.id}`);
  if (expectedPack?.version !== undefined && save.packVersion !== expectedPack.version) throw new Error(`Save requires pack version ${save.packVersion}, not ${expectedPack.version}`);
  const game = new ManagementGame({ countryId: save.management.countryId }).restore(save.management);
  const operationalState = restoreOperationalState(save.operations);
  return { game, operationalState, packId: save.packId, packVersion: save.packVersion };
}
