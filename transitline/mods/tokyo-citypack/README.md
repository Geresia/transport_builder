# Tokyo CityPack (Subway Builder mod, proof of concept)

Registers Greater Tokyo as a playable city in Subway Builder, backed by `../../subway-builder-export/`'s
generated data files. See that folder's README for what's real, what's modeled, and what's still missing
(most importantly: the 30 Tama-area municipalities have no chome-level data, and nothing has been loaded in the game).

## Status: builds cleanly, never opened in-game

Scaffolded from `template-mod-main` (Subway Builder's official generic starter, MIT - a cleaner reference than
`compatibility-test-mod`, which is a leftover compatibility-test stub). As of 2026-09-24 it loads:

- `data/demand_data.chome.json` - game-native chome-level demand (17,529 points, 74,445 pops of exactly 200);
- `data/buildings_index.all.json` - all 23 wards, 1,790,011 official-survey buildings (~588 MB);
- `data/roads.all.geojson` - real OSM roads for the 23 wards (`roadClass`/`structure`/`name`).

What each file is, what is modeled, and what it was compared against: `../../subway-builder-export/README.md`.

Build checks: `pnpm install` (via `corepack pnpm`, no global pnpm here), `pnpm typecheck`, `pnpm build` all
pass; `dist/index.js` parses (`node --check`); the export files pass `scripts/check-subway-builder-export.mjs`.
The ~588 MB buildings copy is a fast file copy, not a hang.

**Not done**: actually enabling this in the real game and watching it load (or fail). That's the only test of
whether these file shapes are truly correct - everything else here is static validation
(`../../subway-builder-export/README.md`'s "Verified against the real game" section did a read-only structural
comparison against the game's own installed Tokyo data, which is a good sign, but not the same as loading this
mod itself).

**Caution about `pnpm dev:link`**: it has no `--help` flag - passing one is silently ignored and it just links
for real. It creates a symlink at `%APPDATA%\metro-maker4\mods\tokyo-citypack` pointing at `dist/`. Subway
Builder is actually installed on this machine (confirmed 2026-09-23), so this is a real, live action, not a
sandcastle - `pnpm dev:unlink` removes it again. Don't run `dev:link` unless you mean to actually test-load the
mod.

## To actually test this in-game

```
pnpm build
pnpm dev:link
```

Then enable it in Subway Builder: Settings > Mods, and open (or create) the "Greater Tokyo (Transitline)"
city (code `TYOTL` - deliberately not `TYO`, to avoid clashing with other Tokyo maps in the community
registry). `pnpm dev:unlink` when done.
