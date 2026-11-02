# Level difficulty: findings and rebuild

How hard each Elder Toadstool level is, measured by simulating 100 players and
looking at it geometrically (base layout), strategically (armies and plans) and
psychologically (time, losses, waiting).

Run it yourself: `npm run sim:playthroughs -- 100 <label>` (about 8 minutes on
4 cores). Reports land in `sim-results/<label>/`. `npm run sim:playthroughs --
compare <before> <after>` prints a side-by-side table.

## Method

- **100 simulated players** (`tools/playthroughs/run.ts`) play the real rules
  from a new village until 3 days past Elder Toadstool 6: real battles,
  trophy matchmaking, offline bot raids, guardians, daily chests and events.
  They differ in how often they play (2, 3, 4 or 6 sessions a day), army
  style (balanced, Hedgehog swarm, tanks, air), deploy plan (one side, two
  sides, all around), raids per session, how often they press Next, and
  whether they build defenses first.
- **Geometry** (`tools/playthroughs/geometry.ts`): 30 typical generated bases
  per level: defense coverage, hedges between the map edge and the hall,
  drop zone inside the base, defense damage per housing space of the army,
  and how long the army needs to knock everything down.
- **Battle difficulty** = 0.4 × raids lost + 0.3 × troops lost + 0.3 ×
  destruction missed (0 = trivial, 1 = hopeless).
- **Frustration** = 0.5 × share of sessions with nothing to do + 0.5 ×
  (longest loss streak / 5).

## Baseline (guardian animals added, levels not yet rebuilt)

All 100 players reached Elder Toadstool 6: median 16.2 days (p10 10.9, p90 26.7).

| Level | Battle difficulty | Raids won | 3★ | Troops lost | Opponent hall vs yours | Median time at level | Lost to raids | Nothing-to-do sessions |
|---|---|---|---|---|---|---|---|---|
| 1 | – (no raids) | – | – | – | – | 0.1 h | 0% | 50% |
| 2 | 0.180 | 99% | 78% | 55% | −1.0 | 1.2 h | 2% | 36% |
| 3 | 0.347 | 91% | 29% | 75% | −1.0 | 24 h | 16% | 14% |
| 4 | **0.355** | 85% | 50% | 76% | −1.0 | 124 h | 15% | 9% |
| 5 | 0.289 | 94% | 63% | 75% | −0.9 | **231 h** | 25% | 32% |
| 6 | 0.282 | 94% | 67% | 73% | −0.9 | – | 28% | 32% |

**Order of difficulty found:** 2 < 6 < 5 < 3 < 4. Levels 3 and 4 form a hump,
and the last two levels are easier to fight than the middle ones.

## Findings

### Geometric

1. **Hedges don't wall anything.** 43–83% of each hedge ring is open, and the
   cheapest route from the map edge to the Elder Toadstool crosses 0–0.3
   hedges at every level. Outer buildings were placed first and sat on the
   ring line, and the rings (80–100 tiles around) were bigger than the hedge
   allowance.
2. **Troops can land inside bases.** 15–57% of a base's interior is a legal
   drop zone, so a player can skip the walls entirely.
3. **The timer stops mattering.** A full army needs 42 s to knock down a
   level 1 base but only 16 s at level 6: army damage grows faster than
   building health. This is a big reason levels 5–6 play easier than 3–4.
4. **Defense pressure zig-zags.** Defense damage per housing space of the
   attacking army goes 2.0, 3.4, 2.3, 3.0, 2.7, 3.4: levels 3 and 5 double or
   grow the army without matching defenses.
5. **Air is under-covered late.** Air coverage jumps at level 4 (16% → 40%)
   and then stays flat (40–48%) while air armies keep growing.
6. **Guardians are flat early.** Opponents at levels 2 and 3 field the same
   single guardian.

### Strategic

7. **Everyone fights a level below.** Opponents are one hall lower at every
   level (−0.9 to −1.0). Trophies lag the hall (median 676 at the end of
   level 4, a level 2 strength), so matchmaking sits at its floor. Each level
   is really the previous level's bases, with a 20% loot penalty.
