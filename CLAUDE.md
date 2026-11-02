# Toadstool Kingdoms – project instructions

## Device targets (added by the owner after the original spec)

The game must be easy to download and run on:

- a **Windows 11 laptop** (mouse, keyboard, trackpad),
- a **Google Pixel 7** (Android, Chrome),
- an **Apple iPhone 17** (iOS, Safari).

How this is met:

- **Phases 1–5:** the game ships as an installable web app (PWA) hosted on **GitHub Pages** at
  https://jimhavlicekpersonal.github.io/toadstool-kingdoms/, deployed by `.github/workflows/deploy.yml` on every push to `main`.
  The Vite build uses `base: './'` so the same build works on Pages, any static host and later inside Capacitor.
  A hand-written service worker (`src/pwa/sw.template.js`, emitted by a small plugin in `vite.config.ts`) makes it work offline.
- **Local testing:** `npm run dev` on the laptop; `npm run dev:lan` exposes it to phones on the same Wi-Fi.
- **Controls:** touch first (drag to pan, pinch to zoom, tap), plus mouse wheel zoom, click, Esc/Enter on the laptop.
  The layout respects iPhone safe areas (Dynamic Island, home bar) and works in portrait and landscape.
- **Saves are per device** until the Phase 6 backend. Settings has Copy save code / Load from code to move a village between devices.
- **Testing on device without dev tools:** Settings has an FPS display, time-skip tools ("+1 hour", "Simulate 8 hours away") and an analytics event viewer.
- **Phase 6:** Capacitor for **both iOS and Android**. iOS builds need a Mac or a cloud macOS build (e.g. GitHub Actions macOS runners or Codemagic) plus the Apple Developer Program for TestFlight and StoreKit sandbox. Ask the owner whether to add Google Play Billing behind `PaymentProvider` for Android.
- Keep npm scripts cross-platform (Windows): no bash-only syntax in `package.json`. `.gitattributes` normalises line endings.

## Decisions made during Phases 2-6

- Art direction (owner request): smoother, softer, Nintendo-like look. All art is still generated in code (`src/render/art/`).
- Save format is versioned (`src/sim/save.ts`, currently v10) with a migration step per version. Bump `SAVE_VERSION` and add a step for every state change. (v7 and v10 dropped stored replays because battle rules changed; v8 added the daily chest and streak; v9 added `net`, the online bookkeeping.)
- Progression pacing is checked by a model-player test (`tests/balance/`) that fights every raid as a real battle through matchmaking and `battleEnd` (no assumed loot share). Rerun it after changing costs, times, loot or combat numbers. `tests/balance/combat.test.ts` and `curves.test.ts` pin the attack/defense balance and the curve shapes.
- Offers have a `minAccountHours` field so brand-new players are not shown the builder offer in their first minutes.
- Real prices appear only in the Store and its confirm step (pass and offer popups link to the Store).
- Phase 6: Capacitor 8 (iOS + Android). iOS purchases use a local StoreKit 2 plugin (`ios/App/App/TkStorePlugin.swift`, registered in `TkViewController.swift`). **Android purchases are disabled** (`UnavailablePaymentProvider`) until Google Play Billing is added; ask the owner before adding it.
- PvP server: Fastify 5 + `pg`, bundled with Vite (`vite.server.config.ts`). Online play turns on when the build has `VITE_SERVER_URL`, or when a server address is entered in Settings → Online play (stored in localStorage under `tk.net.server`; the value `off` forces offline). With a server, real raids replace bot raids and a real Grove replaces the bot Grove. The village economy stays on the device.
- The owner-only steps (Apple account, App Store Connect products, secrets, server hosting) are in `docs/SHIPPING.md`.

## Multiplayer (ports and adapters)

Everything multiplayer follows the game-theory rules above. The protocol is described in `docs/PROTOCOL.md`.

- **Protocol:** `src/net/protocol.ts` holds the routes, request and response types, error codes and `PROTOCOL_VERSION` (currently 2). Bump the version for any change that would break older clients, and update `docs/PROTOCOL.md` and the contract tests with it.
- **Client ports:**
  - `src/net/ports.ts` defines `ServerPort`. Adapters: `HttpServerAdapter` (`src/net/httpAdapter.ts`) and `InProcessServerAdapter` (`server/inProcess.ts`, for tests).
  - `src/net/connection.ts` is the connection manager. It handles status, registration and base upload. Server results enter the village only through idempotent commands (`applyDefense`, `receiveDonations`, `claimRaidChest`, `spendDonation`, `remoteGroveBattleEnd`, `leaveLocalGrove`), deduplicated by `state.net` (save v9). Battle reports go through a persisted outbox.
