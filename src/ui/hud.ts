import type { Analytics } from '../analytics/events';
import type { GameController } from '../game/controller';
import type { SaveStore } from '../persist/saveStore';
import { buildingDef, hallType, levelDef, troopLevel } from '../sim/data';
import type { OfflineSummary } from '../sim/offline';
import { hallUnlocks, troopCapUnlock, type UnlockItem } from '../sim/preview';
import { capacity, collectorAmount, collectorCapacity, effectiveLevel, missingFor } from '../sim/resources';
import { decodeExportCode, deserialize, encodeExportCode, serialize } from '../sim/save';
import type { Building, Cost, ResourceKind } from '../sim/types';
import { RESOURCE_KINDS } from '../sim/types';
import { armyHousing, housingCapacity, queueHousing, barracksLevel } from '../sim/army';
import type { BattleRecord } from '../sim/battle/types';
import { shieldHoursFor } from '../sim/defense';
import { leagueChest, leagueFor, nextLeague, seasonEndsAt } from '../sim/ranks';
import { achievementViews } from '../sim/achievements';
import { activeOffers } from '../sim/offers';
import { currentTasks, unlockedTier } from '../sim/pass';
import { EconomyUi } from './economyUi';
import { DailyUi } from './dailyUi';
import { chestReady } from '../sim/daily';
import { sound } from '../audio/sound';
import { GroveUi } from './groveUi';
import { attacksLeft, raidPhase } from '../sim/social/groveRaid';
import { builderStatus, countOfType, hallLevel, limitFor, placeQuote, researchSkipQuote, researchStartQuote, skipQuote, topUpQuote, trainQuote, trainingSkipQuote, upgradeQuote, type QuoteResult } from '../sim/village';
import { troopLevelOf } from '../sim/research';
import type { UiBus } from './bus';
import { clear, h, icon } from './dom';
import { formatCompact, formatDuration, formatNumber } from './format';
import { icons } from './icons';

export interface HudDeps {
  root: HTMLElement;
  controller: GameController;
  bus: UiBus;
  analytics: Analytics;
  store: SaveStore;
  /** Data URL of a building's art, for the Build menu. */
  thumbnail(type: string): string | null;
  getFps(): number;
  debugTime: { offsetMs(): number; skip(ms: number): void };
  build: { version: string; builtAt: string };
  troopThumb(type: string): string | null;
  onAttack(): void;
  onReplay(record: BattleRecord): void;
  onGroveAttack(target: number): void;
  prefs: { get(k: 'sessionReminder' | 'reminders'): boolean; set(k: 'sessionReminder' | 'reminders', v: boolean): void };
  notifyPrefs: { get(id: string, fallback: boolean): boolean; set(id: string, v: boolean): void };
  onRemindersEnabled(): Promise<void>;
  reminderNote: string;
  onReplayTutorial(): void;
}

const RES_LABEL: Record<ResourceKind, string> = { acorns: 'Acorns', dew: 'Dew', nightsap: 'Nightsap', moonstones: 'Moonstones' };

function costChips(cost: Cost, missing: Cost = {}): HTMLElement {
  const wrap = h('span', { class: 'cost' });
  const kinds = RESOURCE_KINDS.filter((k) => cost[k]);
  if (!kinds.length) wrap.append(h('span', { class: 'chip free' }, 'Free'));
  for (const k of kinds) {
    wrap.append(h('span', { class: `chip${missing[k] ? ' short' : ''}`, title: RES_LABEL[k] }, icon(icons[k as keyof typeof icons] ?? ''), formatNumber(cost[k]!)));
  }
  return wrap;
}

export class Hud {
  private readonly c: GameController;
  private readonly bus: UiBus;
  private readonly root: HTMLElement;
  private selectedId: string | null = null;
  private placementActive = false;

  private resEls = new Map<ResourceKind, { amt: HTMLElement; bar: HTMLElement; cap: HTMLElement | null }>();
  private buildersEl!: HTMLElement;
  private trophiesEl!: HTMLElement;
  private shieldEl!: HTMLElement;
  private shieldBox!: HTMLElement;
  private unlocksEl!: HTMLElement;
  private sheet!: HTMLElement;
  private placeBar!: HTMLElement;
  private placeOk!: HTMLButtonElement;
  private bottomBar!: HTMLElement;
  private rail!: HTMLElement;
  private toasts!: HTMLElement;
  private modalRoot!: HTMLElement;
  private fpsEl!: HTMLElement;
  private showFps = false;
  private openModals = new Set<() => void>();
  readonly econ: EconomyUi;
  readonly grove: GroveUi;
  readonly daily: DailyUi;
  private eventChip!: HTMLElement;
  private railBadges: Record<string, HTMLElement> = {};
  /** True while a finger/mouse is pressed on the panel: never rebuild it mid-tap. */
  private sheetPressed = false;
  private sheetSig = '';

  constructor(private readonly deps: HudDeps) {
    this.c = deps.controller;
    this.bus = deps.bus;
    this.root = deps.root;
    try {
      this.showFps = localStorage.getItem('tk.showFps') === '1';
    } catch {
      /* storage blocked: keep default */
    }
    this.econ = new EconomyUi({
      c: this.c,
      modal: (...a) => this.modal(...a),
      confirm: (...a) => this.confirm(...a),
      toast: (...a) => this.toast(...a),
      closeAllModals: () => this.closeAllModals(),
    });
    this.grove = new GroveUi({
      kit: { c: this.c, modal: (...a) => this.modal(...a), confirm: (...a) => this.confirm(...a), toast: (...a) => this.toast(...a), closeAllModals: () => this.closeAllModals() },
      troopThumb: (t) => this.deps.troopThumb(t),
      onGroveAttack: (i) => this.deps.onGroveAttack(i),
    });
    this.daily = new DailyUi({ c: this.c, modal: (...a) => this.modal(...a), confirm: (...a) => this.confirm(...a), toast: (...a) => this.toast(...a), closeAllModals: () => this.closeAllModals() });
    this.buildSkeleton();
    this.c.subscribe(() => this.refresh());
    this.c.onOffer((rule) => this.econ.showOffer(rule));
    this.bus.on('select', (id) => {
      this.selectedId = id;
      this.renderSheet();
    });
    this.bus.on('placement:changed', ({ active, valid }) => {
      this.placementActive = active;
      this.placeBar.hidden = !active;
      this.bottomBar.hidden = active;
      this.rail.hidden = active;
      this.placeOk.disabled = !valid;
      if (active) this.sheet.hidden = true;
    });
    this.bus.on('toast', ({ text, kind }) => this.toast(text, kind));
    window.setInterval(() => this.everySecond(), 1000);
    window.setInterval(() => {
      if (this.showFps) this.fpsEl.textContent = `${Math.round(this.deps.getFps())} fps`;
    }, 500);
    this.refresh();
  }

  // ------------------------------------------------------------ skeleton