8. **Air and tanks dominate late; swarms struggle.** At levels 4–6, air and
   tank armies win 93–99% of raids; Hedgehog swarms win 67% at level 4 and 84%
   at 5–6 (splash defenses and traps).
9. **Spreading out beats one side.** At level 4, deploying all around wins 97%
   of raids against 75% from one side, and one-side players spend 153 h at
   level 4 against 113 h.
10. **Guardians barely matter.** They cause 0–1% of troop losses and 94–98% of
    them are defeated; troops simply gang up on them.
11. **Levels 3–4 are an economic squeeze.** Loot per Dew spent on the army is
    lowest there (2.8 and 2.3, against 4.7 at level 2 and 3.7 at level 6),
    exactly where battles are hardest.

### Psychological

12. **The level 5 wall.** Median 9.6 days at level 5 (p90 14 days), with a
    median 12 h (p90 19 h) between upgrades and 32% of sessions with nothing
    to do while saving for the 850k Elder Toadstool.
13. **The level 3 → 4 cliff.** Time at level jumps 5× (24 h → 124 h), the
    biggest step in the game, right where battles are hardest.
14. **Raids hurt most at the top, and most for casual players.** 25–28% of
    income is lost to raids at levels 5–6 (77–79% destruction). Players with
    2 sessions a day lose 35% at level 5 against 17% for 6 a day.
15. **Early waiting.** 50% of level 1 sessions and 36% of level 2 sessions
    have nothing to do; builders sit idle 63–100% of the time.
16. **Losing streaks cluster at level 4** (p90 3 in a row), the first place
    players meet repeated defeats.
17. **Play frequency decides everything.** 11 days to level 6 at 6 sessions a
    day, 25.7 days at 2 a day.

## Rebuild targets (set before the rebuild)

- Battle difficulty rises with every level (2 < 3 < 4 < 5 < 6), in small steps.
- Opponents come from your own level (average within −0.3 of your hall).
- Time at level grows smoothly; no level more than 3× the one before it from
  level 3 on; median to level 6 around two weeks.
- No more than 20% of income lost to raids at any level.
- Guardians cause a small but rising share of troop losses.
- No army style below 75% raids won at levels 3–6.

## What was rebuilt

| Finding | Change |
|---|---|
| 1, 2 Hedges don't wall; troops land inside | Troops land only on open ground reachable from the map edge (`createBattle`). Generated bases place their core first, then a hedge ring (`baseLayoutByHall`: 3/3/2/1/1/0 two-tile gaps, inner ring around the Elder Toadstool at levels 5–6), then collectors and Beaver Lodges outside it. Hedge allowances 20/36/100/115/145/165. |
| 4, 5 Defense pressure zig-zags; air under-covered | Per-level defense counts and caps retuned (hall.json). Firefly Tower from level 3, more at 4–6. Catapult and Firefly damage curves smoothed. Thorn Snare and catapult splash radius trimmed. Building HP grows with the level that unlocks it (+6% / +20% / +42% for levels 4 / 5 / 6). |
| 6, 10 Guardians flat and irrelevant | Guardian curve steepened to 0 / 5 / 10 / 14 / 19 / 22% of a matched army's strength. A sixth guardian level. Burrow contents fitted to the curve. |
| 7, 11 Everyone fights a level below; level 3–4 squeeze | Matchmaking floor from army strength: opponents come from the level your army actually matches (camps × research, `powerStrength`), never more than 1.5 levels under yours, and trophies push them up from there. Generated loot at levels 3–5 raised so loot per Dew is flat. |
| 13 Level 3 → 4 cliff; research lag | Troop research has a sixth level and the cap rises at every hall (1–6). Early research is cheaper and quicker. Elder Toadstool 5 costs 100k (was 130k), Elder Toadstool 6 750k (was 850k). |
| 14 Raids hurt most at the top | Storage loot cap at levels 5–6 lowered to 45k / 90k per resource. |
| 8 Air and tanks dominate, swarms struggle | Same defense retune; the level probe checks all four army styles and three deploy plans. |

