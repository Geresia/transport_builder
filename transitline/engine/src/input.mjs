// Click a station and drag through others to lay a line; release to commit.
// Canvas backing-store pixels are kept equal to its CSS size (see main.mjs),
// so pointer offsets need no devicePixelRatio correction here.

const HIT_RADIUS_PX = 18;

function hitTestStation(state, projection, x, y, width, height) {
  let bestId = null;
  let bestDist = HIT_RADIUS_PX;
  for (const s of state.stations.values()) {
    const [sx, sy] = projection.toScreen(s.location, width, height);
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestDist) {
      bestDist = d;
      bestId = s.id;
    }
  }
  return bestId;
}

export function attachInput(canvas, state, projection, onLineCommitted) {
  let draft = null; // { stationIds: string[], cursor: [number, number] }

  const screenPos = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  };

  canvas.addEventListener("pointerdown", (ev) => {
    const [x, y] = screenPos(ev);
    const hit = hitTestStation(state, projection, x, y, canvas.width, canvas.height);
    if (hit) {
      draft = { stationIds: [hit], cursor: [x, y] };
      canvas.setPointerCapture(ev.pointerId);
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (!draft) return;
    const [x, y] = screenPos(ev);
    draft.cursor = [x, y];
    const hit = hitTestStation(state, projection, x, y, canvas.width, canvas.height);
    const last = draft.stationIds[draft.stationIds.length - 1];
    if (hit && hit !== last && !draft.stationIds.includes(hit)) draft.stationIds.push(hit);
  });

  const finish = () => {
    if (draft && draft.stationIds.length >= 2) onLineCommitted(draft.stationIds);
    draft = null;
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  return {
    get draft() {
      return draft;
    },
  };
}