  private buildSkeleton(): void {
    const top = h('div', { class: 'hud-top' });
    for (const k of ['acorns', 'dew'] as ResourceKind[]) {
      const amt = h('span', { class: 'res-amt' });
      const cap = h('span', { class: 'res-cap' });
      const fill = h('i');
      top.append(h('div', { class: `res res-${k}`, title: RES_LABEL[k] }, icon(icons[k as 'acorns' | 'dew'], 'res-icon'), h('div', { class: 'res-body' }, amt, h('div', { class: 'res-bar' }, fill), cap)));
      this.resEls.set(k, { amt, bar: fill, cap });
    }
    const moonAmt = h('span', { class: 'res-amt' });
    const moonBtn = h('div', { class: 'res res-moonstones', title: 'Moonstones: tap for the store', role: 'button' }, icon(icons.moonstones, 'res-icon'), h('div', { class: 'res-body' }, moonAmt), h('span', { class: 'res-plus' }, '+'));
    moonBtn.addEventListener('click', () => this.econ.openStore());
    top.append(moonBtn);
    this.resEls.set('moonstones', { amt: moonAmt, bar: h('i'), cap: null });
    this.buildersEl = h('span', { class: 'res-amt' });
    top.append(h('div', { class: 'res res-builders', title: 'Free Beaver Builders' }, icon(icons.beaver, 'res-icon'), h('div', { class: 'res-body' }, this.buildersEl)));
    this.trophiesEl = h('span', { class: 'res-amt' });
    const trophyBtn = h('div', { class: 'res res-trophies', title: 'Leaf rank', role: 'button' }, icon(icons.leaf, 'res-icon'), h('div', { class: 'res-body' }, this.trophiesEl));
    trophyBtn.addEventListener('click', () => this.openLeague());
    top.append(trophyBtn);
    this.shieldEl = h('span', { class: 'res-amt' });
    this.shieldBox = h('div', { class: 'res res-shield', title: 'Shield: no raids until it runs out' }, icon(icons.shield, 'res-icon'), h('div', { class: 'res-body' }, this.shieldEl));
    top.append(this.shieldBox);

    this.unlocksEl = h('button', { class: 'unlocks', type: 'button', onclick: () => this.openUnlocks() });
    this.eventChip = h('button', { class: 'event-chip', type: 'button', 'aria-label': 'Events', onclick: () => this.daily.openEvents() });
    this.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.fpsEl = h('div', { class: 'fps' });
    this.fpsEl.hidden = !this.showFps;

    this.bottomBar = h(
      'div',
      { class: 'hud-bottom' },
      h(
        'div',
        { class: 'group' },
        h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Settings', onclick: () => this.openSettings() }, icon(icons.gear)),
        h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Battle log', onclick: () => this.openLog() }, icon(icons.scroll)),
        h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Army', onclick: () => this.openTraining() }, icon(icons.troops)),
      ),
      h(
        'div',
        { class: 'group' },
        h('button', { class: 'round-btn big attack', type: 'button', 'aria-label': 'Attack', onclick: () => this.deps.onAttack() }, icon(icons.swords), h('span', {}, 'Attack')),
        h('button', { class: 'round-btn big build', type: 'button', 'aria-label': 'Build', onclick: () => this.openShop() }, icon(icons.hammer), h('span', {}, 'Build')),
      ),
    );

    this.placeOk = h('button', { class: 'round-btn ok', type: 'button', 'aria-label': 'Place here', onclick: () => this.bus.emit('placement:confirm') }, icon(icons.check));
    this.placeBar = h(
      'div',
      { class: 'place-bar' },
      h('button', { class: 'round-btn cancel', type: 'button', 'aria-label': 'Cancel', onclick: () => this.bus.emit('placement:cancel') }, icon(icons.close)),
      h('div', { class: 'place-hint' }, 'Drag the building, or tap where it should go'),
      this.placeOk,
    );
    this.placeBar.hidden = true;

    this.sheet = h('div', { class: 'sheet' });
    this.sheet.hidden = true;
    this.sheet.addEventListener('pointerdown', () => (this.sheetPressed = true));
    const release = () => window.setTimeout(() => (this.sheetPressed = false), 80);
    this.sheet.addEventListener('pointerup', release);
    this.sheet.addEventListener('pointercancel', release);
    this.sheet.addEventListener('pointerleave', release);
    this.modalRoot = h('div', { class: 'modal-root' });

    const head = h('div', { class: 'hud-head' }, top, h('div', { class: 'head-row' }, this.unlocksEl, this.eventChip), this.toasts);
    const railBtn = (label: string, ic: string, onClick: () => void) => {
      const badge = h('span', { class: 'badge' });
      badge.hidden = true;
      this.railBadges[label] = badge;
      return h('button', { class: 'round-btn', type: 'button', 'aria-label': label, onclick: onClick }, icon(ic), badge);
    };
    const rail = h(
      'div',
      { class: 'side-rail' },
      railBtn('Daily', icons.chest, () => this.daily.openDaily()),
      railBtn('Store', icons.moonstones, () => this.econ.openStore(activeOffers(this.c.state, this.c.now()).length ? 'offers' : 'moonstones')),
      railBtn('Pass', icons.lantern, () => this.econ.openPass()),
      railBtn('Goals', icons.star, () => this.econ.openGoals()),
      railBtn('Grove', icons.grove, () => this.grove.open()),
    );
    this.rail = rail;
    this.root.append(head, rail, this.fpsEl, this.bottomBar, this.placeBar, this.sheet, this.modalRoot);
  }

  // ------------------------------------------------------------ refresh

  private refresh(): void {
    const s = this.c.state;
    const gd = this.c.data;
    const cap = capacity(s, gd);
    for (const [k, el] of this.resEls) {
      el.amt.textContent = formatNumber(s.resources[k]);
      if (el.cap) {
        el.cap.textContent = `/ ${formatCompact(cap[k])}`;
        el.bar.style.width = `${Math.min(100, (s.resources[k] / Math.max(1, cap[k])) * 100)}%`;
        el.bar.parentElement!.classList.toggle('full', s.resources[k] >= cap[k]);
      }
    }
    const bs = builderStatus(s, gd, this.c.now());
    this.buildersEl.textContent = `${bs.free}/${bs.total}`;
    this.trophiesEl.textContent = String(s.trophies);
    this.updateShield();
    this.updateBadges();
    this.renderUnlockChip();
    this.renderSheet();
  }

  private updateBadges(): void {
    const s = this.c.state;
    const gd = this.c.data;
    const hl = hallLevel(s, gd);
    const set = (k: string, n: number) => {
      const b = this.railBadges[k];
      if (!b) return;
      b.hidden = n <= 0;
      b.textContent = String(n);
    };
    set('Store', activeOffers(s, this.c.now()).length);
    set('Daily', chestReady(s, this.c.now(), gd) ? 1 : 0);
    const tier = unlockedTier(s, gd);
    const tiersReady = gd.pass.tiers.filter((t) => t.tier <= tier && (!s.pass.claimedFree.includes(t.tier) || (s.pass.premium && !s.pass.claimedPremium.includes(t.tier)))).length;
    const tasksReady = currentTasks(s, hl, gd).filter((t) => !t.claimed && t.progress >= t.target).length;
    set('Pass', tiersReady + tasksReady);
    set('Goals', achievementViews(s, hl, gd).filter((v) => v.claimable).length);
    const live = raidPhase(this.c.now(), gd);
    set('Grove', s.grove.joined ? (live.phase === 'live' ? attacksLeft(s, live.week, gd) : 0) + s.grove.requests.length : 1);
  }

