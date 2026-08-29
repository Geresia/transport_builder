// Regenerates demand.json for the example pack.
//   node generate.mjs
// Fully synthetic: no external data source, therefore no licensing obligation.
// A radial city — dense core, residential rings — so Phase 1 gameplay is
// exercised against a structure resembling the eventual real target.
import { writeFileSync } from "node:fs";

const round = (n, d = 5) => Number(n.toFixed(d));
const ring = (count, radius, phase = 0) =>
  Array.from({ length: count }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / count;
    return [round(radius * Math.cos(a)), round(radius * Math.sin(a))];
  });

const points = [
  { id: "cbd", name: "Central Business District", location: [0, 0], residents: 900, jobs: 42000, kind: "commercial" },
];

ring(6, 0.02).forEach(([lon, lat], i) =>
  points.push({ id: `inner-${i + 1}`, location: [lon, lat], residents: 14000, jobs: 9500, kind: "mixed" })
);
ring(12, 0.045, Math.PI / 12).forEach(([lon, lat], i) =>
  points.push({ id: `mid-${i + 1}`, location: [lon, lat], residents: 21000, jobs: 3400, kind: "residential" })
);
ring(12, 0.075, Math.PI / 6).forEach(([lon, lat], i) =>
  points.push({ id: `outer-${i + 1}`, location: [lon, lat], residents: 12000, jobs: 1100, kind: "residential" })
);

const demand = {
  formatVersion: 1,
  model: "gravity",
  points,
  attractors: [
    {
      id: "airport", name: "Ringfield Airport", kind: "airport",
      location: [-0.082, 0.012], capacity: 18000, maxDistance: null, residentialSplit: 0,
    },
    {
      id: "university", name: "North Hill University", kind: "university",
      location: [0.008, 0.052], capacity: 26000, maxDistance: 30000, residentialSplit: 0.2,
    },
    {
      id: "stadium", name: "Riverside Stadium", kind: "stadium",
      location: [0.036, -0.041], capacity: 4200, maxDistance: 25000, residentialSplit: 0,
    },
  ],
};

writeFileSync(new URL("./demand.json", import.meta.url), JSON.stringify(demand, null, 2) + "\n");
console.log(`wrote ${points.length} points, ${demand.attractors.length} attractors`);
