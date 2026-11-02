# Toadstool Kingdoms

An original cartoon-fantasy base-building game: grow a woodland village around your Elder Toadstool, gather Acorns and Dew, and (in later phases) raid and defend.

**Play it:** https://jimhavlicekpersonal.github.io/toadstool-kingdoms/ (live once GitHub Pages is turned on; see below)

The same build runs on Windows, Android (Pixel) and iPhone. It is an installable web app (PWA): add it to your home screen or Start menu and it runs full screen and works offline.

## Play on your devices

| Device | How |
| --- | --- |
| **Windows 11** | Open the link in Edge or Chrome, then click the **Install** icon in the address bar (or **⋯ → Apps → Install this site as an app**). It gets a Start menu entry and its own window. |
| **Pixel 7** | Open the link in Chrome, then **⋮ → Add to Home screen → Install**. |
| **iPhone** | Open the link in **Safari**, tap **Share → Add to Home Screen**. Always launch from that icon: Safari can clear data for websites you don't visit often, but a home-screen app keeps its own storage. |

**Controls:** drag to pan; pinch (phone) or mouse wheel (laptop) to zoom; tap/click a building to select it; tap a bubble to collect. On a laptop, **Esc** cancels and **Enter** confirms placement.

**Moving a village between devices:** each device keeps its own village until the online server arrives in Phase 6. Open **Settings → Copy save code** on one device and **Load from code** on the other.

**Testing tools** (Settings): skip time forward 1 hour, or "Simulate 8 hours away" to check timers and offline progress. Turn on **Show frame rate** to check performance on your phone.

## Run the code on your laptop (Windows)

One-time setup: install **Node.js LTS** from https://nodejs.org and **Git** from https://git-scm.com.

```bash
git clone https://github.com/jimhavlicekpersonal/toadstool-kingdoms.git
cd toadstool-kingdoms
npm install
npm run dev
```

Open http://localhost:5173.

### Test the latest code on your phones over Wi-Fi

1. Phone and laptop on the same Wi-Fi (set the Wi-Fi to **Private** in Windows network settings).
2. On the laptop run `npm run dev:lan`. It prints a **Network** address like `http://192.168.1.23:5173`.
3. Type that address into Chrome (Pixel) or Safari (iPhone).
4. If Windows Firewall asks, click **Allow** for private networks.

Over plain Wi-Fi (http) the game plays in the browser but can't be installed as an app. Installing needs the https GitHub Pages link.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the game with live reload on this computer |
| `npm run dev:lan` | Same, reachable from phones on your Wi-Fi |
| `npm test` | Run the game-rules test suite |
| `npm run build` | Type-check and build the production version into `dist/` |
| `npm run preview:lan` | Serve the production build to your Wi-Fi |
| `npm run server:dev` | Build and run the PvP server locally (memory storage) |
| `npm run cap:android` / `npm run cap:ios` | Copy the web build into the native projects and open Android Studio / Xcode |

## Hosting (GitHub Pages)

Every push runs the tests and a build. Pushes to `main` also publish the game. One-time setup: in the repository on GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

## Project layout

```
src/sim/        Game rules: pure, deterministic TypeScript (no Phaser). Fully unit-tested.
src/data/       Every balance number (costs, times, production, storage, hall limits) as JSON.
src/game/       GameController: owns the live state, saving, offline catch-up.
src/persist/    IndexedDB save store (memory store in tests).
src/analytics/  Local analytics event log (viewable in Settings).
src/render/     Phaser scene, isometric math, placeholder art generated in code.
src/ui/         HTML/CSS interface (resource bar, panels, Build menu, settings).
src/pwa/        Service worker (offline) and its registration.
src/audio/      Synthesized sound effects and music.
src/payments/   PaymentProvider: mock (web), StoreKit (iOS), unavailable (Android for now).
src/platform/   Reminders, preferences and native (Capacitor) services.
src/online/     Client for the optional PvP server.
server/         Node + Fastify + Postgres PvP server (re-simulates every attack).
ios/, android/  Capacitor native projects.
docs/           Shipping guide (TestFlight, APK, server).
tests/          Vitest tests.
```