  private updateShield(): void {
    const left = this.c.state.shieldUntil - this.c.now();
    this.shieldBox.hidden = left <= 0;
    if (left > 0) this.shieldEl.textContent = formatDuration(left);
  }

  private everySecond(): void {
    this.updateShield();
    this.eventChip.textContent = DailyUi.chipText(this.c.now(), this.c);
    this.updateBadges();
    const s = this.c.state;
    const bs = builderStatus(s, this.c.data, this.c.now());
    this.buildersEl.textContent = `${bs.free}/${bs.total}`;
    if (!this.selectedId || this.sheet.hidden) return;
    if (this.sheetSignature() !== this.sheetSig) this.renderSheet();
    else this.updateSheetLive();
  }

  /** Changes to these values need a full rebuild of the panel; everything else updates in place. */
  private sheetSignature(): string {
    const b = this.c.state.buildings.find((v) => v.id === this.selectedId);
    if (!b) return 'none';
    const now = this.c.now();
    const busy = Boolean(b.upgrade && now < b.upgrade.endsAt);
    const q = busy ? null : upgradeQuote(this.c.state, b.id, this.c.data, now);
    const missing = q && !q.ok && q.quote ? Object.keys(missingFor(this.c.state.resources, q.quote.cost)).join() : '';
    return JSON.stringify([b.id, effectiveLevel(b, now), busy, q ? (q.ok ? 'ok' : q.code) : '-', missing]);
  }

  /** Update timers and collector amounts without replacing any buttons. */
  private updateSheetLive(): void {
    const b = this.c.state.buildings.find((v) => v.id === this.selectedId);
    if (!b) return;
    const gd = this.c.data;
    const now = this.c.now();
    const up = this.sheet.querySelector<HTMLElement>('[data-live="upgrade"]');
    if (up && b.upgrade) {
      const u = b.upgrade;
      const pct = Math.min(100, ((now - u.startedAt) / Math.max(1, u.endsAt - u.startedAt)) * 100);
      (up.querySelector('i') as HTMLElement).style.width = `${pct}%`;
      up.querySelector('span')!.textContent = `${u.toLevel === 1 ? 'Building' : `Upgrading to Lv ${u.toLevel}`} · ${formatDuration(u.endsAt - now)} left`;
    }
    const col = this.sheet.querySelector<HTMLElement>('[data-live="collector"]');
    if (col) {
      const level = effectiveLevel(b, now);
      const amount = Math.floor(collectorAmount(b, now, gd));
      const cap = collectorCapacity(b, level, gd);
      (col.querySelector('i') as HTMLElement).style.width = `${Math.min(100, (amount / Math.max(1, cap)) * 100)}%`;
      col.querySelector('span')!.textContent = `Ready: ${formatNumber(amount)} / ${formatNumber(cap)}`;
    }
  }

  // ------------------------------------------------------------ unlock preview

  private unlockText(u: UnlockItem): string {
    const name = buildingDef(this.c.data, u.type).name;
    if (u.kind === 'new') return `New: ${name}${u.to > 1 ? ` ×${u.to}` : ''}`;
    if (u.kind === 'more') return `${name}: build up to ${u.to} (now ${u.from})`;
    return `${name}: up to level ${u.to} (now ${u.from})`;
  }

  /** One short line, e.g. "+1 Acorn Orchard, +1 Dewdrop Well, higher levels for 4 buildings". */
  private unlockSummary(items: UnlockItem[]): string {
    const gd = this.c.data;
    const parts: string[] = [];
    for (const u of items) {
      const name = buildingDef(gd, u.type).name;
      if (u.kind === 'new') parts.push(`new ${name}`);
      else if (u.kind === 'more') parts.push(`+${u.to - u.from} ${name}`);
    }
    const capped = new Set(items.filter((u) => u.kind === 'levelCap').map((u) => u.type)).size;
    const shown = parts.slice(0, 3);
    if (parts.length > 3) shown.push(`${parts.length - 3} more`);
    if (capped) shown.push(`higher levels for ${capped} building${capped > 1 ? 's' : ''}`);
    const troops = troopCapUnlock(hallLevel(this.c.state, gd), gd);
    if (troops) shown.push(`troop level ${troops.to}`);
    return shown.join(', ');
  }

  private renderUnlockChip(): void {
    const level = hallLevel(this.c.state, this.c.data);
    const items = hallUnlocks(level, this.c.data);
    clear(this.unlocksEl);
    this.unlocksEl.append(icon(icons.toadstool));
    if (!items.length) {
      this.unlocksEl.append(h('span', {}, h('b', {}, `Elder Toadstool Lv ${level}`), ' — top level for now'));
      return;
    }
    this.unlocksEl.append(h('span', { class: 'unlock-text' }, h('b', {}, `Elder Toadstool Lv ${level + 1} unlocks: `), this.unlockSummary(items)));
  }

  private openUnlocks(): void {
    const gd = this.c.data;
    const level = hallLevel(this.c.state, gd);
    const items = hallUnlocks(level, gd);
    const hall = this.c.state.buildings.find((b) => b.type === hallType(gd));
    const body = h('div', { class: 'unlock-list' });
    if (!items.length) body.append(h('p', {}, 'Your Elder Toadstool is at the highest level available right now.'));
    else {
      body.append(h('p', { class: 'muted' }, `Upgrading your Elder Toadstool to level ${level + 1} unlocks:`));
      const troops = troopCapUnlock(level, gd);
      body.append(h('ul', {}, ...items.map((u) => h('li', {}, this.unlockText(u))), troops ? h('li', {}, `Troop research: up to level ${troops.to} (now ${troops.from})`) : ''));
      const next = levelDef(gd, hallType(gd), level + 1);
      if (next) body.append(h('p', { class: 'row' }, 'Cost: ', costChips(next.cost, missingFor(this.c.state.resources, next.cost)), h('span', { class: 'chip' }, icon(icons.clock), formatDuration(next.buildSeconds * 1000))));
    }
    const close = this.modal('Elder Toadstool', body, [
      hall && {
        label: 'Go to Elder Toadstool',
        primary: true,
        onClick: () => {
          close();
          this.bus.emit('select', hall.id);
          this.bus.emit('camera:focus', { id: hall.id });
        },
      },
    ]);
  }

  // ------------------------------------------------------------ building sheet