## Results after the rebuild

All numbers from the same 100 player profiles.

| Level | Battle difficulty | Raids won | Troops lost | Median hours at level | Lost to raids | Nothing-to-do sessions | Frustration |
|---|---|---|---|---|---|---|---|
| 2 | 0.180 → 0.185 | 99% → 100% | 55% → 55% | 1.2 → 1.2 | 2% → 2% | 36% → 34% | 0.183 → 0.172 |
| 3 | 0.347 → **0.187** | 91% → 99% | 75% → 54% | 24 → 25 | 16% → 18% | 14% → 19% | 0.114 → 0.101 |
| 4 | 0.355 → **0.257** | 85% → 95% | 76% → 65% | 124 → 96 | 15% → 14% | 9% → 5% | 0.183 → 0.075 |
| 5 | 0.289 → **0.272** | 94% → 95% | 75% → 70% | 231 → 209 | 25% → 20% | 32% → 30% | 0.235 → 0.220 |
| 6 | 0.282 → **0.319** | 94% → 93% | 73% → 80% | – | 28% → 24% | 32% → 32% | 0.207 → 0.207 |

- **Order of difficulty is now 2 < 3 < 4 < 5 < 6** (was 2 < 6 < 5 < 3 < 4).
  `tests/balance/combat.test.ts` also checks the order in matched
  same-level fights (every army style, 1/2/4-side deploys).
- **Time to Elder Toadstool 6**: median 13.7 days (was 16.2); p10 9.2, p90 21.8
  (was 10.9 / 26.7). By play frequency, 2 / 3 / 4 / 6 sessions a day take
  18.5 / 14.2 / 11.2 / 9.7 days (was 25.7 / 18.2 / 14.2 / 11.0).
- **Losing streaks** at level 4: p90 3 → 1. The longest wait between upgrades
  at level 5 drops from p90 19 h to 14 h.
- **Walls**: from level 3 the drop zone never reaches inside the ring
  (25–57% of base interiors before), and rings are 0–4% open from level 3.
  Gaps are deliberate 2-tile openings that troops can walk through, so the
  cheapest route still crosses no hedges on levels 1–5 and about one on
  level 6. Hedges now funnel more than they block.
- **Strategy**: at levels 4–6 the weakest army style wins 88–90% of raids
  (swarms, were 67–84%) and one-side deploys win 88–91% (were 75–90%).
- **Loot per Dew** at levels 3–6: 2.4 / 3.4 / 4.4 / 4.0 (was 2.8 / 2.3 /
  3.3 / 3.7).

## What is still open

- **Players who play twice a day and build defenses first got slower**: they
  reach level 6 in 30.5–35.7 days (25.7–29.7 before), because the rebuilt
  levels 5 and 6 have more defenses for them to buy. Every other profile got
  faster.
- **Level 5 is still the long one** (median 8.7 days, 30% of sessions with
  nothing to do while saving). With about two weeks to level 6 and each level
  taking 2–4× the one before, the last level is inevitably the longest.
  Shorter only comes with a faster game overall.
- **Levels 2 and 3 are close** (0.185 vs 0.187): both are introductory, and
  weak level-3 armies are matched with weaker bases.
- **Guardians are still a small factor in real play** (0–3% of troop losses;
  up to 9% in matched level-6 fights). Players meet bases matched to their
  army, whose burrows are a level or two lower, and troops gang up on them.
- **Raids still take 24% of income at level 6** (target 20%).
- **The ideal clear time still shrinks** (42 s at level 1 to 17 s at level 6
  if nothing fought back). Actual destruction now falls with every level
  (94% → 83%) thanks to walls and defenses, which is what players feel.
- **Measurement note**: the geometry tool's "inside the walls" was refined
  during the rebuild (before: outline of all buildings; after: the hedge
  ring), so compare those columns with care.
- **Simulated players are not people.** They use fixed habits and simple
  deploy plans; a playtest will still surprise us.