- **Grove screen:** `src/game/groveSource.ts` defines `GroveSource`, with `LocalGroveSource` (bot Grove) and `RemoteGroveSource` (server). `GroveUi` renders only the snapshot.
- **Server:**
  - `server/core/` holds every rule and knows nothing about HTTP or databases. It sees the outside world through `ServerContext` (`server/core/context.ts`) and the `Repo` storage port (`server/repo.ts`, adapters `MemoryRepo` and `PgRepo`).
  - `server/app.ts` is a thin Fastify adapter. `server/schema.sql` is idempotent and upgrades older databases in place.
  - Online, the server applies the loot penalty in the match ticket. The client must not apply it again.
- **Grove Raid rules:**
  - Only members who joined before the raid started take part.
  - A claim is allowed once per player per week. `RaidView.chests` tells the client which weeks to claim.
- **Tests:**
  - `tests/server/core.test.ts` and `tests/server/repo.test.ts` run on memory, and also on Postgres when `TEST_DATABASE_URL` is set. CI does this with a Postgres service.
  - `tests/contract/` checks any server URL: `CONTRACT_URL=… npm run test:contract`. Without the variable it starts our server.
  - `tests/net/` and `tests/game/groveSource.test.ts` cover the client side.

## Balance pass (20 fixes)

A review against how this genre is usually balanced found 20 game-theory holes and curve problems. Each fix has a test:

| # | Problem | Fix | Test |
|---|---|---|---|
| 1 | Home + Attack rerolled opponents for free | The scouted opponent is kept (`state.scout`) until it is attacked or Next is paid | `tests/sim/matchmaking.test.ts` |
| 2 | Next fee shrank to <1% of loot | `scoutFeeByHall` is ~3% of a hall's average loot | same |
| 3 | Trophies didn't affect opponents | `src/sim/matchmaking.ts`: strength = trophies / `trophiesPerHall`; it sets the opponent's hall, building levels and loot. Since the level rebuild, a floor from the player's army strength also applies (see below) | same |
| 4 | Trophies only went up | Opponents' trophies follow their strength, so running ahead of your hall makes wins pay less and losses cost more; win 24 / loss 20 at parity | same |
| 5 | Attacks ~100% / 3★ at every hall | Defense damage ×4.5, defense HP ×3, other buildings and hedges ×1.5; full army at matched strength now does ~55-75% | `tests/balance/combat.test.ts` |
| 6 | Balance test assumed 55% loot | Model player fights real battles | `tests/balance/progression.test.ts` |
| 7 | Hedgehog best at everything | Re-tuned troop stats; no troop dominates another; mixed armies beat Hedgehog-only | `combat.test.ts`, `curves.test.ts` |
| 8 | Bot raiders got weaker as you grew | Raiders are matched by your trophies and bring a full army at their hall's research cap (`attackerFor`) | `tests/sim/raids.test.ts` |
| 9 | Checking in every 29 min avoided all raids | Raids sit at fixed per-hour slots on the clock (`raidTimes`); only time with the game open (plus a 2 min grace) or shielded is safe | same |
| 10 | Tasks counted started work (train/upgrade then cancel) | `troopsTrained` and new `upgradesDone` count finished work | `tests/sim/research.test.ts` |
| 11 | Donating swapped cheap troops for expensive ones | Donating gives XP only; gifts are only troops your Barracks has unlocked | `tests/social/social.test.ts` |
| 12 | Raid profit per Dew grew 1.3x → 9.6x | Troop training cost rises with level; ratio stays ~2-4.5x | `curves.test.ts` |
| 13 | Troops had no levels | Troop research in the Burrow Barracks (`src/sim/research.ts`), capped by `troopLevelCap` in hall.json | `research.test.ts` |
| 14 | Hall timer jumped 36x at hall 4 | Hall times grow ~2.7x per level (hall 10 would be ~7 days) | `curves.test.ts` |
| 15 | Hall cost multipliers shrank | 1k → 4k → 20k → 100k → 750k (x4, 5, 5, 7.5); the hall stores little | same |
| 16 | Collector payback went up and down | Paybacks rise every level and stay under a week | same |
| 17 | No cap on loot from storage; no penalty for hitting lower halls | `storageLootCapByHall`; `lootPenaltyByHallDiff` (client, bots and server) | `raids.test.ts`, `matchmaking.test.ts` |
| 18 | Shield always 12 h | 12/14/16 h at 30/60/90% (`shieldTiers`) | `raids.test.ts` |
| 19 | Grove/league rewards flat across halls | Resources scaled by `rewardScaleByHall` (Moonstones not scaled) | `curves.test.ts` |
| 20 | Buying a hall level was cheap | Steeper skip and top-up curves; rushing hall 5→6 costs >3x the starting Moonstones | `curves.test.ts`, `economy.test.ts` |

