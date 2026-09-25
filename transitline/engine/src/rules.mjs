// Constants of the reference game (Subway Builder v1.7.1) as documented in
// ../../docs/subway-builder-mechanics-study.md. Numbers and behaviour only; nothing is copied from the game's
// code. Where the doc marks a value "unconfirmed", the comment says so. Every constant here is the CODE default, not
// game-rules.json (doc section 0: the json is read by no code we found).
// Not yet wired into the running engine: state.mjs/trains.mjs keep their own tuned values (README "Known Phase 1
// simplifications"). New modules (construction-cost, train-physics, pop-journey, economy) read from here.

export const GAME_SECONDS_PER_TICK = 0.5;

export const RULES = Object.freeze({
  time: {
    speeds: [1, 25, 250, 500], // game seconds per real second (1x..4x)
    commuteIntervalS: 15 * 60, // pops are released in 15-minute batches
    transitionWindowS: 30 * 60, // train-count fade before/after a demand level change (fallback)
    transitionWindowMaxS: 90 * 60, // cap for long routes
    maxWaitAtTerminalS: 14 * 60,
    stuckTrainTimeoutS: 15 * 60,
    keepCommuteDataS: 24 * 3600,
    maxJourneyS: 12 * 3600, // pop movement with no update for this long is dropped (hourly sweep)
  },
  economy: {
    startingMoney: 3e9,
    startingTrainCars: 30,
    defaultFare: 3,
    // FARE_MULTIPLIER = GOVT(1) x TIME(365) and the game's train operating cost carries the same 365 (video: $273,750/hr
    // = 750 x 365). WHY 365 is unconfirmed; treat it as an economy scale that inflates revenue and cost alike.
    fareMultiplier: 1 * 365,
    timeMultiplier: 365,
    infrastructureChargeIntervalS: 5 * 60,
    operationalChargeIntervalS: 15 * 60,
    maintenanceCostMultiplier: 2, // applied to per-metre track and per-year station upkeep
    capacityWarningEmptySeats: 100, // warn when a train has fewer empty seats than this (reduced-threshold flag off)
    bonds: {
      // interest = daily rate x principal / 24 per game hour; repayment = fraction of ORIGINAL principal per hour
      SMALL: { principal: 1e8, dailyInterest: 0.06, hourlyRepay: 1e-3, requiredDailyRevenue: 1e7 },
      MEDIUM: { principal: 5e8, dailyInterest: 0.04, hourlyRepay: 8e-4, requiredDailyRevenue: 1e8 },
      LARGE: { principal: 1e9, dailyInterest: 0.02, hourlyRepay: 6e-4, requiredDailyRevenue: 2e8 },
    },
  },
  construction: {
    minTrackLengthM: 10,
    maxTrackLengthM: 10000, // game-rules.json says 5000 (doc section 0)
    minElevationM: -100,
    maxElevationM: 20,
    stationLengthBufferM: 4,
    stationHeightM: 4, // vertical clearance for grade-separated crossings
    // Class of an elevation e: e<=deepBore -> deepBore; <=standardTunnel -> standardTunnel; <=trenched(-4) -> cutAndCover;
    // <=atGrade(-1) -> trenched; <=ramp(0) -> atGrade; <ELEVATED(5) -> ramp; else elevated. (-10 is display-only.)
    thresholds: { deepBore: -100, standardTunnel: -24, cutAndCover: -10, trenched: -4, atGrade: -1, ramp: 0, elevated: 5 },
    elevationMultiplier: { deepBore: 4.5, standardTunnel: 2, cutAndCover: 1, trenched: 0.5, atGrade: 0.35, ramp: 0.5, elevated: 0.8 },
    // Extra multiplier on the water-crossing share (applied on top of the elevation multiplier). 100 = not buildable.
    waterMultiplier: { deepBore: 1.44444, standardTunnel: 1.5, cutAndCover: 3, trenched: 100, atGrade: 100, ramp: 100, elevated: 2.5 },
    lane: { single: 0.75, parallel: 1, quad: 1.5 },
    stationLengthCostFactor: 0.25, // share of station cost that scales with platform capacity in cars
    yardTrackMultiplier: 0.5,
    tbmMobilizationUsd: 4e7, // per contiguous deep-bore stretch
    buildingOverpass: { verticalClearanceM: 3, costPremium: 3, standardSpanM: 35, pierUsdPerMeterHeight: 2e5, minBuildingHeightM: 3 },
    gradeCrossing: { roadClass: { minor: 1, medium: 1.25, major: 1.5, highway: 2 }, lanes: { 1: 0.75, 2: 1, 4: 1.5 } },
    // Platform layout -> station cost multiplier. Names inferred from the doc/game ("side" is 0.75, quad/express 1.25).
    platformLayout: { side: 0.75, express: 1.25, quad: 1.25 },
  },
  motion: { maxJerk: 0.3, speedMargin: 0.01, roundTo: 1e4, stopTimeS: 25 },
  demandLevelByHour: [
    "veryLow", "veryLow", "veryLow", "low", "low", "low", "medium", "high", "high", "high", "medium", "medium",
    "medium", "medium", "medium", "medium", "high", "high", "high", "medium", "low", "low", "low", "veryLow",
  ],
  // [startHour, endHour, homeDemand, workDemand]
  timeOfDay: [
    [0, 3, 0.15, 0.15], [3, 6, 0.3, 0.3], [6, 7, 1, 0.3], [7, 10, 2.5, 0.3], [10, 11, 1, 0.8], [11, 15, 0.8, 0.8],
    [15, 16, 0.8, 1], [16, 19, 0.3, 2.5], [19, 20, 0.3, 1], [20, 23, 0.3, 0.3], [23, 24, 0.15, 0.15],
  ],
  // Perceived-time weights (Wardman 2026 as used by the game) and the car alternative.
  perceived: { walk: 1.39, airportWalk: 1.87, wait: 1.37, departureShift: 0.4, congestedDriving: 1.33, parkingSearch: 1.6 },
  mode: {
    drivingUsdPerKm: 0.65, parkingUsd: 5, parkingSeconds: 180, workHoursPerYear: 1860, minTransitPerPoint: 10,
    incomeMean: 6e4, incomeStd: 25e3, minIncome: 15e3, maxIncome: 2e5,
    airportIncomeMult: 1.5, collegeIncomeMult: 0.6, airportParkingMult: 5,
    minSensibleDrivingM: 1000, // shorter drives get a hassle penalty: 1 + (1000 - d)/1000
    congestionFullAtMultiplier: 2, // traffic multiplier at which the whole car trip counts as congested
    // Driving-time multiplier by the demand multiplier of the hour (max of home/work demand): see timeOfDay above.
    drivingTimeByDemand: { 0.15: 0.8, 0.3: 0.9, 0.8: 1, 1: 1.25, 2.5: 1.5 },
  },
  // Pathfinding limits (rRAPTOR in the game); kept here for the router that will replace Dijkstra.
  pathfinding: { maxTransfers: 4, maxTransferWalkS: 600, maxWalkToStationS: 45 * 60, maxDriveToStationS: 7 * 60, arrivalGapS: 50, rangeWindowS: 1800, maxRangeDepartures: 24, futureCycleOffsetS: 7200 },
});

