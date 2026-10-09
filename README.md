# Transport Builder

**Build a railway company around a city that already has a life of its own.**

Transport Builder is a railway planning and management game in development, set first in Greater Tokyo. Players plan routes, compete for contracts, finance construction, procure trains, prepare depots, and bring services into operation. The ambition is to make those decisions matter together: a promising route still needs an affordable construction plan, a place to maintain its trains, and enough passengers to sustain the business once it opens.

The project combines a browser-based simulation engine with a regional data pipeline covering Tokyo, Saitama, Chiba, and Kanagawa. Census commuting patterns, neighborhood population and employment, building footprints, and existing rail infrastructure give the game a specific place to work with. The railway company is the player's creation; the city provides the conditions it has to answer to.

This repository contains the prototype, the CityPack data format, the Greater Tokyo pack and viewer, data preparation and validation tools, and an experimental Subway Builder export. Transport Builder is an independent project. Transitline is the working name used for its implementation.

## The product idea

A railway map makes every connection look deceptively simple. Running the company behind that map is a much more interesting problem.

A direct route may attract riders but require expensive underground construction. More frequent trains may reduce waiting while increasing fleet and depot requirements. A cheaper project may open later, tie up capital for longer, or leave a difficult interchange unresolved. Transport Builder is being built around these trade-offs, so that drawing a line is the beginning of a decision rather than its conclusion.

The intended experience follows the life of a transport business:

1. **Find an opportunity.** Examine demand, existing connections, and gaps in the network. Decide whether to expand the current railway or start from a blank network.
2. **Develop a credible proposal.** Select the route, running system, structures, and station approach. Submit the plan for technical review and evaluate the commercial terms.
3. **Win the work.** Review a tender, undertake optional due diligence, make a Bid/No-Bid decision, price the proposal, and negotiate an award.
4. **Deliver the railway.** Coordinate civil works, stations, depot preparation, rolling-stock procurement, railway systems, and testing. Respond when costs, materials, permits, or site conditions change.
5. **Open and operate.** Meet commissioning requirements, connect passengers to physical stations, run services, and settle the operating results.
6. **Make the next investment.** Use the consequences of earlier choices to decide where the company should grow.

Parts of this cycle already run together in the prototype. A fully integrated, polished Greater Tokyo campaign remains a development milestone.

## Why this is worth building

The central product thesis is that a recognizable city and a consequential railway business can reinforce each other. Real geography gives players a reason to care about a connection; construction and operating constraints give them a reason to think carefully before making it.

**The setting creates specific questions.** Demand is anchored in an actual metropolitan region rather than interchangeable dots. Commuting flows can reveal why a connection is useful, while existing railways make expansion a different problem from building an entirely new network. The same region can support different starting conditions without requiring a different simulation engine.

**The management systems give the map lasting consequences.** Routes, stations, trains, depots, contracts, schedules, and cash belong to one business. Bringing these systems together offers room for long campaigns in which an early compromise affects later expansion. The challenge is to present that depth clearly enough that players understand the outcome of a decision.

**The regional pipeline is reusable work.** Public datasets are available to everyone; turning them into a consistent, attributed, validated game dataset takes additional work. The project has scripts for reconciling administrative areas, allocating neighborhood totals, preparing spatial layers, and exporting demand. That accumulated work is a foundation for producing further regions, although each city will still require source research and quality checks.

**The architecture supports a broader content plan.** CityPacks are separate from the engine. New regions and authored scenarios are therefore plausible ways to extend the product without building a new game for each release. Country profiles already distinguish Japanese and Korean scenario rules, while synthetic packs allow systems to be exercised independently of the large Tokyo dataset.

The intended commercial direction is a paid game. Additional regions and scenario content are potential extensions, not announced products. This repository provides evidence of technical progress; it does not yet establish willingness to pay, player retention, or a validated market size. The next persuasive proof should be a playable slice that people choose to keep playing.

## What exists today

The project is a development prototype with functioning simulation and management workflows.