Numbers in the spec below that these replaced (skip/top-up curve points, 0-3 raids per absence, 12-hour shield) are superseded by the data files.

## Engagement features (and their limits)

Built to bring players back for good reasons, within App Store rules, FTC guidance and loot-box laws. Keep these rules when changing them:

- **Daily chest** (`src/sim/daily.ts`, `src/data/daily.json`): free, one per UTC day, contents drawn from a weighted table whose exact odds are shown before opening. The draw comes from the village seed + day, so reloading can't reroll it. It is never sold: no Moonstone or real-money way to open, reopen or reroll it. If a paid random item is ever added, its odds must be shown before purchase (App Review Guideline 3.1.1) and the loot-box laws in each target market checked first.
- **Streak**: one step per day on a 7-step ladder of bigger chests. A missed day never wipes it: a free weekly skip covers one day, otherwise you move back one step per missed day. Skips and streak repairs are never sold.
- **Limited-time events** (`src/sim/events.ts`, `src/data/events.json`): a fixed schedule repeating every 14 days. Start and end times come only from the schedule; nothing resets or extends them, so every countdown is real. Offers keep their deadline too (tested).
- **Notifications** (`planNotifications` in `src/sim/reminders.ts`, `src/data/notifications.json`): off until the player turns them on; each type can be switched off; none in quiet hours (they wait until morning); at most `maxPerDay` per local day.
- **Close calls** (`src/sim/battle/closecall.ts`): "so close" notes after an attack, read from the finished battle and shown only when true. No rigged or faked near-misses, and no "almost" animations on random rewards: a chest only shows what it gave.
- The model player opens the chest daily and plays through events, so pacing (`tests/balance/progression.test.ts`) includes this income.

## Guardian animals and the level rebuild

- **Guardian animals** (`src/data/guardians.json`, `guardian_burrow` in buildings.json): Badger Warden, Stoat Skirmisher and Hawk Sentinel come out of a base's Guardian Burrow when raiders get close (all at once if it falls), chase raiders near the burrow and walk back. In the battle sim they are units with `side: 'guard'` in `sim.troops`. Defenses, traps and splash only hit attackers. Attacking troops fight guardians in reach, except troops that go for defenses (Beetle Brutes, Owl Bombers), and only ranged troops can hit hawks. Their strength follows `strengthShareByHall` (share of a matched army's strength), checked by `tests/battle/guardians.test.ts`.
- **Levels in order of difficulty** (`docs/DIFFICULTY.md`): a 100-player simulation found levels 3–4 harder than 5–6, hedges that didn't wall anything, troops landing inside bases, and everyone fighting a level below. The rebuild:
  - **Drop zone:** troops land only on open ground reachable from the map edge.
  - **Base layout:** generated bases place their core first, then a closed hedge ring (`baseLayoutByHall`: gaps, inner ring), then collectors and huts outside it.
  - **Troop research:** a sixth troop level, so the research cap rises at every level.
  - **Defenses:** per-level counts and levels retuned; building HP grows with the level that unlocks it.
  - **Matchmaking:** opponents now have a floor at the level the player's army actually matches (`powerStrength`, up to `hallsBelow` levels down), and trophies push them up from there.
  - **Guardians:** a steeper strength curve.
  - `tests/balance/combat.test.ts` checks that each level is harder than the last.
- **Playthrough simulator** (`tools/playthroughs/`, `npm run sim:playthroughs -- 100 <label>`): 100 varied model players, per-level battle/time/raid/frustration metrics, base geometry, and a `compare` mode. Bundled with Vite like the server; results go to `sim-results/` (git-ignored). Rerun it after changing levels or combat numbers.

