import type Phaser from 'phaser';
import { BattleSession } from './game/battleSession';
import type { GameController } from './game/controller';
import type { GroveSource, RaidBattle } from './game/groveSource';
import type { Connection } from './net/connection';
import type { BattleSceneInit } from './render/BattleScene';
import type { BaseLayout, BattleRecord, BattleSetup } from './sim/battle/types';
import { opponentFor } from './sim/matchmaking';
import { troopLevels } from './sim/research';
import { mixSeed } from './sim/rng';
import { battleArmy, scoutFee } from './sim/village';
import { BattleHud } from './ui/battleHud';
import { sound } from './audio/sound';
import type { Hud } from './ui/hud';

export interface AppDeps {
  game: Phaser.Game;
  controller: GameController;
  hud: Hud;
  hudRoot: HTMLElement;
  battleRoot: HTMLElement;
  renderScale: number;
  troopThumb(type: string): string | null;
  /** Online play: real opponents and real Grove Raids when connected. */
  connection: Connection;
  groveSource: GroveSource;
}

/** Leave this much of a ticket's lifetime for the 3-minute battle itself. */
const TICKET_MARGIN_MS = 5 * 60_000;

/** Switches between the village and battles (scouting, live attacks, replays). */
export class App {
  private battleHud: BattleHud | null = null;
  private session: BattleSession | null = null;

  constructor(private readonly d: AppDeps) {}

  get inBattle(): boolean {
    return this.session !== null;
  }

  private ticket: string | null = null;
  /** The online opponent behind the current scout seed, kept so Home + Attack shows the same base. */
  private onlineMatch: { seed: number; ticket: string; base: BaseLayout; expiresAt: number } | null = null;

  /** Look for an opponent. `paid` = pressing Next. */
  async scout(paid = false): Promise<void> {
    const c = this.d.controller;
    const r = c.scout(paid);
    if (!r.ok) {
      if (this.battleHud) this.battleHud.toast(r.message);
      else this.d.hud.toast(r.message, 'error');
      return;
    }
    this.ticket = null;
    const army = battleArmy(c.state);
    const levels = troopLevels(c.state, c.data);
    const conn = this.d.connection;
    // Online: the server picks the opponent (a real village, or a generated
    // one when nobody fits) with the same matchmaking rules, and has already
    // applied the loot penalty to it.
    if (conn.online && conn.port) {
      try {
        // Same scout seed as last time (Home, then Attack): show the same base
        // while its ticket is still valid, so leaving never rerolls for free.
        const kept = this.onlineMatch && this.onlineMatch.seed === r.seed && Date.now() < this.onlineMatch.expiresAt - TICKET_MARGIN_MS ? this.onlineMatch : null;
        const m = kept ?? (await conn.port.match());
        if (m) {
          this.onlineMatch = kept ?? { seed: r.seed, ticket: m.ticket, base: m.base, expiresAt: m.expiresAt };
          this.ticket = this.onlineMatch.ticket;
          const setup: BattleSetup = { seed: mixSeed(r.seed, 0xba771e), base: structuredClone(this.onlineMatch.base), army, levels };
          this.open(new BattleSession(setup, c.data, 'scout'));
          return;
        }
      } catch (e) {
        console.warn('Online match failed, using a generated opponent', e);
      }
    }
    // Opponent strength and loot follow the player's trophies (see sim/matchmaking).
    const base = opponentFor(r.seed, c.state, c.data);
    const setup: BattleSetup = { seed: mixSeed(r.seed, 0xba771e), base, army, levels };
    this.open(new BattleSession(setup, c.data, 'scout'));
  }

  /** Attack an enemy base in the Grove Raid (no loot or trophies). */
  async groveAttack(target: number): Promise<void> {
    const battle = await this.d.groveSource.raidBattle(target);
    if ('error' in battle) {
      this.d.hud.toast(battle.error, 'error');
      return;
    }
    this.open(new BattleSession(battle.setup, this.d.controller.data, 'scout'), undefined, battle);
  }

  replay(record: BattleRecord): void {
    this.open(new BattleSession(record.setup, this.d.controller.data, 'replay', record), record);
  }

  home(): void {
    this.battleHud?.destroy();
    this.battleHud = null;
    this.session = null;
    const sm = this.d.game.scene;
    if (sm.isActive('battle') || sm.isPaused('battle')) sm.stop('battle');
    if (sm.isSleeping('village')) sm.wake('village');
    this.d.hudRoot.hidden = false;
    sound.music('village');
  }

  private open(session: BattleSession, replayOf?: BattleRecord, grove?: RaidBattle): void {
    const c = this.d.controller;
    this.battleHud?.destroy();
    this.session = session;
    let lastRecord: BattleRecord | null = null;
    this.battleHud = new BattleHud({
      root: this.d.battleRoot,
      session,
      myTrophies: c.state.trophies,
      replayOf: replayOf ? { kind: replayOf.kind, opponentName: replayOf.opponentName } : undefined,
      grove: grove ? { enemyName: grove.enemyName } : undefined,
      troopThumb: this.d.troopThumb,
      scoutFee: scoutFee(c.state, c.data),
      canPayFee: () => c.state.resources.acorns >= scoutFee(c.state, c.data),
      onHome: () => this.home(),
      onNext: () => this.scout(true),
      onAttack: () => session.start(),
      onFinished: () => {
        if (grove) {
          const g = grove.finish(session.deployments, session.endTick);
          if (!g) return null;
          return { result: session.result(), banked: {}, trophies: 0 };
        }
        const out = c.finishBattle(session.setup, session.deployments, session.endTick, session.setup.base.name);
        if (!out) return null;
        if (this.ticket) {
          // The server re-runs the battle from seed + deployments; the outbox
          // keeps the report until it gets through.
          const ticket = this.ticket;
          this.ticket = null;
          this.onlineMatch = null;
          void this.d.connection.report('attack', { ticket, seed: session.setup.seed, army: session.setup.army, levels: session.setup.levels, deployments: session.deployments, endTick: session.endTick });
        }
        lastRecord = out.record;
        return { result: out.record.result, banked: out.banked, trophies: out.record.trophies ?? 0, bonus: out.record.leagueBonus, eventBonus: out.record.eventBonus };
      },
      onReplay: () => {
        if (lastRecord) this.replay(lastRecord);
      },
    });
    this.d.hudRoot.hidden = true;
    sound.music('battle');
    const sm = this.d.game.scene;
    if (sm.isActive('village')) sm.sleep('village');
    const init: BattleSceneInit = { session, hooks: this.battleHud.hooks(), renderScale: this.d.renderScale };
    if (sm.isActive('battle') || sm.isPaused('battle')) sm.stop('battle');
    sm.start('battle', init);
  }
}
