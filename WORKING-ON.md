# Being built right now (read before you start)

Updated 13 Nov 2026, 23:30 UTC. One session is building the items below. Do not edit the files they hold until the item is
marked landed here; if you must, write a line under "Notes from other sessions" first. Remove an item when it lands.

**How to build things now:** read `TAILZU-BACKEND/docs/renderer.md` before adding any screen, visual, animation or widget
look. The apps are renderers: build server data with the existing blocks and catalogs, not new client components.

## Landed today (on main, every switch off by default)

- Native looks: the server draws the widgets, the Live Activity, the Android "Bots at work" notice and the keyboard's key
  faces (`docs/native-looks.md`). Every card shows its own bot.
- The bots' animation engine, format 2 (scenes), behind `BOTS_SCENES`.
- Location ("Use my location"), contacts (the phone's picker, no permission) and workouts (Apple Health / Health Connect),
  behind `PERM_LOCATION`, `PERM_CONTACT_PICK`, `PERM_HEALTH_IOS`, `PERM_HEALTH_ANDROID` (`docs/perms.md`).
- The runtime check: `tools/ci/check-runtime.mjs` and `app/native-inputs.lock` (phone). Native additions need no runtime
  bump; changing an existing native package does. Run `node tools/ci/check-runtime.mjs --write` after native changes.
- **Safety net** (one bad node cannot crash a screen; `sdui.safe` / `sdui.off` / `sdui.motion` switches; crash-loop safe
  mode), frontend `7ddcf31`. Not switched on until V1: the server sends no `sdui.*` knob yet.
- **Launch animation from the server**, frontend `7ddcf31`. It rides the bootstrap as `app.launch`.
- **Paint, device facts, phone-local values, shell and data blocks**, frontend `7ddcf31`. Not switched on until V1: no
  screen can reach them.

## In progress (started 13 Nov 2026, 23:30 UTC)

All the building blocks are on main but not connected yet (see `docs/renderer.md`, section 3). Three jobs connect them now:
- **Phone renderer wiring (V1).** Holds `app/src/sdui/Renderer.tsx`, `actions.ts`, `state.ts`, `types.ts`, `registry.ts`,
  `fill.ts`, `client/capabilities.ts`, `live/live.ts`, `components/Screen.tsx`, the SDUI app root and navigation files, and
  the new `app/src/sdui/blocks/**`.
- **Server screen checker (S1).** Holds `TAILZU-BACKEND/shared/types/sdui.ts`, `tulmi/src/experience/sdui2/**` (new),
  `tulmi/src/experience/bots/lint.ts`, `tulmi/src/experience/phone/launch.ts`, the screen route in `tulmi/src/routes/app/**`,
  and adds `SDUI_V2` / `SDUI_V2_USERS` to `config.ts` (off by default).
- **Desktop copy (D1).** Holds `TAILZU-DESKTOP/src/app/sdui/v2/**` (new), `src/app/sdui/kernel.js` (generated),
  `core.js`, `nodes.js`, `app.html`.

Do not build screens with the new blocks until these land; until then use what `docs/renderer.md` section 2 lists.

## Numbers in use

- Migrations: 0087 lingo, 0088 native looks, 0089 lingo sentences, 0090 bot health days. Take the next free number and
  check `git log origin/main -- tulmi/supabase/migrations` first: two sessions have collided twice today.
- Phone runtime: `tailzu-2026-11-x0-blip`. Do not change it.

## Notes from other sessions

(none yet)