| Area | Current implementation | Practical boundary |
|---|---|---|
| CityPack format | Documented format, manifest and demand schemas, validation tools, and two synthetic example packs | New regions require local data preparation and source review |
| Passenger and train simulation | Route creation, dispatch, routing, transfers, capacity limits, walking/driving/transit choice, and gravity or matrix demand | Passenger volumes are scaled for legibility; movement and route choice use prototype simplifications |
| Company management | Tendering, construction, fleet procurement, depot preparation, opening checks, operating settlement, and save/load | Content breadth and balance still need development |
| Construction delivery | Monthly dependencies, baseline and forecast schedules, delays, critical-chain reporting, and construction packages | More developed than the complete regional player experience |
| Construction events | Deterministic events and responses affecting cost, time, safety, quality, and reputation | Probabilities and response coefficients are initial game-balance values |
| Integrated scenario screen | Plan submission, project workflow, commissioning, operations, and combined save state | Planning starts from visible demand points or stations |
| Greater Tokyo viewer | Regional layers, neighborhood statistics, building estimates, and optional 3D visualization | Coverage varies by area; visual estimates are labeled |
| Tokyo data in the engine | Commuting and school origin–destination flows, plus the existing rail network | Buildings, terrain, and special-demand layers are not yet fully integrated into gameplay |
| Subway Builder compatibility | Export scripts and mod build source | Loading and playing the generated mod in the actual game remain unverified |

The engine uses vanilla JavaScript ES modules and Canvas 2D, with no engine build step or package installation required to run the prototype. It advances the simulation in fixed steps and preserves random state in integrated saves. The regression suite covers domain rules, map contracts, and save/resume behavior; run it against the current checkout rather than relying on an old test count.

Further management modules cover station delivery, contractor selection, corporate finance, infrastructure maintenance, track access, and through-service compatibility. Their presence does not imply that every system has a complete player-facing flow in the Tokyo scenario. Implementation reports and the system roadmap provide the detailed evidence.

## Greater Tokyo: a foundation built from real data

The first CityPack brings together several scales of information: municipality-level travel patterns, neighborhood-level population and employment, and building-level spatial detail where the source material supports it.

| Layer | Coverage and source basis |
|---|---|
| Population | 242 municipal/ward demand points, primarily based on the 2020 census; later estimates carry a per-point `popDate` |
| Neighborhoods | Chome and other small-area boundaries and population across the 23 wards, Tama, and the surrounding prefectures, using e-Stat and NII Geoshape material |
| Employment | Neighborhood workplace employment from the 2021 Economic Census, alongside resident employed-person counts from the 2020 census |
| Commuting | 38,805 municipality-to-municipality commuting OD pairs, plus school-travel OD from the 2020 census |
| Buildings | Tokyo land-use survey and OSM footprints; approximately 5.12 million OSM buildings across the three surrounding prefectures |
| Infrastructure | Existing OSM railways, roads and pedestrian layers, basemap data, terrain, and GEBCO bathymetry |
| Special destinations | 465 universities and 1,047 hospitals derived from national land information |
| Additional demand context | Tokyo tourism material from 2025 and Shinkansen/limited-express inflow material from a 2015 survey |

These datasets have different dates, definitions, and levels of completeness. They are a source base for the game, not a claim that the simulation reproduces present-day Tokyo exactly. Detailed provenance is recorded in the [Tokyo pack documentation](./transitline/packs/tokyo/README.md) and [attribution file](./transitline/packs/tokyo/ATTRIBUTION.md).

### What is measured, and what is modeled

Neighborhood population and employment totals come from identified statistical sources. Building-level residents and jobs are **modeled allocations of those totals**, not observed headcounts for individual properties.

For Tokyo's 23 wards, population allocation uses building use and floor information, with coefficients fitted over 3,114 neighborhood areas. The documented fit reports an R² of approximately 0.74 for population and 0.85 for workplace employment. These are model-fit measures, not validation of any particular building's occupancy.

PLATEAU-based building employment allocations are available for eight cities outside the 23 wards: Saitama, Kawasaki, Sagamihara, Yokosuka, Atsugi, Fujisawa, Kamakura, and Yachiyo. Reported fit varies by city, with R² values of approximately 0.60–0.94. Where floor area is unavailable, some allocations use a disclosed proxy.

