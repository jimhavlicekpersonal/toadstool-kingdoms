/**
 * The Grove screen. It renders a GroveSnapshot from a GroveSource, so the
 * same screen shows the offline bot Grove or a real Grove on a server.
 * The Grove Lodge (donated troops) and raid history are village state.
 */
import type { GroveSnapshot, GroveSource } from '../game/groveSource';
import { reinforcementCapacity, reinforcementHousing } from '../sim/social/grove';
import { groveRaidChest } from '../sim/social/groveRaid';
import { hallLevel } from '../sim/village';
import { clear, h, icon } from './dom';
import type { UiKit } from './economyUi';
import { rewardChips } from './economyUi';
import { formatDuration, formatNumber } from './format';
import { icons } from './icons';

export interface GroveUiDeps {
  kit: UiKit;
  source: GroveSource;
  troopThumb(type: string): string | null;
  onGroveAttack(target: number): void;
}

type Tab = 'chat' | 'requests' | 'members' | 'raid';

export class GroveUi {
  private tab: Tab = 'chat';
  private busy = false;
  constructor(private readonly d: GroveUiDeps) {}

  private get c() {
    return this.d.kit.c;
  }

  private get src() {
    return this.d.source;
  }

  open(tab?: Tab): void {
    if (tab) this.tab = tab;
    const body = h('div', { class: 'grove' });
    let lastSig = '';
    const draw = (force = false) => {
      const snap = this.src.snapshot();
      const s = this.c.state;
      const sig = JSON.stringify([snap, s.army, s.grove.reinforcements, s.grove.raidHistory.length, this.tab, this.busy, Math.floor(this.c.now() / 30000)]);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      const keepInput = body.querySelector<HTMLInputElement>('input.text')?.value ?? '';
      const keepFocus = document.activeElement?.matches?.('.grove input.text') ?? false;
      clear(body);
      if (snap.loading) {
        body.append(h('p', { class: 'muted' }, 'Finding your Grove…'));
        return;
      }
      if (snap.error) body.append(h('div', { class: 'note error-note' }, `Can't reach the Grove right now: ${snap.error}`));
      if (!snap.joined) {
        this.joinScreen(body, snap, () => draw(true));
        return;
      }
      body.append(
        h(
          'div',
          { class: 'grove-head' },
          h('span', { class: 'grove-badge', style: `background:${snap.color}` }, icon(icons.leaf)),
          h('div', {}, h('b', {}, snap.name), h('div', { class: 'muted small' }, `${snap.members.length}${snap.kind === 'online' ? `/${snap.maxMembers}` : ''} members · your Grove level ${snap.level} (${formatNumber(snap.xp)} XP)${snap.kind === 'online' ? ' · online' : ''}`)),
        ),
      );
      const tabs: [Tab, string][] = [
        ['chat', 'Chat'],
        ['requests', `Troops${snap.requests.length ? ` (${snap.requests.length})` : ''}`],
        ['members', 'Members'],
        ['raid', 'Grove Raid'],
      ];
      body.append(
        h(
          'div',
          { class: 'shop-tabs' },
          ...tabs.map(([id, label]) => {
            const b = h('button', { type: 'button', class: id === this.tab ? 'on' : '' }, label);
            b.addEventListener('click', () => {
              this.tab = id;
              draw(true);
            });
            return b;
          }),
        ),
      );
      if (this.tab === 'chat') this.chatTab(body, snap, keepInput, keepFocus, () => draw(true));
      else if (this.tab === 'requests') this.requestsTab(body, snap, () => draw(true));
      else if (this.tab === 'members') this.membersTab(body, snap, () => draw(true));
      else this.raidTab(body, snap);
    };
    draw(true);
    const timer = window.setInterval(() => draw(), 2000);
    const unsub = this.src.subscribe(() => draw());
    const stopWatch = this.src.watch();
    this.d.kit.modal('Grove', body, [], 'wide', () => {
      window.clearInterval(timer);
      unsub();
      stopWatch();
    });
  }