  private renderSheet(): void {
    const b = this.c.state.buildings.find((v) => v.id === this.selectedId);
    if (!b || this.placementActive) {
      this.sheet.hidden = true;
      this.sheetSig = '';
      return;
    }
    if (this.sheetPressed && !this.sheet.hidden && this.sheet.dataset.id === b.id) {
      window.setTimeout(() => this.renderSheet(), 120);
      return;
    }
    this.sheetSig = this.sheetSignature();
    this.sheet.dataset.id = b.id;
    const gd = this.c.data;
    const now = this.c.now();
    const def = buildingDef(gd, b.type);
    const level = effectiveLevel(b, now);
    clear(this.sheet);
    this.sheet.hidden = false;
    if (def.category === 'obstacle' && def.clear) {
      this.renderObstacleSheet(b, def.name, def.description, def.clear);
      return;
    }

    const title = h('div', { class: 'sheet-title' }, h('h2', {}, def.name), h('span', { class: 'level' }, level >= 1 ? `Level ${level}` : 'Being built'));
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => this.bus.emit('select', null) }, icon(icons.close));
    this.sheet.append(h('div', { class: 'sheet-head' }, title, closeBtn));
    this.sheet.append(h('p', { class: 'muted desc' }, def.description));

    // Stats
    const stats = h('div', { class: 'stats' });
    const ld = levelDef(gd, b.type, Math.max(1, level));
    if (def.category === 'collector' && def.produces && ld?.ratePerHour) {
      stats.append(h('span', { class: 'chip' }, icon(icons[def.produces as 'acorns' | 'dew']), `${formatNumber(ld.ratePerHour)}/hour`));
      stats.append(h('span', { class: 'chip' }, `Holds ${formatNumber(collectorCapacity(b, Math.max(1, level), gd))}`));
    }
    if (ld?.storage) {
      for (const k of RESOURCE_KINDS) {
        const v = ld.storage[k];
        if (v) stats.append(h('span', { class: 'chip' }, icon(icons[k as 'acorns' | 'dew']), `Stores ${formatNumber(v)}`));
      }
    }
    if (def.category === 'builder') stats.append(h('span', { class: 'chip' }, icon(icons.beaver), 'Home of 1 Beaver Builder'));
    if (ld?.housing) stats.append(h('span', { class: 'chip' }, icon(icons.troops), `Houses ${ld.housing}`));
    if (def.combat && ld?.damage) {
      const dps = (ld.damage * gd.battle.ticksPerSecond) / def.combat.fireIntervalTicks;
      stats.append(h('span', { class: 'chip' }, `${Math.round(dps)} damage/sec`));
      stats.append(h('span', { class: 'chip' }, `Range ${def.combat.range}`));
      stats.append(h('span', { class: 'chip' }, def.combat.targets === 'both' ? 'Ground & air' : def.combat.targets === 'air' ? 'Air only' : 'Ground only'));
    }
    if (def.category === 'hedge' && ld) stats.append(h('span', { class: 'chip' }, `${formatNumber(ld.hp)} HP`));
    if (ld?.guardians) {
      for (const [g, v] of Object.entries(ld.guardians)) stats.append(h('span', { class: 'chip' }, `${v.count}× ${gd.guardians.animals[g]?.name ?? g} Lv ${v.level}`));
    }
    if (stats.childElementCount) this.sheet.append(stats);

    // Upgrade in progress
    if (b.upgrade && now < b.upgrade.endsAt) {
      const u = b.upgrade;
      const pct = Math.min(100, ((now - u.startedAt) / Math.max(1, u.endsAt - u.startedAt)) * 100);
      this.sheet.append(
        h(
          'div',
          { class: 'progress-row', 'data-live': 'upgrade' },
          h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })),
          h('span', {}, `${u.toLevel === 1 ? 'Building' : `Upgrading to Lv ${u.toLevel}`} · ${formatDuration(u.endsAt - now)} left`),
        ),
      );
    }

    // Collector contents
    if (def.produces && level >= 1) {
      const amount = Math.floor(collectorAmount(b, now, gd));
      const cap = collectorCapacity(b, level, gd);
      this.sheet.append(
        h(
          'div',
          { class: 'progress-row', 'data-live': 'collector' },
          h('div', { class: `progress ${def.produces}` }, h('i', { style: `width:${Math.min(100, (amount / Math.max(1, cap)) * 100)}%` })),
          h('span', {}, `Ready: ${formatNumber(amount)} / ${formatNumber(cap)}`),
        ),
      );
    }

    // Actions
    const actions = h('div', { class: 'actions' });
    if (def.produces && level >= 1) {
      actions.append(
        h('button', { class: 'btn', type: 'button', onclick: () => this.collect(b) }, icon(icons[def.produces as 'acorns' | 'dew']), 'Collect'),
      );
    }
    if (b.upgrade && now < b.upgrade.endsAt) {
      const sq = skipQuote(this.c.state, b.id, now, gd);
      if (sq) {
        actions.append(
          h(
            'button',
            { class: 'btn gold', type: 'button', onclick: () => void this.econ.spendMoonstones('Finish now', `Finish ${def.name} now`, skipQuote(this.c.state, b.id, this.c.now(), gd)?.moonstones ?? sq.moonstones, () => this.c.dispatch({ type: 'skip', id: b.id }).ok) },
            'Finish now ',
            h('span', { class: 'chip' }, icon(icons.moonstones), String(sq.moonstones)),
          ),
        );
      }
      actions.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => this.cancelUpgrade(b) }, icon(icons.close), 'Cancel'));
    } else if (def.category !== 'decor') {
      const uq = upgradeQuote(this.c.state, b.id, gd, now);
      actions.append(this.upgradeButton(b, uq));
      if (!uq.ok && uq.code === 'NOT_ENOUGH_RESOURCES' && uq.quote) {
        const tq = topUpQuote(this.c.state, uq.quote.cost, gd);
        if (tq) {
          const missing = Object.entries(tq.missing).map(([k, v]) => `${formatNumber(v as number)} ${RES_LABEL[k as ResourceKind]}`).join(' and ');
          actions.append(
            h(
              'button',
              {
                class: 'btn gold',
                type: 'button',
                onclick: () =>
                  void this.econ.spendMoonstones('Buy missing resources', `Buy the missing ${missing} and start the upgrade`, tq.moonstones, () => {
                    const r1 = this.c.dispatch({ type: 'topUp', cost: uq.quote!.cost });
                    return r1.ok && this.c.dispatch({ type: 'upgrade', id: b.id }).ok;
                  }),
              },
              'Buy missing ',
              h('span', { class: 'chip' }, icon(icons.moonstones), String(tq.moonstones)),
            ),
          );
        }
      }
    }
    if (def.category === 'military' && level >= 1) {
      actions.append(h('button', { class: 'btn sky', type: 'button', onclick: () => this.openTraining() }, icon(icons.troops), 'Train troops'));
    }
    actions.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => this.bus.emit('placement:start', { kind: 'move', id: b.id }) }, icon(icons.move), 'Move'));
    this.sheet.append(actions);
  }

  private renderObstacleSheet(b: Building, name: string, description: string, clr: { cost: Cost; seconds: number; moonstones: number }): void {
    const now = this.c.now();
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => this.bus.emit('select', null) }, icon(icons.close));
    this.sheet.append(h('div', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, h('h2', {}, name)), closeBtn), h('p', { class: 'muted desc' }, description));
    if (b.upgrade && now < b.upgrade.endsAt) {
      const u = b.upgrade;
      const pct = Math.min(100, ((now - u.startedAt) / Math.max(1, u.endsAt - u.startedAt)) * 100);
      this.sheet.append(h('div', { class: 'progress-row', 'data-live': 'upgrade' }, h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })), h('span', {}, `Clearing · ${formatDuration(u.endsAt - now)} left`)));
      return;
    }
    const btn = h(
      'button',
      { class: 'btn primary upgrade', type: 'button' },
      h('span', { class: 'btn-label' }, 'Clear it'),
      h('span', { class: 'btn-sub' }, costChips(clr.cost, missingFor(this.c.state.resources, clr.cost)), h('span', { class: 'chip' }, icon(icons.clock), formatDuration(clr.seconds * 1000)), h('span', { class: 'chip good' }, '+', icon(icons.moonstones), String(clr.moonstones))),
    );
    btn.addEventListener('click', () => {
      const r = this.c.dispatch({ type: 'clear', id: b.id });
      if (!r.ok) this.toast(r.message, 'error');
    });
    this.sheet.append(h('div', { class: 'actions' }, btn));
  }

  private upgradeButton(b: Building, q: QuoteResult): HTMLElement {
    if (!q.ok && !q.quote) return h('div', { class: 'note' }, q.message);
    const quote = q.ok ? q.quote : q.quote!;
    const missing = missingFor(this.c.state.resources, quote.cost);
    const btn = h(
      'button',
      {
        class: 'btn primary upgrade',
        type: 'button',
        disabled: !q.ok,
        onclick: () => {
          const r = this.c.dispatch({ type: 'upgrade', id: b.id });
          if (!r.ok) this.toast(r.message, 'error');
        },
      },
      h('span', { class: 'btn-label' }, icon(icons.up), `Upgrade to Lv ${quote.toLevel}`),
      h('span', { class: 'btn-sub' }, costChips(quote.cost, missing), h('span', { class: 'chip' }, icon(icons.clock), formatDuration(quote.seconds * 1000))),
    );
    if (q.ok) return btn;
    return h('div', { class: 'upgrade-wrap' }, btn, h('div', { class: 'note' }, q.message));
  }

  private collect(b: Building): void {
    const r = this.c.dispatch({ type: 'collect', id: b.id });
    if (!r.ok) this.toast(r.message, r.code === 'NOTHING_TO_COLLECT' ? 'info' : 'error');
    else for (const e of r.events) if (e.kind === 'collect') this.toast(`+${formatNumber(e.amount)} ${RES_LABEL[e.resource]}`, 'success');
  }

  private async cancelUpgrade(b: Building): Promise<void> {
    const pct = Math.round(this.c.data.economy.cancelRefundFraction * 100);
    const ok = await this.confirm('Cancel?', `You'll get back ${pct}% of what you paid.`, 'Cancel upgrade', true);
    if (!ok) return;
    const r = this.c.dispatch({ type: 'cancel', id: b.id });
    if (!r.ok) this.toast(r.message, 'error');
  }

  // ------------------------------------------------------------ shop

  private shopTab: 'resources' | 'army' | 'defense' | 'decor' = 'resources';

  private openShop(): void {
    const body = h('div', {});
    const tabs: [typeof this.shopTab, string, string[]][] = [
      ['resources', 'Resources', ['collector', 'storage', 'builder']],
      ['army', 'Army', ['military']],
      ['defense', 'Defense', ['defense', 'guardian', 'hedge', 'trap']],
      ['decor', 'Decor', ['decor']],
    ];
    const visible = tabs.filter(([, , cats]) => Object.values(this.c.data.buildings).some((d) => d.inShop && cats.includes(d.category)));
    const draw = () => {
      clear(body);
      body.append(
        h('div', { class: 'shop-tabs' }, ...visible.map(([id, label]) => {
          const b = h('button', { type: 'button', class: id === this.shopTab ? 'on' : '' }, label);
          b.addEventListener('click', () => {
            this.shopTab = id;
            draw();
          });
          return b;
        })),
      );
      const cats = (visible.find(([id]) => id === this.shopTab) ?? visible[0])[2];
      body.append(this.shopGrid(cats, () => close()));
    };
    draw();
    const close = this.modal('Build', body, [], 'wide');
  }

  private shopGrid(categories: string[], close: () => void): HTMLElement {
    const gd = this.c.data;
    const now = this.c.now();
    const grid = h('div', { class: 'shop-grid' });
    for (const [type, def] of Object.entries(gd.buildings)) {
      if (!def.inShop || !categories.includes(def.category)) continue;
      const q = placeQuote(this.c.state, gd, type, now);
      const lim = limitFor(this.c.state, gd, type);
      const have = countOfType(this.c.state, type);
      const first = def.levels[0];
      const thumb = this.deps.thumbnail(type);
      const card = h(
        'button',
        {
          class: `shop-card${q.ok ? '' : ' disabled'}`,
          type: 'button',
          'aria-disabled': !q.ok,
          onclick: () => {
            if (!q.ok) {
              this.toast(q.message, 'error');
              return;
            }
            close();
            this.bus.emit('placement:start', { kind: 'new', buildingType: type });
          },
        },
        thumb ? h('img', { src: thumb, alt: '' }) : h('div', { class: 'thumb-ph' }),
        h('div', { class: 'shop-name' }, def.name),
        h('div', { class: 'shop-count' }, `Built ${have}/${lim.count}`),
        h('div', { class: 'shop-cost' }, costChips(first.cost, missingFor(this.c.state.resources, first.cost)), h('span', { class: 'chip' }, icon(icons.clock), formatDuration(first.buildSeconds * 1000))),
        !q.ok ? h('div', { class: 'shop-why' }, q.message) : null,
      );
      grid.append(card);
    }
    return grid;
  }

  // ------------------------------------------------------------ army

  openTraining(): void {
    const body = h('div', { class: 'training' });
    let lastSig = '';
    const render = () => {
      const s = this.c.state;
      const gd = this.c.data;
      const now = this.c.now();
      const sig = JSON.stringify([s.army, s.training.length, s.resources.dew, s.resources.moonstones, barracksLevel(s, gd), housingCapacity(s, gd), s.research, hallLevel(s, gd)]);
      if (sig === lastSig) {
        // Only refresh timers.
        body.querySelectorAll<HTMLElement>('[data-ends]').forEach((el) => {
          el.textContent = formatDuration(Number(el.dataset.ends) - now);
        });
        return;
      }
      lastSig = sig;
      clear(body);
      const cap = housingCapacity(s, gd);
      const used = armyHousing(s.army, gd);
      const queued = queueHousing(s.training, gd);
      body.append(
        h('div', { class: 'progress-row' }, h('div', { class: 'progress' }, h('i', { style: `width:${cap ? Math.min(100, ((used + queued) / cap) * 100) : 0}%` })), h('span', {}, `Army ${used}${queued ? ` (+${queued})` : ''} / ${cap}`)),
      );
      const army = h('div', { class: 'army-row' });
      for (const [t, n] of Object.entries(s.army)) {
        if (n <= 0) continue;
        const th = this.deps.troopThumb(t);
        army.append(h('span', { class: 'army-chip' }, th ? h('img', { src: th, alt: '' }) : null, `${gd.troops[t]?.name ?? t} ×${n}`));
      }
      if (!army.childElementCount) army.append(h('span', { class: 'muted' }, 'No troops yet.'));
      body.append(h('h3', {}, 'Ready to attack'), army);
      if (s.training.length) {
        const q = h('div', { class: 'queue' });
        s.training.forEach((item, i) => {
          const th = this.deps.troopThumb(item.troop);
          const x = h('button', { class: 'qx', type: 'button', 'aria-label': 'Cancel' }, '×');
          x.addEventListener('click', () => {
            const r = this.c.dispatch({ type: 'cancelTraining', index: i });
            if (!r.ok) this.toast(r.message, 'error');
            render();
          });
          q.append(h('div', { class: 'queue-item' }, th ? h('img', { src: th, alt: '' }) : null, x, h('span', { class: 'qt', 'data-ends': String(item.endsAt) }, formatDuration(item.endsAt - now))));
        });
        body.append(h('h3', {}, 'Training'), q);
        const tsq = trainingSkipQuote(s, now, gd);
        if (tsq) {
          const fin = h('button', { class: 'btn gold', type: 'button' }, 'Finish training ', h('span', { class: 'chip' }, icon(icons.moonstones), String(tsq.moonstones)));
          fin.addEventListener('click', () => void this.econ.spendMoonstones('Finish training', 'Finish all training now', tsq.moonstones, () => this.c.dispatch({ type: 'skipTraining' }).ok).then(() => { lastSig = ''; render(); }));
          body.append(h('div', { class: 'actions' }, fin));
        }
      }
      const list = h('div', { class: 'troop-list' });
      for (const [t, def] of Object.entries(gd.troops)) {
        const qr = trainQuote(s, t, now, gd);
        const th = this.deps.troopThumb(t);
        const locked = !qr.ok && qr.code === 'LOCKED';
        const lvl = troopLevelOf(s, t);
        const cost = troopLevel(gd, t, lvl).cost;
        const btn = h('button', { class: 'btn primary', type: 'button', disabled: !qr.ok }, '+ Train');
        btn.addEventListener('click', () => {
          const r = this.c.dispatch({ type: 'train', troop: t });
          if (!r.ok) this.toast(r.message, 'error');
          render();
        });
        list.append(
          h(
            'div',
            { class: `troop-row${locked ? ' locked' : ''}` },
            th ? h('img', { src: th, alt: '' }) : null,
            h('b', {}, `${def.name} `, h('span', { class: 'muted small' }, `Lv ${lvl}`)),
            h('span', { class: 'muted small' }, def.description),
            h('span', { class: 'row' }, costChips(cost, missingFor(s.resources, cost)), h('span', { class: 'chip' }, icon(icons.clock), formatDuration(def.trainSeconds * 1000)), h('span', { class: 'chip' }, icon(icons.troops), String(def.housing))),
            btn,
            !qr.ok ? h('span', { class: 'note' }, qr.message) : null,
          ),
        );
      }
      body.append(h('h3', {}, 'Train'), list);
      body.append(h('h3', {}, 'Research'), h('p', { class: 'muted small' }, 'The Burrow Barracks researches one troop at a time, without a builder. A new level makes every troop of that kind stronger, and costs a little more to train. Your Elder Toadstool level sets the highest level.'));
      const active = s.research.active;
      if (active) {
        const ad = gd.troops[active.troop];
        const row = h('div', { class: 'progress-row' }, h('span', {}, `${ad?.name ?? active.troop} → level ${active.toLevel}`), h('span', { class: 'chip', 'data-ends': String(active.endsAt) }, formatDuration(active.endsAt - now)));
        const acts = h('div', { class: 'actions' });
        const rsq = researchSkipQuote(s, now, gd);
        if (rsq) {
          const fin = h('button', { class: 'btn gold', type: 'button' }, 'Finish now ', h('span', { class: 'chip' }, icon(icons.moonstones), String(rsq.moonstones)));
          fin.addEventListener('click', () => void this.econ.spendMoonstones('Finish research', `Finish ${ad?.name ?? 'research'} level ${active.toLevel} now`, rsq.moonstones, () => this.c.dispatch({ type: 'skipResearch' }).ok).then(() => { lastSig = ''; render(); }));
          acts.append(fin);
        }
        const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
        cancel.addEventListener('click', () => {
          void this.confirm('Cancel research?', `You'll get back ${Math.round(gd.economy.cancelRefundFraction * 100)}% of what you paid.`, 'Cancel research', true).then((ok) => {
            if (!ok) return;
            const r = this.c.dispatch({ type: 'cancelResearch' });
            if (!r.ok) this.toast(r.message, 'error');
            lastSig = '';
            render();
          });
        });
        acts.append(cancel);
        body.append(row, acts);
      }
      const rlist = h('div', { class: 'troop-list' });
      for (const [t, def] of Object.entries(gd.troops)) {
        const lvl = troopLevelOf(s, t);
        const rq = researchStartQuote(s, t, now, gd);
        if (!rq.ok && (rq.code === 'LOCKED' || (rq.code === 'MAX_LEVEL' && !rq.quote))) {
          rlist.append(h('div', { class: 'troop-row locked' }, h('b', {}, `${def.name} `, h('span', { class: 'muted small' }, `Lv ${lvl}`)), h('span', { class: 'note' }, rq.message)));
          continue;
        }
        const cur = troopLevel(gd, t, lvl);
        const nxt = rq.quote ? troopLevel(gd, t, rq.quote.toLevel) : null;
        const btn = h('button', { class: 'btn primary', type: 'button', disabled: !rq.ok }, 'Research');
        btn.addEventListener('click', () => {
          const r = this.c.dispatch({ type: 'research', troop: t });
          if (!r.ok) this.toast(r.message, 'error');
          lastSig = '';
          render();
        });
        rlist.append(
          h(
            'div',
            { class: `troop-row${rq.ok ? '' : ' locked'}` },
            h('b', {}, `${def.name} `, h('span', { class: 'muted small' }, nxt ? `Lv ${lvl} → ${nxt.level}` : `Lv ${lvl}`)),
            nxt ? h('span', { class: 'muted small' }, `HP ${cur.hp} → ${nxt.hp} · Damage ${cur.damage} → ${nxt.damage}`) : null,
            rq.quote ? h('span', { class: 'row' }, costChips(rq.quote.cost, missingFor(s.resources, rq.quote.cost)), h('span', { class: 'chip' }, icon(icons.clock), formatDuration(rq.quote.seconds * 1000))) : null,
            nxt ? btn : null,
            !rq.ok ? h('span', { class: 'note' }, rq.message) : null,
          ),
        );
      }
      body.append(rlist);
    };
    render();
    const timer = window.setInterval(render, 1000);
    const unsub = this.c.subscribe(() => render());
    this.modal('Army', body, [], 'wide', () => {
      window.clearInterval(timer);
      unsub();
    });
  }

  openLeague(): void {
    const s = this.c.state;
    const gd = this.c.data;
    const cur = leagueFor(s.trophies, gd);
    const nxt = nextLeague(s.trophies, gd);
    const body = h(
      'div',
      {},
      h('p', {}, h('b', {}, cur.name), ` · ${s.trophies} leaves`),
      nxt ? h('p', { class: 'muted' }, `${nxt.min - s.trophies} more leaves to reach ${nxt.name}.`) : h('p', { class: 'muted' }, 'You are in the top league!'),
      h('p', { class: 'muted' }, `Season ends in ${formatDuration(seasonEndsAt(this.c.now()) - this.c.now())}. At the end of each month you get your league's chest, and leaves above ${gd.ranks.seasonResetFloor} are halved.`),
      h('h3', {}, 'League chests (fixed contents)'),
      h('p', { class: 'muted small' }, `Sized for your Elder Toadstool level ${hallLevel(s, gd)}. Won attacks also earn the league bonus (all of it at 3 stars, a third per star).`),
    );
    for (const l of gd.ranks.leagues) {
      const bonus = Object.keys(l.winBonus ?? {}).length ? h('div', { class: 'muted small' }, 'Win bonus ', costChips(l.winBonus)) : null;
      body.append(h('div', { class: `log-row${l.id === cur.id ? ' current' : ''}` }, h('div', {}, h('b', {}, l.name), h('div', { class: 'muted small' }, `${l.min}+ leaves`), bonus), costChips(leagueChest(l, hallLevel(s, gd), gd))));
    }
    body.append(h('p', { class: 'muted small' }, 'Win raids to earn leaves; lose them when your attacks fail or when raiders beat your village. More leaves bring tougher opponents with more loot.'));
    this.modal('Leaf rank', body, [], 'normal');
  }

  openLog(): void {
    const s = this.c.state;
    const body = h('div', {});
    const attacks = [...s.battleLog, ...s.defenseLog].sort((a, b) => b.at - a.at);
    if (!attacks.length) body.append(h('p', { class: 'muted' }, 'No battles yet. Tap Attack to raid a neighbouring kingdom!'));
    for (const r of attacks) {
      const stars = h('span', { class: 'stars-mini' });
      for (let i = 0; i < 3; i++) stars.append(h('span', { class: i < r.result.stars ? '' : 'off' }, '★'));
      const replay = h('button', { class: 'btn sky', type: 'button' }, 'Replay');
      replay.addEventListener('click', () => {
        this.closeAllModals();
        this.deps.onReplay(r);
      });
      body.append(
        h(
          'div',
          { class: 'log-row' },
          h('div', {}, h('b', {}, r.kind === 'attack' ? `You raided ${r.opponentName}` : `${r.opponentName} raided you`), h('div', { class: 'row' }, stars, r.trophies !== undefined ? h('span', { class: `chip ${r.trophies >= 0 ? 'good' : 'short'}` }, icon(icons.leaf), `${r.trophies >= 0 ? '+' : ''}${r.trophies}`) : null, h('span', { class: 'muted small' }, `${r.result.destruction}% · ${formatDuration(this.c.now() - r.at)} ago`), Object.keys(r.result.loot).some((k) => (r.result.loot as Record<string, number>)[k] > 0) ? costChips(r.result.loot) : h('span', { class: 'chip' }, 'No loot'))),
          replay,
        ),
      );
    }
    this.modal('Battle log', body, [], 'wide');
  }

  // ------------------------------------------------------------ welcome back

  showWelcomeBack(s: OfflineSummary, onClose?: () => void): void {
    const gd = this.c.data;
    const body = h('div', { class: 'welcome' }, h('p', {}, `You were away for ${formatDuration(s.awayMs)}.`));
    const list = h('ul', {});
    for (const f of s.finished) {
      const name = buildingDef(gd, f.type).name;
      list.append(h('li', {}, f.level === 1 ? `${name} finished building.` : `${name} reached level ${f.level}.`));
    }
    const gains = RESOURCE_KINDS.filter((k) => (s.collectorGains[k] ?? 0) > 0);
    if (gains.length) {
      list.append(
        h('li', {}, 'Your collectors gathered ', gains.map((k) => `${formatNumber(s.collectorGains[k]!)} ${RES_LABEL[k]}`).join(' and '), '. Tap the bubbles to collect.'),
      );
    }
    for (const r of s.raids) {
      const lost = RESOURCE_KINDS.filter((k) => (r.result.loot[k] ?? 0) > 0).map((k) => `${formatNumber(r.result.loot[k]!)} ${RES_LABEL[k]}`).join(' and ');
      list.append(h('li', {}, `${r.opponentName} raided you: ${'★'.repeat(r.result.stars)}${'☆'.repeat(3 - r.result.stars)} ${r.result.destruction}%`, lost ? `, took ${lost}` : ', took nothing', r.trophies ? ` (${r.trophies > 0 ? '+' : ''}${r.trophies} leaves).` : '.'));
    }
    if (this.c.state.shieldUntil > this.c.now() && s.raids.some((r) => shieldHoursFor(r.result.destruction, this.c.data) > 0)) {
      list.append(h('li', {}, `You have a shield for ${formatDuration(this.c.state.shieldUntil - this.c.now())}.`));
    }
    for (const sr of s.seasons) {
      list.append(h('li', {}, `The season ended! Your ${this.c.data.ranks.leagues.find((l) => l.id === sr.league)?.name ?? sr.league} chest: `, costChips(sr.chest)));
    }
    if (!list.childElementCount) list.append(h('li', {}, 'All quiet in the kingdom.'));
    body.append(list);
    if (s.raids.length) {
      const btn = h('button', { class: 'btn sky', type: 'button' }, 'See defense replays');
      btn.addEventListener('click', () => {
        this.closeAllModals();
        this.openLog();
      });
      body.append(h('div', { class: 'actions' }, btn));
    }
    const close = this.modal('Welcome back!', body, [{ label: 'Great!', primary: true, onClick: () => close() }], 'normal', onClose);
  }

  // ------------------------------------------------------------ settings

  private openSettings(): void {
    const body = h('div', { class: 'settings' });

    // Save transfer
    const codeBox = h('textarea', { class: 'code', rows: 4, spellcheck: 'false', autocapitalize: 'off', placeholder: 'Paste a save code here to load a village from another device' }) as HTMLTextAreaElement;
    body.append(
      h('h3', {}, 'Your village'),
      h('p', { class: 'muted' }, this.deps.store.persistent ? 'Your village saves automatically on this device. To move it to another device, copy a save code here and load it there.' : 'This browser mode cannot save. Your village will be lost when you close the page.'),
      codeBox,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => this.exportSave(codeBox) }, 'Copy save code'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => this.importSave(codeBox.value) }, 'Load from code'),
      ),
    );

    body.append(this.econ.spendSection());

    // Display
    const fpsToggle = h('input', { type: 'checkbox', checked: this.showFps }) as HTMLInputElement;
    fpsToggle.addEventListener('change', () => {
      this.showFps = fpsToggle.checked;
      this.fpsEl.hidden = !this.showFps;
      try {
        localStorage.setItem('tk.showFps', this.showFps ? '1' : '0');
      } catch {
        /* ignore */
      }
    });
    const sfxToggle = h('input', { type: 'checkbox', checked: sound.settings.sfx }) as HTMLInputElement;
    sfxToggle.addEventListener('change', () => sound.setSfx(sfxToggle.checked));
    const musicToggle = h('input', { type: 'checkbox', checked: sound.settings.music }) as HTMLInputElement;
    musicToggle.addEventListener('change', () => sound.setMusic(musicToggle.checked));
    const prefs = this.deps.prefs;
    const breakToggle = h('input', { type: 'checkbox', checked: prefs.get('sessionReminder') }) as HTMLInputElement;
    breakToggle.addEventListener('change', () => prefs.set('sessionReminder', breakToggle.checked));
    const remindToggle = h('input', { type: 'checkbox', checked: prefs.get('reminders') }) as HTMLInputElement;
    const nd = this.c.data.notifications;
    const typeBox = h('div', { class: 'notify-types' });
    const typeToggles: HTMLInputElement[] = [];
    for (const t of nd.types) {
      const tg = h('input', { type: 'checkbox', checked: this.deps.notifyPrefs.get(t.id, t.default), disabled: !prefs.get('reminders') }) as HTMLInputElement;
      tg.addEventListener('change', () => this.deps.notifyPrefs.set(t.id, tg.checked));
      typeToggles.push(tg);
      typeBox.append(h('label', { class: 'toggle sub' }, tg, ` ${t.label}`));
    }
    const pad = (n: number) => `${String(n).padStart(2, '0')}:00`;
    typeBox.append(h('p', { class: 'muted small' }, `At most ${nd.maxPerDay} a day, and none between ${pad(nd.quietHours.start)} and ${pad(nd.quietHours.end)} (they wait until morning).`));
    remindToggle.addEventListener('change', () => {
      prefs.set('reminders', remindToggle.checked);
      for (const tg of typeToggles) tg.disabled = !remindToggle.checked;
      if (remindToggle.checked) void this.deps.onRemindersEnabled();
    });
    body.append(
      h('h3', {}, 'Sound'),
      h('label', { class: 'toggle' }, sfxToggle, ' Sound effects'),
      h('label', { class: 'toggle' }, musicToggle, ' Music'),
      h('h3', {}, 'Reminders and healthy play'),
      h('label', { class: 'toggle' }, remindToggle, ' Send me notifications (off until you turn it on)'),
      typeBox,
      h('label', { class: 'toggle' }, breakToggle, ' Suggest a break after an hour of play'),
      h('p', { class: 'muted small' }, this.deps.reminderNote),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { this.closeAllModals(); this.deps.onReplayTutorial(); } }, 'Replay the tutorial')),
      h('h3', {}, 'Display'),
      h('label', { class: 'toggle' }, fpsToggle, ' Show frame rate (fps)'),
    );

    // Testing tools
    const offsetText = () => (this.deps.debugTime.offsetMs() ? `Game clock is ${formatDuration(this.deps.debugTime.offsetMs())} ahead of real time.` : 'Game clock matches real time.');
    const offsetEl = h('p', { class: 'muted' }, offsetText());
    const events = h('div', { class: 'events' }, 'Loading…');
    body.append(
      h('h3', {}, 'Testing tools'),
      h('p', { class: 'muted' }, 'Skip time forward to test timers and offline progress. This moves this device’s game clock ahead permanently.'),
      offsetEl,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { this.deps.debugTime.skip(3_600_000); offsetEl.textContent = offsetText(); this.c.tick(); this.refresh(); } }, '+1 hour'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => this.simulateAway(8) }, 'Simulate 8 hours away'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => this.dropShield() }, 'Remove shield'),
      ),
      h('p', { class: 'muted small' }, 'New villages start with a 24-hour shield. Remove it, then simulate time away, to see raiders attack your village.'),
      h('details', {}, h('summary', {}, 'Analytics events (this device)'), events),
    );
    void this.deps.analytics.recent(60).then((list) => {
      clear(events);
      if (!list.length) events.append('No events yet.');
      for (const e of list) {
        events.append(h('div', { class: 'event' }, h('b', {}, e.name), ` ${new Date(e.at).toLocaleTimeString()} `, h('code', {}, JSON.stringify(e.props))));
      }
    });

    // Reset
    body.append(
      h('h3', {}, 'Start over'),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', onclick: () => this.resetVillage() }, 'Start a new village')),
      h('p', { class: 'muted small' }, `Toadstool Kingdoms ${this.deps.build.version} · built ${this.deps.build.builtAt}`),
    );
    this.modal('Settings', body, [], 'wide');
  }

  private exportSave(box: HTMLTextAreaElement): void {
    void this.c.save();
    const code = encodeExportCode(serialize(this.c.state, this.c.now()));
    box.value = code;
    box.select();
    this.deps.analytics.log('save_export', { length: code.length });
    const done = () => this.toast('Save code copied. Paste it on your other device.', 'success');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(code).then(done, () => this.toast('Select the code and copy it.', 'info'));
    } else {
      try {
        document.execCommand('copy');
        done();
      } catch {
        this.toast('Select the code and copy it.', 'info');
      }
    }
  }

  private async importSave(code: string): Promise<void> {
    if (!code.trim()) {
      this.toast('Paste a save code first.', 'info');
      return;
    }
    let village;
    try {
      village = deserialize(decodeExportCode(code), this.c.data);
    } catch (e) {
      this.toast((e as Error).message, 'error');
      return;
    }
    const ok = await this.confirm('Load this village?', 'It will replace the village on this device. Copy a save code first if you want to keep this one.', 'Replace village', true);
    if (!ok) return;
    await this.c.replace(village);
    this.deps.analytics.log('save_import', {});
    this.closeAllModals();
    this.bus.emit('select', null);
    this.toast('Village loaded!', 'success');
  }

  private async simulateAway(hours: number): Promise<void> {
    await this.c.save();
    this.deps.debugTime.skip(hours * 3_600_000);
    location.reload();
  }

  private async dropShield(): Promise<void> {
    await this.c.replace({ ...this.c.state, shieldUntil: this.c.now() });
    this.toast('Shield removed. Raiders can now find your village while you are away.', 'info');
  }

  private async resetVillage(): Promise<void> {
    const ok = await this.confirm('Start a new village?', 'Your current village on this device will be deleted. This cannot be undone.', 'Delete and start over', true);
    if (!ok) return;
    await this.c.reset();
    this.closeAllModals();
    this.bus.emit('select', null);
    this.toast('A fresh kingdom awaits.', 'success');
  }

  // ------------------------------------------------------------ toasts and modals

  toast(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    if (kind === 'error') sound.play('error');
    const t = h('div', { class: `toast ${kind}` }, text);
    this.toasts.append(t);
    while (this.toasts.childElementCount > 3) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => t.classList.add('out'), 2600);
    window.setTimeout(() => t.remove(), 3000);
  }

  modal(
    title: string,
    body: HTMLElement,
    buttons: (false | undefined | null | { label: string; primary?: boolean; danger?: boolean; onClick: () => void })[] = [],
    size: 'normal' | 'wide' = 'normal',
    onClose?: () => void,
  ): () => void {
    const backdrop = h('div', { class: 'modal-backdrop' });
    let closed = false;
    sound.play('open');
    const close = () => {
      if (closed) return;
      closed = true;
      sound.play('close');
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      this.openModals.delete(close);
      onClose?.();
    };
    this.openModals.add(close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const footer = h('div', { class: 'modal-foot' });
    for (const b of buttons) {
      if (!b) continue;
      footer.append(h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, type: 'button', onclick: b.onClick }, b.label));
    }
    const panel = h(
      'div',
      { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon(icons.close))),
      h('div', { class: 'modal-body' }, body),
      footer.childElementCount ? footer : null,
    );
    backdrop.append(panel);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    this.modalRoot.append(backdrop);
    return close;
  }

  closeAllModals(): void {
    for (const close of [...this.openModals]) close();
  }

  confirm(title: string, message: string, confirmLabel: string, danger = false, cancelLabel = 'Keep it'): Promise<boolean> {
    return new Promise((resolve) => {
      let answer = false;
      const close = this.modal(
        title,
        h('p', {}, message),
        [
          { label: cancelLabel, onClick: () => close() },
          { label: confirmLabel, primary: !danger, danger, onClick: () => { answer = true; close(); } },
        ],
        'normal',
        // Closing with X, Escape or the backdrop counts as "no".
        () => resolve(answer),
      );
    });
  }
}