Other estimates are explicit: hospital capacity uses beds multiplied by three, university capacity uses category defaults, and illustrated Tokyo Station arrival dispersal is an assumption. The neighborhood-level commuting export disaggregates municipal OD rather than measuring neighborhood trips. Building popups retain the label **“Model estimate — not measured.”**

### Remaining data gaps

OSM building coverage is sparse in Edogawa, Katsushika, Adachi, and Itabashi. Tama has neighborhood data but no corresponding building layer in the current pack. Building-level jobs outside Tokyo are limited to the supported PLATEAU cities, leaving much of Yokohama and Chiba uncovered. Airports, ports, stadiums, shrines, and temples are not yet represented in the special-demand layer.

Workplace-based Economic Census counts and residence-based census employment counts differ in central wards. The pipeline preserves that distinction rather than forcing the totals to agree. Missing coverage and model assumptions need to remain visible as finer-grained demand enters gameplay.

## From prototype to a convincing product

The most useful next milestone is a coherent Greater Tokyo vertical slice: a player identifies a demand opportunity, proposes a route, wins a contract, delivers it, opens it, and sees the operating consequences on the same map.

The development priorities are:

- **Close the regional gameplay loop.** Verify construction, physical station creation, walking access, and operating settlement together on the Tokyo pack.
- **Improve planning freedom and feedback.** Move beyond the current demand-point anchors and make technical, cost, schedule, and access consequences clear during planning.
- **Bring regional detail into decisions.** Integrate building, terrain, and special-destination information where it changes route or station choices.
- **Make management depth readable.** Expose constraints and trade-offs through understandable controls, reports, and explanations of project verdicts.
- **Validate playability and balance.** Test whether players understand the business loop, find the decisions satisfying, and want another attempt. Technical regression coverage cannot answer those questions.
- **Prove the content workflow.** Use a second supported region to test how much of the pipeline transfers and how much local work remains.

The [system roadmap](./transitline/docs/b12-b20-system-roadmap-2026-10-03.md) describes further work on through-running, capacity, disruption recovery, demand, and company management. It records development direction rather than a release commitment.

## Try the prototype

Run these commands from the repository root. The browser loads data with `fetch()`, so use an HTTP server rather than opening the HTML through `file://`.

### Explore the Tokyo dataset

```powershell
powershell -NoProfile -File transitline\docs\serve.ps1 -Port 8020 -Root transitline\packs\tokyo -Index viewer.html
```

Open `http://localhost:8020/viewer.html`. The supplied server supports HTTP Range requests needed for PMTiles. If building tiles fail to appear, check that the running server supports those requests.

### Play the engine and management scenario

```powershell
powershell -NoProfile -File transitline\docs\serve.ps1 -Port 8000 -Root transitline -Index engine/index.html
```

| URL | Experience |
|---|---|
| `http://localhost:8000/engine/index.html` | Integrated construction scenario on the synthetic radial pack |
| `http://localhost:8000/engine/index.html?play=sandbox` | Free, instant route construction |
| `http://localhost:8000/engine/index.html?pack=../packs/tokyo` | Greater Tokyo with its existing rail network |
| `http://localhost:8000/engine/index.html?pack=../packs/tokyo&network=scratch` | The same region with a blank starting network |
| `http://localhost:8000/engine/management.html` | Dedicated company-management scenario |

Scenario options include `country=JP|KR`, `network=existing|scratch`, `difficulty=easy|normal|hard`, and `funding=limited|sandbox`. See the [engine README](./transitline/engine/README.md) for behavior and limitations. English documentation does not imply that the prototype interface is fully localized.

### Check the implementation and data

The development environment uses Node.js 24. From the project directory:

```powershell
cd transitline
npm test
npm run validate
node scripts/validate-pack.mjs packs/tokyo
```

There is no package installation step for these engine and validation commands. Pack checks cover schemas, cross-file consistency, compressed copies, statistical totals, and declared licensing constraints.

## Architecture