## Stack decisions made during Phase 1

- Phaser **3.90** (spec says Phaser 3; Phaser 4 exists but was not adopted).
- Vite **8** and Vitest **5** (Vite 7 + Vitest 4 hit an npm peer-dependency resolution bug).
- TypeScript 5.9. No other runtime dependencies. The HUD is plain DOM + CSS (no UI framework).

---

## Original specification

### Goal

Build Toadstool Kingdoms, an original cartoon-fantasy base-building and raiding game, from scratch. It plays like Clash of Clans: build a village, collect resources, train troops, raid other bases, defend your own, join an alliance. Use only original names, art and audio. Never use any Clash of Clans or Supercell name, character, image or sound.

### Tech stack

- TypeScript, Vite, Phaser 3 for the isometric 2.5D view.
- Vitest for unit tests.
- Persistence: IndexedDB through a small wrapper (Phases 1 to 5); a Node + Fastify + Postgres backend only in Phase 6.
- Art: generate placeholder sprites in code (rounded shapes, flat colors, simple faces) so the game is playable with zero external assets. Keep every sprite behind an asset key so real art can be swapped in later.
- Mobile-first layout, touch controls, 60 fps target on a mid-range phone browser.

### Architecture rules

1. `src/sim/` holds all game rules as pure, deterministic functions with no Phaser imports. Rendering only reads sim state and sends commands.
2. `src/data/*.json` holds every balance number: costs, build times, HP, damage, unlock levels. No magic numbers in code.
3. Time comes from an injected `Clock` interface. Timers store `startedAt` and `endsAt` timestamps; never count down in a loop. Tests fast-forward the clock.
4. Offline progress is computed on load from elapsed time: collector output, finished upgrades, simulated raids against the player.
5. Battles run on a fixed-step simulation (10 ticks per second) seeded by an RNG, so a battle can be replayed exactly from `seed + deployments`.
6. Payments go through a `PaymentProvider` interface. Ship `MockPaymentProvider` (instant success, logs the sale) until Phase 6.
7. Log analytics events (`session_start`, `upgrade_start`, `skip_used`, `raid_end`, `offer_shown`, `purchase`) to a local event store with a debug viewer.

### Core systems and starting numbers

Treat every number below as a starting value to tune in playtests.

- Map: 40 x 40 tile grid. Buildings occupy 2 x 2 to 4 x 4 tiles. Bramble hedges are 1 x 1.
- Resources: Acorns and Dew (soft), Nightsap (soft, Elder Toadstool 7+), Moonstones (premium).
- Collectors: produce per hour by level; each holds 8 hours of output, then stops. Tapping collects into storage.
- Storage: caps how much the player can hold; 20% of stored and 50% of uncollected resources are raidable.
- Builders: start with 2 Beaver Builders; huts 3, 4 and 5 cost 250, 500 and 1,000 Moonstones.
- Upgrade times: level 1 takes 10 seconds; each level multiplies time by about 2.2, reaching roughly 7 days at the top of Elder Toadstool 10.
- Elder Toadstool gating: each hall level unlocks new buildings, building level caps and troop types. Show the next level's unlocks in a preview panel at all times.
- Skip cost (Moonstones): linear interpolation through 1 minute = 1, 1 hour = 20, 1 day = 260, 1 week = 1,000.
- Resource top-up cost (Moonstones): linear interpolation through 100 = 1, 1,000 = 5, 10,000 = 25, 100,000 = 125, 1,000,000 = 600.
- Troops: Hedgehog Roller (melee, nearest target), Frog Lobber (ranged), Beetle Brute (tank, targets defenses), Owl Bomber (air, targets defenses), Mole Digger (burrows under hedges). Trained in the Burrow Barracks, housed in Army Camps with a housing cap.
- Defenses: Acorn Cannon (ground), Pinecone Catapult (splash, slow), Wasp Nest (air and ground), Firefly Tower (air). Hidden traps unlock at hall 3.
- Battle: 3-minute timer; troops path with A* around hedges and break them when blocked. Stars: 1 for 50% destruction, 1 for the Elder Toadstool, 1 for 100%. Loot scales with destruction.
- Scouting: opponents are generated bases matched to the player's leaf rank, each with randomized loot. Pressing Next costs a small Acorn fee and rerolls.
- Being raided: while offline, simulate 0 to 3 bot raids against the real base layout. On return, show a defense log with replays. Losing 30% or more grants a 12-hour shield.
- Leaf ranks: trophies won and lost per raid; leagues Sprout, Fern, Oak, Elder; monthly reset with a reward chest by league.