// Train types (v1.7.1 stats). carCost/base costs in USD; speeds m/s; lengths m.
const T = (o) => Object.freeze(o);
export const TRAIN_TYPES = Object.freeze({
  "heavy-metro": T({ name: "Heavy Metro", maxAcc: 1.12, maxDec: 1.34, maxSpeed: 24.72, maxSpeedLocalStation: 13, capacityPerCar: 240, carLength: 18.35, stationCarLength: 18.75, minCars: 5, maxCars: 15, carSet: 1, carCost: 2.7e6, baseTrackCostPerM: 3e4, baseStationCost: 6e7, opCostPerHour: 250, opCostPerCarHour: 25, trackMaintPerM: 180, stationMaintPerYear: 1.6e5, stopTimeS: 25, turnaroundS: 60, minTurnRadius: 29, minStationTurnRadius: 150, maxSlopePct: 5.5, maxLateralAcc: 1, tphLimit: 42, maxOverpassSpanM: 65, allowGradeCrossing: false }),
  "light-metro": T({ name: "Light Metro", maxAcc: 1.2, maxDec: 1.1, maxSpeed: 27.78, maxSpeedLocalStation: 13, capacityPerCar: 200, carLength: 19.05, stationCarLength: 19.05, minCars: 2, maxCars: 4, carSet: 2, carCost: 2.5e6, baseTrackCostPerM: 3e4, baseStationCost: 4.5e7, opCostPerHour: 180, opCostPerCarHour: 20, trackMaintPerM: 140, stationMaintPerYear: 1e5, stopTimeS: 25, turnaroundS: 10, minTurnRadius: 29, minStationTurnRadius: 150, maxSlopePct: 5.5, maxLateralAcc: 1, tphLimit: 42, maxOverpassSpanM: 80, allowGradeCrossing: false }),
  "light-rail": T({ name: "Light Rail", maxAcc: 1.34, maxDec: 1.34, maxSpeed: 24.4, maxSpeedLocalStation: 6.7, capacityPerCar: 77, carLength: 9.58, stationCarLength: 9.58, minCars: 3, maxCars: 12, carSet: 3, carCost: 2e6, baseTrackCostPerM: 2.5e4, baseStationCost: 4e7, opCostPerHour: 220, opCostPerCarHour: 20, trackMaintPerM: 140, stationMaintPerYear: 1e5, stopTimeS: 25, turnaroundS: 90, minTurnRadius: 25, minStationTurnRadius: 200, maxSlopePct: 7, maxLateralAcc: 1.11, tphLimit: 28, maxOverpassSpanM: 150, allowGradeCrossing: true }),
  "commuter-rail": T({ name: "Commuter Rail", maxAcc: 0.894, maxDec: 1.34, maxSpeed: 35.76, maxSpeedLocalStation: 15, capacityPerCar: 106, carLength: 26, stationCarLength: 26, minCars: 4, maxCars: 14, carSet: 2, carCost: 3.5e6, baseTrackCostPerM: 2.5e4, baseStationCost: 5.5e7, opCostPerHour: 500, opCostPerCarHour: 35, trackMaintPerM: 300, stationMaintPerYear: 1.6e5, stopTimeS: 40, turnaroundS: 120, minTurnRadius: 88, minStationTurnRadius: 500, maxSlopePct: 3.5, maxLateralAcc: 1, tphLimit: 30, maxOverpassSpanM: 50, allowGradeCrossing: true }),
});
export const DEFAULT_TRAIN_TYPE = "heavy-metro";