Placeholder art is drawn in code at startup. To use real art, load an image under the same texture key (for example `building.acorn_orchard`, or `building.acorn_orchard.3` for one level) and the generator skips it. Art convention: the building's footprint diamond spans the full image width and touches the bottom edge.

## Status

- **Phase 1 – Village core:** done. Grid placement and moving, collectors, storage, 2 builders, upgrade timers, save/load, offline progress.
- **Phase 2 – Raiding:** done. Burrow Barracks, Army Camps, 5 troops with researchable levels, 4 defenses, Bramble Hedges, generated opponents matched by leaf rank with a paid "Next", a fixed-step 10 tps battle with A* pathing, stars, loot and exact replays from seed + deployments.
- **Phase 3 – Defense and progression:** done. Bot raids against your real village while you are away, at fixed times on the clock (20% of storage up to a per-hall cap, 50% of collectors raidable), raiders matched by leaf rank with full armies, 12/14/16-hour shields after losing 30/60/90%+, a 24-hour new-player shield, defense log with replays, hidden traps from Elder Toadstool 3, leaf ranks with Sprout/Fern/Oak/Elder leagues, a league win bonus and a monthly chest, and Elder Toadstool 1–6 paced by a model-player test that fights real battles (hall 3 in ~65 minutes of play, hall 6 in ~14 days).
- **Phase 4 – Economy and monetization:** done. Moonstones (500 starter grant), skip and top-up prices from curves, a Store with Moonstone packs (the only screen with real prices), mock payments through a `PaymentProvider`, an age check with a monthly cap and extra confirmation for players under 18, Beaver Lodges 3–5 for Moonstones, rule-driven offers from `src/data/offers.json` (at most one per session), the Lantern Pass (free and premium tracks, premium = 20% faster builds), daily tasks and weekly challenges, Elder Toadstool looks, decorations, achievements and forest obstacles for free Moonstones, and a monthly spend summary in Settings.
- **Phase 5 – Social:** done. Join a Grove of 10–20 bot members with names, activity schedules and chat (always filtered); friends ask for troops and you donate for Grove XP, and when you ask, they fill your Grove Lodge with troops for your next battle; the weekly 2-day Grove Raid against a bot Grove (2 attacks each, best stars per base add up, shared reward chest paid once).
- **Phase 6 – Polish and ship:** done in code. Tutorial, original synthesized sound and music, particles and screen shake, reminders, Capacitor iOS and Android projects, a StoreKit 2 purchase plugin behind `PaymentProvider`, a Node + Fastify + Postgres server for real asynchronous PvP, an Android APK build on every push, and a manual TestFlight workflow. **The TestFlight build and sandbox purchase need your Apple Developer account. See [docs/SHIPPING.md](docs/SHIPPING.md).**

**Guardians and levels:** opponent bases defend themselves with guardian animals (Badger Wardens, Stoat Skirmishers, Hawk Sentinels) that rush out of a Guardian Burrow, and the six Elder Toadstool levels were rebuilt so each is harder than the last, checked with 100 simulated playthroughs. See [docs/DIFFICULTY.md](docs/DIFFICULTY.md); run `npm run sim:playthroughs` to repeat it.

**Daily play:** a free daily chest (exact odds shown before opening, never sold), a visit streak that never resets to zero, limited-time events on a fixed schedule with real countdowns, opt-in notifications with per-type switches, quiet hours and a daily cap, and honest "close call" notes after battles. See "Engagement features" in [CLAUDE.md](CLAUDE.md).

**Balance:** a balance pass fixed 20 game-theory and difficulty-curve problems (free opponent rerolls, trophies that only went up, attacks that always won, bot raids that got weaker as you grew, and more). The list, with the test that pins each fix, is in the "Balance pass" section of [CLAUDE.md](CLAUDE.md).

**Test store:** the web build uses a mock store. Purchases complete instantly and **no real money is charged**.

All names, characters, art and sounds are original.
