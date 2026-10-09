# B20-B24 foundation update

This supersedes the now-completed gaps listed in the earlier foundation-status
note without claiming that a Unity renderer has been built.

| Area | Foundation | Boundary |
| --- | --- | --- |
| B20-M2 | `regional-development-program-ui.mjs` (`5924649`) | Edits only map program/milestone statements; blank/null and `[]` references remain distinct. |
| B20-M3/M4 | `campaign-timeline-panel.mjs` (`4342624`) | Shows the existing clock and accepts only an explicit, current-geometry milestone declaration. A blank evidence editor is refused; an empty reference list must be explicitly declared. Due never changes state. |
| B21-C1 | `construction-3d-session-coordinator.mjs` (`3b8c8b4`) | Requires stated, exact pack/source revisions and an optional compatible client; missing source-pack provenance also stays `2d-only`. |
| B24 preflight | `construction-3d-preflight.mjs` | A saved coordinate profile is accepted only for its own pack; a missing, invalid, or other-pack profile leaves the game in `2d-only` mode. |

The B20 editor is now mounted and its document is in the integrated scenario
save (`be62b5d`); B20 milestone declarations are mounted with current geometry
and explicit player evidence (`4342624`); and B22/B23 have a 2D
identity/revision adapter (`95f1e84`).
Still separate work: an actual Unity/WebGL or desktop binary/loader, concrete
mesh/terrain rendering, B24 real 2D/3D round-trip plus performance
measurements. The 2D game remains authoritative for cash, ledger, demand,
passengers, timetable state, RNG, and the game clock.
