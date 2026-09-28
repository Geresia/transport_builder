// Adapter: StationSite (station-site.mjs's output) -> local-metre shapes for a 3D site-design renderer.
// Pure and read-only over the site: no mutation, no network/DOM/Three.js, no cost/duration/risk, and no
// import from engine/src/management/**. See docs/site-design-mvp-2026-09-28.md for the module boundary
// this keeps and packs/tokyo/site-design.html for the renderer that consumes it.
import { frameAt } from "./local-geometry.mjs";
import { factRows } from "./station-view.mjs";

export const SITE_DESIGN_SCENE_SCHEMA = "transitline.site-design-scene/1";

// Nominal render sizes for shapes the station-site contract has no geometry for (a station hall's storey
// height, an entrance kiosk's height). Visualisation only, not an engineering or cost figure.
export const SITE_DESIGN_MODEL = Object.freeze({
  bodyHeightMeters: 6,
  entranceHeightMeters: 4,
  workAreaHeightMeters: 0.3,
});

const ringXY = (ring, frame) => ring.map((p) => frame.xy(p));

// site: one StationSite (buildStationSite()'s return, or one entry of buildStationExport().sites).
export function buildStationSiteScene(site) {
  if (!site || site.schema !== "transitline.station-site-geometry/1") throw new Error("buildStationSiteScene: expects a StationSite (transitline.station-site-geometry/1)");
  const frame = frameAt(site.location);
  const depth = site.plannedDepthMeters;
  // underground / cut-cover bodies sit below the ground plane; surface stays at it. An elevated body also
  // stays at 0 because the contract has no viaduct height (station-site.mjs marks it "no-structure-height").
  const baseZMeters = typeof depth === "number" && depth > 0 ? -depth : 0;

  const body = site.bodyPolygon
    ? {
        polygonXY: ringXY(site.bodyPolygon, frame),
        baseZMeters,
        heightMeters: SITE_DESIGN_MODEL.bodyHeightMeters,
        lengthMeters: site.bodyLengthMeters,
        widthMeters: site.bodyWidthMeters,
        headingDegrees: site.bodyHeadingDegrees,
        areaSquareMeters: site.bodyAreaSquareMeters,
        structure: site.planHints?.structure ?? null,
      }
    : null;

  const entrances = site.entranceCandidates.map((e) => ({
    id: e.entranceId,
    name: e.name,
    xy: frame.xy(e.location),
    footprintMeters: site.model?.entranceFootprintMeters ?? null,
    distanceToBodyMeters: e.distanceToBodyMeters,
    baseZMeters: 0,
    heightMeters: SITE_DESIGN_MODEL.entranceHeightMeters,
    blocked: e.spatialFlags.includes("building-collision") || e.spatialFlags.includes("in-water"),
    flags: e.spatialFlags,
  }));

  const workAreas = site.workAreaCandidates.map((w) => ({
    id: w.workAreaId,
    slot: w.slot,
    polygonXY: ringXY(w.polygon, frame),
    areaSquareMeters: w.areaSquareMeters,
    baseZMeters: 0,
    heightMeters: SITE_DESIGN_MODEL.workAreaHeightMeters,
    blocked: w.spatialFlags.length > 0,
  }));

  return {
    schema: SITE_DESIGN_SCENE_SCHEMA,
    stationSiteId: site.stationSiteId,
    name: site.name,
    origin: site.location,
    groundElevationMeters: site.groundElevationMeters,
    averageSlopePercent: site.averageSlopePercent,
    maximumSlopePercent: site.maximumSlopePercent,
    dataQuality: site.dataQuality,
    body,
    entrances,
    workAreas,
    flags: site.spatialFlags,
    unknown: site.unknown,
    unknownReasons: site.unknownReasons,
    facts: factRows(site),
  };
}