### Monetization systems

- Store screen: Moonstone packs at $1.99 / $4.99 / $9.99 / $19.99 / $49.99 / $99.99, with Moonstones per dollar rising with pack size. Real prices appear only on this screen.
- Tutorial grant: 500 Moonstones; the tutorial makes the player finish two timers instantly with them.
- Lantern Pass: a 30-day season with a free track and a premium track ($4.99). Premium gives 20% faster builds, a hero skin and extra rewards. Points come from daily tasks (3 per day) and weekly challenges.
- Offers engine: rule-driven offers with a 24 to 72 hour timer, shown at most once per session. Starter rules: first-purchase pack after the first wait over 1 hour; builder pack when all builders are busy; war-prep pack 24 hours before a Grove Raid; resource pack after a heavy defense loss.
- Cosmetics: hero skins and village scenery sold for Moonstones; purely visual.
- Free Moonstones: achievements, clearing forest obstacles, and pass milestones, so a free player always earns some.
- Every offer reads its rule, price and timer from `src/data/offers.json`, so it can be changed without code.

### Social systems

- Groves (alliances): in Phases 1 to 5, the player joins a Grove of 10 to 20 bot members with names, chat lines and activity schedules.
- Donations: members request troops; donating gives XP and fills the player's own reinforcement slot.
- Grove Raid: a weekly 2-day event against a bot Grove. Each member gets 2 attacks; total stars decide the winner and a shared reward chest.

### Build phases

Finish, test and run each phase before starting the next. Commit at the end of each.

1. **Village core.** Grid, placement and moving, 6 building types, collectors, storage, 2 builders, upgrade timers, save and load, offline progress.
   - Done when: timers and collectors survive a reload and a simulated 8-hour absence; sim tests pass.
2. **Raiding.** Barracks, Army Camps, troop training, generated opponent bases, battle sim with pathing, stars, loot, replays.
   - Done when: a 3-minute raid runs at 60 fps on a phone browser and replays identically from its seed.
3. **Defense and progression.** Offline raids against the player, shields, defense log, leaf ranks, Elder Toadstool levels 1 to 6.
   - Done when: a new player can reach hall 3 in about 1 hour of play, and hall 6 takes about 2 weeks of normal play.
4. **Economy and monetization.** Moonstones, skip and top-up, store with mock payments, builder huts, offers engine, Lantern Pass, daily tasks, cosmetics.
   - Done when: every purchase path works end to end with the mock provider and is logged in analytics.
5. **Social.** Groves with bot members, chat, donations, weekly Grove Raid.
   - Done when: a full Grove Raid week can be fast-forwarded in a test and pays out correctly.
6. **Polish and ship.** Tutorial, sound, particles and screen shake, push reminders, Capacitor wrap for iOS, StoreKit through the `PaymentProvider` interface, backend for real asynchronous PvP.
   - Done when: a TestFlight build installs and a sandbox purchase completes.

### Working rules for Claude Code

- Plan each phase in a short checklist before writing code.
- Write sim tests first for timers, costs, loot and battle outcomes.
- Run `npm test` and `npm run dev` at the end of each phase and fix what breaks.
- Ask before adding a new dependency or changing the stack.

### Guardrails

The mechanics above are standard, but a few lines are legal or reputational risks, so build them in from day one.

- Original IP only. Game mechanics can be borrowed; names, characters, art, sounds and UI layouts copied from Clash of Clans cannot.
- Randomized paid items. If you ever sell chests or loot boxes, Apple's App Review Guidelines (section 3.1.1) require disclosing the odds before purchase.
- Dark patterns. The FTC's Epic Games settlement included $245 million in refunds over purchase flows that tricked players into buying. Keep a clear confirm step on every purchase and never place buy buttons where a stray tap lands.
- Minors. Add a spending cap and purchase confirmation for players who indicate they are under 18, and keep chat filtered.
- Healthy play. Optional: a session reminder after 60 minutes and a monthly spend summary. These cost little and build trust with the players who spend most.