The repository separates regional data preparation, published data packs, and the game engine. This makes it possible to investigate a data problem without changing the business simulation, or develop a management rule against a small synthetic pack before loading the full regional dataset.

```text
transitline/
  engine/                 Simulation, company management, and prototype screens
  packs/                  Greater Tokyo and synthetic CityPacks
  scripts/                Data preparation, export, and validation
  schemas/                CityPack manifest and demand contracts
  docs/                   Designs, implementation reports, and local server
  data-raw/               Locally downloaded source data; not tracked in Git
  subway-builder-export/  Experimental compatibility export
  mods/tokyo-citypack/     Source for registering the exported pack as a mod
```

The map supplies spatial facts and plan geometry. The management engine owns money, schedules, contracts, and project verdicts. Their [versioned plan contract](./transitline/docs/plan-geometry-contract-v1.md) keeps those responsibilities explicit. Commissioning creates physical stations, platforms, and track, while walking access links connect demand nodes to completed infrastructure.

The Tokyo viewer is a data inspection tool, distinct from the current Canvas game screen. Its regional layers and optional 3D presentation should not be mistaken for a fully integrated 3D game engine.

### Data availability

A local working dataset includes roughly 3 GB of downloaded source material, including terrain, PLATEAU, and e-Stat files. Those originals are excluded from Git. Some large export outputs, including a roughly 588 MB building export, are generated locally. A fresh clone may require source downloads and regeneration for particular workflows. See the [source-data instructions](./transitline/data-raw/README.md).

The root folders `bot/`, `depot/`, `monorepo/`, `registry/`, and `template-mod/`, when present locally, are ignored reference checkouts of community repositories. They are not Transport Builder's implementation.

## Commercial intent and data licensing

The planned product is a proprietary commercial game that reads separately maintained CityPacks through a documented format. The data pipeline is a development tool; OSM-derived geometry and databases stay in the data layer, with source attribution and license declarations attached to each pack.

This separation is a deliberate engineering choice for managing third-party data obligations. The repository's [licensing notes](./transitline/LICENSING.md) describe the intended boundary and source restrictions. They are working notes, not a completed legal clearance for release. Commercial distribution will require review of the actual shipped software, packs, and source terms.

Subway Builder is a genre reference and an experimental export target. The compatibility work is separate from the independent game and does not establish an affiliation, partnership, or verified in-game integration.

## Further reading

Most detailed research and implementation reports are currently in Korean; this README provides the English overview.

| Document | What it explains |
|---|---|
| [Project notes](./transitline/README.md) | Internal structure, development history, and remaining work |
| [Engine](./transitline/engine/README.md) | Run options, simulation behavior, and intentional simplifications |
| [CityPack format](./transitline/docs/citypack-format.md) | The contract between regional data and the game |
| [Tokyo pack](./transitline/packs/tokyo/README.md) | Coverage, models, and source limitations |
| [Management implementation](./transitline/docs/management-engine-implementation-2026-09-25.md) | The initial business scenario and its verification |
| [Depot management](./transitline/docs/depot-management-implementation-2026-09-26.md) | Depot requirements, site evaluation, and delivery |
| [Integrated construction schedule](./transitline/docs/integrated-construction-schedule-implementation-2026-09-27.md) | Dependencies, delays, baseline schedules, and opening gates |
| [Construction events](./transitline/docs/construction-event-response-engine-2026-09-28.md) | Site events, player responses, and modeled consequences |
| [System roadmap](./transitline/docs/b12-b20-system-roadmap-2026-10-03.md) | Further transport-company systems and acceptance criteria |
| [Railway design research](./transitline/docs/railway-construction-master-report-kr-jp-2026.md) | Infrastructure, construction, fleet, and depot design basis |
| [Map-to-engine contract](./transitline/docs/map-plan-contract.md) | Planning and management responsibilities |
| [Subway Builder export](./transitline/subway-builder-export/README.md) | Experimental export workflow and validation |

Earlier Seoul, Busan, and Daegu research remains in the repository, but those regional builds are paused. Greater Tokyo is the current focus.
