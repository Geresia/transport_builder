# Transport Builder

Build a railway company around a city that already has a life of its own.

Transport Builder is a railway planning and management game in development, set first in Greater Tokyo. Players plan routes, compete for contracts, finance construction, procure trains, prepare depots, and bring services into operation. The ambition is to make those decisions matter together: a promising route still needs an affordable construction plan, a place to maintain its trains, and enough passengers to sustain the business once it opens.

The project combines a browser-based simulation engine with a regional data pipeline covering Tokyo, Saitama, Chiba, and Kanagawa. Census commuting patterns, neighborhood population and employment, building footprints, and existing rail infrastructure give the game a specific place to work with. The railway company is the player's creation; the city provides the conditions it has to answer to.

This repository contains the prototype, the CityPack data format, the Greater Tokyo pack and viewer, data preparation and validation tools, and an experimental Subway Builder export. Transport Builder is an independent project. Transitline is the working name used for its implementation.

## The product idea

A railway map makes every connection look deceptively simple. Running the company behind that map is a much more interesting problem.

A direct route may attract riders but require expensive underground construction. More frequent trains may reduce waiting while increasing fleet and depot requirements. A cheaper project may open later, tie up capital for longer, or leave a difficult interchange unresolved. Transport Builder is being built around these trade-offs, so that drawing a line is the beginning of a decision rather than its conclusion.

The intended experience follows the life of a transport business:

1. Find an opportunity. Examine demand, existing connections, and gaps in the network. Decide whether to expand the current railway or start from a blank network.
2. Develop a credible proposal. Select the route, running system, structures, and station approach. Submit the plan for technical review and evaluate the commercial terms.
3. Win the work. Review a tender, undertake optional due diligence, make a Bid/No-Bid decision, price the proposal, and negotiate an award.
4. Deliver the railway. Coordinate civil works, stations, depot preparation, rolling-stock procurement, railway systems, and testing. Respond when costs, materials, permits, or site conditions change.
5. Open and operate. Meet commissioning requirements, connect passengers to physical stations, run services, and settle the operating results.
6. Make the next investment. Use the consequences of earlier choices to decide where the company should grow.

Parts of this cycle already run together in the prototype. A fully integrated, polished Greater Tokyo campaign remains a development milestone.

## The audience and the business

Tokyo gives the game a clear starting audience: people who care about railways, transport networks, and the places those networks serve. A player might come for the railway they ride every day, a favorite train, or the chance to build a connection they have always thought should exist. The management game gives that interest somewhere to go after the first route is drawn.

