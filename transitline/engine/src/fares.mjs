// P4: fare groups of the reference game (doc "운임", computeJourneyFareBreakdown). One journey = its transit segments
// (walk/drive skipped). Each route belongs to a fare group with a fareSystem:
//   flat      one fare per group (per ride under "all-paid")
//   route     one fare per distinct route
//   zone      base + (zones-1) x per-zone, zones counted per leg or across the group
//   distance  boardingCharge + km x perKmRate on STRAIGHT-LINE km between board and alight stops
// All amounts are rounded to 0.05 and optionally capped by fareCap.
// transferPolicy: "count-within-group" (default; the group is charged once, cumulatively), "all-paid" (every leg pays in
// full) or "count-all-groups" (arriving from another group waives this group's entry charge once).
// ponytail: policy/zone-mode names are inferred from the bundle's string table (exact mapping not verifiable without
// running it); the arithmetic is decoded from the code. Tokyo-style distance bands and inter-operator discounts are the
// planned extension (doc section 6) and are NOT modelled here.
import { haversineMetres } from "./projection.mjs";

const INCREMENT = 0.05;
export const LEGACY_GROUP = "__legacy";

export const roundToIncrement = (x, inc = INCREMENT) => Math.round(Math.round(x / inc) * inc * 100) / 100;
const capped = (x, cap) => (cap > 0 ? Math.min(cap, x) : x);

export const distanceFare = (km, g, boarding = g.boardingCharge) => roundToIncrement(capped(boarding + km * g.perKmRate, g.fareCap));
export const zoneFare = (zones, g, base = g.zoneBaseFare) => roundToIncrement(capped(base + (Math.max(1, zones) - 1) * g.zonePerZoneFare, g.fareCap));

const legZones = (seg, g) => {
  if (!g.zoneIndexByStation) return [];
  const out = [];
  for (const id of [seg.fromStopId, seg.toStopId]) {
    const z = id !== undefined ? g.zoneIndexByStation[id] : undefined;
    if (z !== undefined && !out.includes(z)) out.push(z);
  }
  return out;
};
// "span": contiguous zones from lowest to highest touched (at most max(2, zoneTotal)); otherwise distinct zones touched.
const chargeableZones = (zones, g) => {
  const list = [...zones];
  if (!list.length) return 1;
  if (g.zonePricingMode === "span") return Math.min(Math.max(...list) - Math.min(...list) + 1, Math.max(2, g.zoneTotal));
  return list.length;
};
const segmentKm = (s) => (s.fromStopCoords && s.toStopCoords ? haversineMetres(s.fromStopCoords, s.toStopCoords) / 1000 : 0);

// segments: [{ routeId, fromStopId, toStopId, fromStopCoords, toStopCoords, kind? }]; fareIndex: { [routeId]: group }
export function computeJourneyFareBreakdown(segments, fareIndex, defaultFare) {
  const legacy = { groupId: LEGACY_GROUP, fareSystem: "flat", fare: defaultFare, transferPolicy: "count-within-group", boardingCharge: 0, perKmRate: 0, fareCap: 0, zoneBaseFare: 0, zonePerZoneFare: 0, zonePricingMode: "count", zoneTotal: 0 };
  const groups = new Map();
  const items = [];
  let total = 0, any = false;

  for (const seg of segments) {
    if (seg.kind === "walk" || seg.kind === "drive" || seg.routeId === "walking") continue;
    const g = fareIndex[seg.routeId] ?? legacy;
    let st = groups.get(g.groupId);
    const first = !st;
    if (first) groups.set(g.groupId, (st = { creditedEntry: any && g.transferPolicy === "count-all-groups", creditUsed: false, flatPaid: false, paidRoutes: new Set(), km: 0, charged: 0, zones: new Set() }));
    any = true;
    const item = { routeId: seg.routeId, groupId: g.groupId, fareSystem: g.fareSystem, amount: 0, kind: "paid", firstInGroup: first };
    const allPaid = g.transferPolicy === "all-paid";

    if (g.fareSystem === "flat") {
      if (allPaid) item.amount = g.fare;
      else if (!st.flatPaid) { if (st.creditedEntry) item.kind = "credited"; else item.amount = g.fare; st.flatPaid = true; }
      else item.kind = "included";
    } else if (g.fareSystem === "route") {
      if (allPaid) item.amount = g.routeFare;
      else if (!st.paidRoutes.has(seg.routeId)) {
        if (st.creditedEntry && !st.creditUsed) { st.creditUsed = true; item.kind = "credited"; } else item.amount = g.routeFare;
        st.paidRoutes.add(seg.routeId);
      } else item.kind = "included";
    } else if (g.fareSystem === "zone") {
      const zones = legZones(seg, g);
      item.zoneNumbers = zones.map((z) => z + 1);
      if (allPaid) {
        const n = chargeableZones(zones, g);
        item.amount = zoneFare(n, g);
        item.zoneCount = n;
      } else {
        zones.forEach((z) => st.zones.add(z));
        const base = st.creditedEntry ? 0 : g.zoneBaseFare;
        const n = chargeableZones(st.zones, g);
        const fare = zoneFare(n, g, base);
        item.amount = Math.max(0, fare - st.charged);
        item.zoneCount = n;
        st.charged = Math.max(st.charged, fare);
      }
    } else {
      const km = segmentKm(seg);
      item.legKm = km;
      const entry = st.creditedEntry ? 0 : g.boardingCharge;
      if (allPaid) item.amount = distanceFare(km, g);
      else {
        st.km += km;
        const fare = distanceFare(st.km, g, entry);
        item.amount = Math.max(0, fare - st.charged);
        st.charged = Math.max(st.charged, fare);
      }
    }
    total += item.amount;
    items.push(item);
  }
  return { total: Math.round(total * 100) / 100, items };
}

export const computeJourneyFare = (segments, fareIndex, defaultFare) => computeJourneyFareBreakdown(segments, fareIndex, defaultFare).total;
