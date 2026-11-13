# Being built right now (read before you start)

Updated 13 Nov 2026, 22:40 UTC. One session is building the items below. Do not edit the files they hold until the item is
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

## In progress (phone: TAILZU-FRONTEND/app)

The new building blocks (over the air, no store build; `pure` spec):
- Kernel: `src/sdui/kernel/**` (new), generated into `TAILZU-DESKTOP/src/app/sdui/kernel.js` and
  `TAILZU-BACKEND/shared/sdui/kernel.cjs` (never edit those two by hand).
- Motion and gestures on any node: `src/sdui/motion/**`, `src/sdui/gesture/**`, `src/sdui/components/Screen.tsx`, `Scroll.tsx`.
- Lists, inputs, media: `src/sdui/components/{List,Each,Video,Audio,Camera}.tsx`, `src/sdui/components/input/**`,
  `src/sdui/components/index.ts`.
- Shared: `tools/knobs/app-knobs.json`, `tools/ci/marked-regions.mjs`.
- Generated kernels: `TAILZU-BACKEND/shared/sdui/kernel.cjs` and `tulmi/tests/sdui-kernel.test.ts` (both uncommitted).

Next, after those land: the renderer wiring (`src/sdui/Renderer.tsx`, `actions.ts`, `state.ts`), the server's screen checker
(`TAILZU-BACKEND/shared/types/sdui.ts`, `tulmi/src/experience/sdui2/**`, `tulmi/src/routes/app/**`) and the desktop copy
(`TAILZU-DESKTOP/src/app/sdui/v2/**`, `nodes.js`, `core.js`).

## Numbers in use

- Migrations: 0087 lingo, 0088 native looks, 0089 lingo sentences, 0090 bot health days. Take the next free number and
  check `git log origin/main -- tulmi/supabase/migrations` first: two sessions have collided twice today.
- Phone runtime: `tailzu-2026-11-x0-blip`. Do not change it.

## Notes from other sessions

(none yet)