  /** Run a source action with a busy flag and a toast for the outcome. */
  private async run(action: () => Promise<{ ok: boolean; message?: string }>, redraw: () => void, quietOk = true): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    redraw();
    try {
      const r = await action();
      if (!r.ok) this.d.kit.toast(r.message ?? 'That did not work.', 'error');
      else if (r.message || !quietOk) this.d.kit.toast(r.message ?? 'Done!', 'success');
      return r.ok;
    } finally {
      this.busy = false;
      redraw();
    }
  }

  private joinScreen(body: HTMLElement, snap: GroveSnapshot, redraw: () => void): void {
    body.append(
      h('p', {}, 'Groves are friendly bands of kingdoms. Members chat, share troops and team up for the weekly Grove Raid.'),
      h('p', { class: 'muted small' }, 'Chat is always filtered to keep it friendly.'),
    );
    if (snap.kind === 'local') {
      const btn = h('button', { class: 'btn primary', type: 'button' }, 'Find a Grove and join');
      btn.addEventListener('click', () => void this.run(() => this.src.join(), redraw));
      body.append(h('div', { class: 'actions' }, btn));
      return;
    }
    // Online: real Groves to browse, or found a new one.
    const search = h('input', { class: 'text', type: 'search', maxlength: 24, placeholder: 'Search Groves…' }) as HTMLInputElement;
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.src.search(search.value);
    });
    body.append(h('div', { class: 'chat-input-row' }, search, h('button', { class: 'btn ghost', type: 'button', onclick: () => void this.src.search(search.value) }, 'Search')));
    if (!snap.listings.length) body.append(h('p', { class: 'muted' }, 'No Groves with free places right now. Found one and invite your friends!'));
    for (const g of snap.listings) {
      const join = h('button', { class: 'btn primary', type: 'button', disabled: this.busy }, 'Join');
      join.addEventListener('click', () => void this.run(() => this.src.join(g.id), redraw, false));
      body.append(
        h(
          'div',
          { class: 'log-row' },
          h('div', { class: 'row' }, h('span', { class: 'grove-badge', style: `background:${g.color}` }, icon(icons.leaf)), h('div', {}, h('b', {}, g.name), h('div', { class: 'muted small' }, `${g.members}/${g.maxMembers} members · about ${formatNumber(g.averageTrophies)} leaves`))),
          join,
        ),
      );
    }
    const name = h('input', { class: 'text', type: 'text', maxlength: 24, placeholder: 'Grove name' }) as HTMLInputElement;
    name.addEventListener('keydown', (e) => e.stopPropagation());
    const create = h('button', { class: 'btn sky', type: 'button', disabled: this.busy }, 'Found Grove');
    create.addEventListener('click', () => void this.run(() => this.src.create(name.value), redraw, false));
    body.append(h('h3', {}, 'Found your own Grove'), h('div', { class: 'chat-input-row' }, name, create));
  }

  private chatTab(body: HTMLElement, snap: GroveSnapshot, keep: string, keepFocus: boolean, redraw: () => void): void {
    const list = h('div', { class: 'chat-list' });
    for (const m of snap.chat.slice(-50)) {
      list.append(
        h(
          'div',
          { class: `chat-msg ${m.mine ? 'mine' : ''} ${m.kind}` },
          m.who ? h('span', { class: 'chat-who' }, m.who) : null,
          h('span', { class: 'chat-text' }, m.text),
          h('span', { class: 'chat-time' }, `${formatDuration(Math.max(0, this.c.now() - m.at))} ago`),
        ),
      );
    }
    if (!snap.chat.length) list.append(h('p', { class: 'muted' }, 'No messages yet. Say hello!'));
    const input = h('input', { class: 'text', type: 'text', maxlength: 160, placeholder: 'Say something nice…', value: keep }) as HTMLInputElement;
    const send = () => {
      const text = input.value;
      void this.run(() => this.src.send(text), redraw).then((ok) => {
        if (ok) {
          const el = body.querySelector<HTMLInputElement>('input.text');
          if (el) el.value = '';
        }
      });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') send();
    });
    body.append(list, h('div', { class: 'chat-input-row' }, input, h('button', { class: 'btn primary', type: 'button', onclick: send, disabled: this.busy }, 'Send')));
    window.setTimeout(() => {
      list.scrollTop = list.scrollHeight;
      if (keepFocus) input.focus();
    }, 0);
  }

  private requestsTab(body: HTMLElement, snap: GroveSnapshot, redraw: () => void): void {
    const s = this.c.state;
    const gd = this.c.data;
    const now = this.c.now();
    const cap = reinforcementCapacity(s, gd);
    const used = reinforcementHousing(s, gd);
    const rein = h('div', { class: 'army-row' });
    for (const [t, n] of Object.entries(s.grove.reinforcements)) {
      if (n <= 0) continue;
      const th = this.d.troopThumb(t);
      rein.append(h('span', { class: 'army-chip' }, th ? h('img', { src: th, alt: '' }) : null, `${gd.troops[t]?.name ?? t} ×${n}`));
    }
    const can = snap.ask;
    const ask = h('button', { class: 'btn sky', type: 'button', disabled: !can.ok || this.busy }, 'Ask for troops');
    ask.addEventListener('click', () => void this.run(() => this.src.ask(), redraw));
    body.append(
      h('h3', {}, 'Your Grove Lodge'),
      cap ? h('div', { class: 'progress-row' }, h('div', { class: 'progress' }, h('i', { style: `width:${(used / cap) * 100}%` })), h('span', {}, `${used}/${cap} donated troops`)) : h('p', { class: 'muted' }, 'Build a Grove Lodge (Elder Toadstool 2) to receive troops from friends.'),
      rein,
      h('div', { class: 'actions' }, ask, !can.ok ? h('span', { class: 'note' }, can.readyAt ? `Ask again in ${formatDuration(can.readyAt - now)}` : can.message) : ''),
      h('p', { class: 'muted small' }, snap.kind === 'online' ? 'Donated troops join your next battle and are used before your own. Every troop you donate earns Grove XP. Troops from friends arrive when they donate.' : 'Donated troops join your next battle and are used before your own. Every troop you donate earns Grove XP, and friends send troops back to fill your Lodge.'),
      h('h3', {}, 'Friends asking for troops'),
    );
    if (!snap.requests.length) body.append(h('p', { class: 'muted' }, 'No requests right now.'));
    for (const r of snap.requests) {
      const row = h('div', { class: 'log-row' }, h('div', {}, h('b', {}, r.name), h('div', { class: 'progress-row' }, h('div', { class: 'progress' }, h('i', { style: `width:${(r.filled / r.size) * 100}%` })), h('span', { class: 'small' }, `${r.filled}/${r.size}`))));
      const btns = h('div', { class: 'row' });
      for (const [t, n] of Object.entries(s.army)) {
        if (n <= 0) continue;
        const th = this.d.troopThumb(t);
        const b = h('button', { class: 'btn ghost donate-btn', type: 'button', title: `Donate ${gd.troops[t]?.name}`, disabled: this.busy }, th ? h('img', { src: th, alt: '' }) : null, `×${n}`);
        b.addEventListener('click', () => void this.run(() => this.src.donate(r.id, t), redraw));
        btns.append(b);
      }
      if (!btns.childElementCount) btns.append(h('span', { class: 'muted small' }, 'Train troops to donate.'));
      row.append(btns);
      body.append(row);
    }
  }

  private membersTab(body: HTMLElement, snap: GroveSnapshot, redraw: () => void): void {
    snap.members.forEach((r, i) => {
      body.append(
        h(
          'div',
          { class: `log-row${r.you ? ' current' : ''}` },
          h('div', {}, h('b', {}, `${i + 1}. ${r.name}`), h('div', { class: 'muted small' }, `${r.role} · Elder Toadstool ${r.hall}`)),
          h('div', { class: 'row' }, h('span', { class: `dot ${r.online ? 'on' : ''}` }), h('span', { class: 'chip' }, icon(icons.leaf), String(r.trophies))),
        ),
      );
    });
    if (snap.canLeave) {
      const leave = h('button', { class: 'btn danger', type: 'button', disabled: this.busy }, 'Leave Grove');
      leave.addEventListener('click', async () => {
        const ok = await this.d.kit.confirm('Leave this Grove?', 'You can join another Grove straight away. Troops in your Grove Lodge stay with you.', 'Leave', true);
        if (ok) void this.run(() => this.src.leave(), redraw);
      });
      body.append(h('div', { class: 'actions' }, leave));
    }
  }

  private raidTab(body: HTMLElement, snap: GroveSnapshot): void {
    const s = this.c.state;
    const gd = this.c.data;
    const now = this.c.now();
    const p = snap.raid;
    const hall = hallLevel(s, gd);
    if (p.phase !== 'live') {
      body.append(h('p', {}, `The next Grove Raid starts in ${formatDuration(p.nextStart - now)} and lasts ${gd.social.groveRaid.durationHours / 24} days. Every member gets ${gd.social.groveRaid.attacksPerMember} attacks; the best stars on each enemy base add up, and the Grove with more stars wins.`));
      if (snap.kind === 'online') body.append(h('p', { class: 'muted small' }, 'Your Grove is matched with a real Grove of similar size and strength, or with a band of wild bots when none is free. Only members who were in the Grove when the raid starts take part.'));
      const chest = (o: 'win' | 'draw' | 'loss') => {
        const { xp, ...c } = groveRaidChest(o, hall, gd);
        void xp;
        return rewardChips(c);
      };
      body.append(h('h3', {}, 'Reward chest'), h('p', { class: 'muted small' }, `Sized for your Elder Toadstool level ${hall}.`), h('div', {}, h('div', { class: 'row' }, h('b', {}, 'Win '), chest('win')), h('div', { class: 'row' }, h('b', {}, 'Draw '), chest('draw')), h('div', { class: 'row' }, h('b', {}, 'Loss '), chest('loss'))));
      const last = s.grove.raidHistory[s.grove.raidHistory.length - 1];
      if (last) body.append(h('h3', {}, 'Last Grove Raid'), h('p', {}, `${last.outcome === 'win' ? 'Victory' : last.outcome === 'draw' ? 'Draw' : 'Defeat'} · ${last.ours} – ${last.theirs} stars. Reward: `, rewardChips(last.reward)));
      return;
    }
    if (!p.enemyName) {
      body.append(h('p', { class: 'muted' }, 'Looking for an enemy Grove…'));
      return;
    }
    const left = p.attacksLeft;
    body.append(
      h('div', { class: 'raid-score' }, h('div', {}, h('b', {}, 'Us'), h('span', { class: 'big' }, `★ ${p.ours}`)), h('div', { class: 'muted' }, 'vs'), h('div', {}, h('b', {}, p.enemyName), h('span', { class: 'big' }, `★ ${p.theirs}`))),
      h('p', { class: 'muted small' }, p.eligible ? `Ends in ${formatDuration(p.end - now)} · You have ${left} attack${left === 1 ? '' : 's'} left.` : `Ends in ${formatDuration(p.end - now)} · You joined during this raid, so you can attack from next week.`),
      h('h3', {}, 'Enemy bases'),
    );
    for (const b of p.bases) {
      const starEl = h('span', { class: 'stars-mini' });
      for (let k = 0; k < 3; k++) starEl.append(h('span', { class: k < b.stars ? '' : 'off' }, '★'));
      const atk = h('button', { class: 'btn danger', type: 'button', disabled: left <= 0 || b.stars >= 3 }, 'Attack');
      atk.addEventListener('click', () => {
        this.d.kit.closeAllModals();
        this.d.onGroveAttack(b.index);
      });
      body.append(h('div', { class: 'log-row' }, h('div', {}, h('b', {}, `${b.index + 1}. ${b.name}`), h('div', { class: 'row' }, h('span', { class: 'muted small' }, `Elder Toadstool ${b.hall}`), starEl)), atk));
    }
  }
}