Japan is a useful first market because railway enthusiasm already supports paid products in several forms. TOMIX lists its N700A basic model train set at JPY 16,940 including tax. JR East advertised a private railway photography session in Hachioji at JPY 30,000 for one participant. Another JR East railway experience event marked all three of its courses sold out. These are concrete examples of spending around specific trains and access to railway experiences. Sources: [TOMIX product listing](https://www.tomytec.co.jp/tomix/products/n/98573.html), [JR East photography event](https://media.jreast.co.jp/articles/6128), and [JR East sold-out experience event](https://media.jreast.co.jp/articles/6234).

There is also a direct precedent for selling digital railway content by route. JR EAST Train Simulator offers individual routes and vehicles as paid DLC through its [official Steam catalog](https://store.steampowered.com/dlc/2111630/?l=english). That is relevant to Transport Builder because a particular place or railway can be the reason someone buys another piece of content.

The inference is that a focused railway game has an audience worth testing, including enthusiasts willing to spend on detail and familiarity. These examples do not measure the average railway fan's budget or tell us how many will buy a management game. Model collectors, photographers, driving-simulator players, and company-management players overlap to an unknown extent. The first commercial test should find out how much of that audience wants to run the business behind the network.

The broader audience includes players who enjoy transport planning and management without being railway specialists. For them, the entry point is a readable game about connecting demand, delivering projects, and making a company work. Familiar geography can help attract attention, but clear feedback and satisfying decisions have to carry the experience.

## How the game could earn its keep

The proposed model is a paid base game built around Greater Tokyo, followed by optional regional DLC. The base game needs to be a complete experience in its own right. An expansion should give returning players a new place and a different set of business problems, with enough local detail to justify the purchase.

The commercial advantage of this approach is reuse. Passenger simulation, tendering, construction schedules, fleet procurement, depots, and company finance can support more than one region. A later release would add data, scenarios, local rules, vehicles, presentation, and testing on top of that foundation. Engine improvements could then benefit several regions at once.

That can improve development economics if the cost of producing each new region stays below the contribution it earns. It is not automatic. Data cleanup, localization, balancing, licensing, support, and maintaining compatibility with earlier packs all take time. The important production measure is the actual cost of taking a region from source research to a finished expansion.

A simple example shows the role of repeat purchases. At an assumed realized price of USD 30 per base-game copy, 10,000 copies would produce USD 300,000 in gross sales. If two regional expansions each reached 25% of those owners at an assumed realized price of USD 15, they would add USD 75,000 in gross sales. That would raise gross sales per original buyer from USD 30 to USD 37.50, before any sales to new players.

Those numbers are an illustration, not a sales forecast or announced pricing. They exclude refunds, taxes, store and publisher shares, development, marketing, and ongoing support. Gross sales are not profit. For production decisions, the useful calculation is:

```text
Break-even base-game copies =
  costs assigned to the base game / net contribution per copy

Break-even DLC buyers =
  costs assigned to the expansion / net contribution per DLC sale

DLC attachment rate =
  expansion buyers / eligible base-game owners
```

Net contribution needs to reflect actual receipts and variable costs rather than the storefront price. The business becomes more attractive when players return for expansions, regional production becomes repeatable, and support costs remain manageable. A strong Tokyo release is therefore the first priority: it must establish the audience and the quality standard that later DLC can build on.

## A regional DLC plan for East Asia

The expansion direction is to take the same transport-company game into Taiwan, South Korea, and China after Greater Tokyo. Each region would be sold as a substantial playable setting, with local demand, infrastructure, operating rules, and campaigns. The shared engine makes this possible in principle; each region still needs its own development budget and acceptance checks.

| Proposed expansion | Initial locations to evaluate | The experience to build |
|---|---|---|
| Taiwan | Taipei first, with Taichung or Kaohsiung as later candidates | A campaign connecting urban metro, commuter rail, and regional travel, with station access and interchange decisions suited to the selected city |
| South Korea | Seoul metropolitan area first; Busan and Daegu as later candidates | Metropolitan expansion, connections between urban and regional services, and construction and procurement scenarios using the Korean country profile |
| China | One bounded metropolitan region, with Shanghai, Beijing, or the Pearl River Delta as candidates | A larger-scale network campaign built around the chosen region's demand, transfer patterns, infrastructure, and local business rules |

These are content proposals, not completed packs or scheduled releases. Taiwan and China do not currently have integrated regional packs in this repository. Earlier Seoul, Busan, and Daegu research has been retained, and the engine already has a Korean scenario profile. That gives South Korea a starting point, but the research still needs to become a validated, playable product.

The first expansion should be chosen by data availability, player interest, and production cost. A tightly scoped, well-supported city is more useful than announcing nationwide coverage. For China in particular, the scope would depend on suitable data rights, localization, and the distribution requirements of the intended market. Revenue from mainland distribution should not be assumed before that route is established.

There are two reasons to pursue this regional approach. Existing players can buy another campaign without learning a different game, while each new setting gives local players a reason to discover the base product. Regional releases also provide concrete occasions for marketing: a new city, new operating challenges, and a new campaign are easier to show than a general promise of more features.

Localization would be part of the expansion work. Japanese, Korean, Traditional Chinese, Simplified Chinese, and English support would need clear UI terminology, readable place names, tutorials, and support material. The Tokyo prototype does not yet deliver that full language coverage.

Over time, the goal is a catalog of East Asian railway-management settings that share one maintained simulation. Its value would come from the quality of the cities and campaigns, the usefulness of the common systems, and players' willingness to return for another region.

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
| Tokyo data in the engine | Commuting and school origin-destination flows, plus the existing rail network | Buildings, terrain, and special-demand layers are not yet fully integrated into gameplay |
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

Neighborhood population and employment totals come from identified statistical sources. Building-level residents and jobs are modeled allocations of those totals, not observed headcounts for individual properties.

For Tokyo's 23 wards, population allocation uses building use and floor information, with coefficients fitted over 3,114 neighborhood areas. The documented fit reports an R² of approximately 0.74 for population and 0.85 for workplace employment. These are model-fit measures, not validation of any particular building's occupancy.

PLATEAU-based building employment allocations are available for eight cities outside the 23 wards: Saitama, Kawasaki, Sagamihara, Yokosuka, Atsugi, Fujisawa, Kamakura, and Yachiyo. Reported fit varies by city, with R² values of approximately 0.60-0.94. Where floor area is unavailable, some allocations use a disclosed proxy.

Other estimates are explicit: hospital capacity uses beds multiplied by three, university capacity uses category defaults, and illustrated Tokyo Station arrival dispersal is an assumption. The neighborhood-level commuting export disaggregates municipal OD rather than measuring neighborhood trips. Building popups retain the label “Model estimate : not measured.”

### Remaining data gaps

OSM building coverage is sparse in Edogawa, Katsushika, Adachi, and Itabashi. Tama has neighborhood data but no corresponding building layer in the current pack. Building-level jobs outside Tokyo are limited to the supported PLATEAU cities, leaving much of Yokohama and Chiba uncovered. Airports, ports, stadiums, shrines, and temples are not yet represented in the special-demand layer.

Workplace-based Economic Census counts and residence-based census employment counts differ in central wards. The pipeline preserves that distinction rather than forcing the totals to agree. Missing coverage and model assumptions need to remain visible as finer-grained demand enters gameplay.

## From prototype to a convincing product

The most useful next milestone is a coherent Greater Tokyo vertical slice: a player identifies a demand opportunity, proposes a route, wins a contract, delivers it, opens it, and sees the operating consequences on the same map.

The development priorities are:

- Close the regional gameplay loop. Verify construction, physical station creation, walking access, and operating settlement together on the Tokyo pack.
- Improve planning freedom and feedback. Move beyond the current demand-point anchors and make technical, cost, schedule, and access consequences clear during planning.
- Bring regional detail into decisions. Integrate building, terrain, and special-destination information where it changes route or station choices.
- Make management depth readable. Expose constraints and trade-offs through understandable controls, reports, and explanations of project verdicts.
- Validate playability and balance. Test whether players understand the business loop, find the decisions satisfying, and want another attempt. Technical regression coverage cannot answer those questions.
- Prove the content workflow. Use a second supported region to test how much of the pipeline transfers and how much local work remains.

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
