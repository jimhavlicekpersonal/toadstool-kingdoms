import Phaser from 'phaser';
import { drainEvents, type BattleSession } from '../game/battleSession';
import { buildingDef } from '../sim/data';
import type { SimBuilding } from '../sim/battle/battle';
import { GROUND_PAD, Keys, TEX_SCALE, buildingOrigin, buildingScale, buildingTexture, ensureTextures, troopSize } from './assets';
import { CameraControl } from './cameraControl';
import { depthFor, footprintCenter, mapBounds, tileToWorld, worldToTile } from './iso';
import { debris } from './fx';
import { sound } from '../audio/sound';

export interface BattleHooks {
  selectedTroop(): string | null;
  deployFailed(reason: 'zone' | 'none' | 'empty'): void;
  deployed(): void;
}

export interface BattleSceneInit {
  session: BattleSession;
  hooks: BattleHooks;
  renderScale: number;
}

interface BView {
  image: Phaser.GameObjects.Image;
  bar: Phaser.GameObjects.Graphics;
  destroyed: boolean;
  lastHp: number;
}

interface TView {
  image: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  bar: Phaser.GameObjects.Graphics;
  dead: boolean;
  baseScale: number;
  lastHp: number;
}

const OVER = 1_000_000;
const AIR_HEIGHT = 46;

export class BattleScene extends Phaser.Scene {
  private session!: BattleSession;
  private hooks!: BattleHooks;
  private renderScale = 1;
  private cam!: CameraControl;
  private bviews: BView[] = [];
  private tviews: TView[] = [];
  private pviews = new Map<number, Phaser.GameObjects.Image>();
  private zone!: Phaser.GameObjects.Graphics;
  private zoneFade: Phaser.Tweens.Tween | null = null;

  constructor() {
    super('battle');
  }

  init(data: BattleSceneInit): void {
    this.session = data.session;
    this.hooks = data.hooks;
    this.renderScale = data.renderScale;
    this.bviews = [];
    this.tviews = [];
    this.pviews = new Map();
  }

  create(): void {
    const gd = this.session.data;
    ensureTextures(this, gd);
    const mapSize = gd.economy.mapSize;
    const mb = mapBounds(mapSize);
    this.add.image(mb.x - GROUND_PAD, mb.y - GROUND_PAD, Keys.ground).setOrigin(0, 0).setDepth(-10);
    this.addWaves(mapSize);
    this.cam = new CameraControl(this, {
      renderScale: this.renderScale,
      onTap: (x, y) => this.tryDeployAt(x, y, true),
      onHold: (x, y) => this.tryDeployAt(x, y, false),
      onZoom: () => this.rescaleOverlays(),
    });
    this.cam.setBounds(mb.x - 400, mb.y - 400, mb.width + 800, mb.height + 800);
    const cssW = this.scale.width / this.renderScale;
    this.cam.setZoom(Phaser.Math.Clamp(cssW / (18 * 64), 0.42, 1));
    const c = tileToWorld(mapSize / 2, mapSize / 2);
    this.cameras.main.centerOn(c.x, c.y);

    for (const b of this.session.sim.buildings) this.bviews.push(this.makeBuilding(b));
    this.zone = this.add.graphics().setDepth(-4).setAlpha(0);
    this.drawZone();
    if (this.session.mode !== 'replay') this.flashZone(2500);
  }

  private addWaves(mapSize: number): void {
    const mb = mapBounds(mapSize);
    let seed = 4242;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0, placed = 0; i < 400 && placed < 60; i++) {
      const x = mb.x - 380 + rand() * (mb.width + 760);
      const y = mb.y - 380 + rand() * (mb.height + 760);
      const t = worldToTile(x, y);
      if (t.tx > -3 && t.ty > -3 && t.tx < mapSize + 4 && t.ty < mapSize + 4) continue;
      placed++;
      const w = this.add.image(x, y, Keys.wave).setScale(0.5 + rand() * 0.4).setAlpha(0).setDepth(-20);
      this.tweens.add({ targets: w, alpha: { from: 0, to: 0.85 }, x: x + 10, duration: 1600 + rand() * 1800, delay: rand() * 2500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
  }

  private makeBuilding(b: SimBuilding): BView {
    const key = buildingTexture(this.textures, b.type, b.level, b.size);
    const tex = this.textures.get(key);
    const o = buildingOrigin(tex, b.size);
    const c = footprintCenter(b.x, b.y, b.size);
    const image = this.add.image(c.x, c.y, key).setOrigin(o.x, o.y).setScale(buildingScale(tex, b.size)).setDepth(depthFor(b.x, b.y, b.size));
    if (b.hidden) image.setVisible(false);
    const bar = this.add.graphics().setDepth(OVER - 10);
    return { image, bar, destroyed: false, lastHp: b.hp };
  }

  private drawZone(): void {
    const sim = this.session.sim;
    const n = sim.grid.size;
    const g = this.zone;
    g.clear();
    g.fillStyle(0xff5a6a, 0.22);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (sim.deployable[y * n + x]) continue;
        const p = [tileToWorld(x, y), tileToWorld(x + 1, y), tileToWorld(x + 1, y + 1), tileToWorld(x, y + 1)];
        g.fillPoints(p.map((q) => new Phaser.Math.Vector2(q.x, q.y)), true);
      }
    }
  }

  private flashZone(ms: number): void {
    this.zoneFade?.stop();
    this.zone.setAlpha(1);
    this.zoneFade = this.tweens.add({ targets: this.zone, alpha: 0, delay: ms, duration: 600 });
  }

  private tryDeployAt(wx: number, wy: number, isTap: boolean): void {
    const s = this.session;
    if (s.mode !== 'live' || s.sim.ended) return;
    const troop = this.hooks.selectedTroop();
    if (!troop) {
      if (isTap) this.hooks.deployFailed('none');
      return;
    }
    if ((s.sim.remaining[troop] ?? 0) <= 0) {
      if (isTap) this.hooks.deployFailed('empty');
      return;
    }
    const t = worldToTile(wx, wy);
    if (!s.tryDeploy(troop, t.tx, t.ty)) {
      if (isTap) {
        this.flashZone(1200);
        this.hooks.deployFailed('zone');
      }
      return;
    }
    this.hooks.deployed();
    sound.play('deploy');
    const p = tileToWorld(Math.floor(t.tx) + 0.5, Math.floor(t.ty) + 0.5);
    this.puff(p.x, p.y, 0.6);
  }

  private makeTroop(type: string, air: boolean): TView {
    const key = Keys.troop(type);
    const size = troopSize(type);
    const tex = this.textures.get(key);
    const src = tex.getSourceImage() as { width: number; height: number };
    const baseScale = (size.w / src.width) * 1.25;
    const image = this.add.image(0, 0, key).setOrigin(0.5, (size.h - 6) / size.h).setScale(baseScale);
    const shadow = this.add.image(0, 0, Keys.shadow).setScale((air ? 0.7 : 0.55) / TEX_SCALE).setDepth(-3).setAlpha(air ? 0.6 : 0.9);
    const bar = this.add.graphics().setDepth(OVER - 9);
    image.setScale(baseScale * 0.4);
    this.tweens.add({ targets: image, scale: baseScale, duration: 260, ease: 'Back.easeOut' });
    return { image, shadow, bar, dead: false, baseScale, lastHp: -1 };
  }

  private puff(x: number, y: number, scale: number): void {
    const p = this.add.image(x, y, Keys.puff).setScale((scale * 0.5) / TEX_SCALE).setDepth(OVER - 20).setAlpha(0.95);
    this.tweens.add({ targets: p, scale: (scale * 1.3) / TEX_SCALE, alpha: 0, y: y - 14, duration: 450, ease: 'Cubic.easeOut', onComplete: () => p.destroy() });
  }

  private stars(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const s = this.add.image(x, y, Keys.star).setScale(0.5 / TEX_SCALE).setDepth(OVER - 19);
      const a = (i / n) * Math.PI * 2 + Math.random();
      this.tweens.add({ targets: s, x: x + Math.cos(a) * 26, y: y + Math.sin(a) * 14 - 12, alpha: 0, angle: 180, duration: 500, ease: 'Cubic.easeOut', onComplete: () => s.destroy() });
    }
  }

  private rescaleOverlays(): void {
    // Bars are redrawn every frame using the current zoom.
  }

  private drawBar(g: Phaser.GameObjects.Graphics, x: number, y: number, frac: number, color: number): void {
    const z = this.cam.userZoom;
    const w = 34 / z;
    const h = 6 / z;
    g.clear();
    g.fillStyle(0x3a2350, 0.85);
    g.fillRoundedRect(x - w / 2 - 1.5 / z, y - h / 2 - 1.5 / z, w + 3 / z, h + 3 / z, (h + 3 / z) / 2);
    g.fillStyle(color, 1);
    g.fillRoundedRect(x - w / 2, y - h / 2, Math.max(h, w * frac), h, h / 2);
  }

  update(_time: number, delta: number): void {
    this.cam.update(delta);
    const s = this.session;
    s.update(delta);
    this.handleEvents();
    const sim = s.sim;
    const a = s.alpha();

    // Buildings: health bars and rubble.
    sim.buildings.forEach((b, i) => {
      const v = this.bviews[i];
      if (b.destroyed && !v.destroyed) {
        v.destroyed = true;
        v.bar.clear();
        if (b.kind === 'trap') {
          v.image.setVisible(false);
          return;
        }
        const c = footprintCenter(b.x, b.y, b.size);
        const key = Keys.rubble(b.size);
        const tex = this.textures.get(key);
        const o = buildingOrigin(tex, b.size);
        v.image.setTexture(key).setOrigin(o.x, o.y).setScale(buildingScale(tex, b.size)).setDepth(depthFor(b.x, b.y, b.size) - 5);
        this.puff(c.x, c.y - 10, b.size * 0.9);
        this.stars(c.x, c.y - 20, 5);
        if (b.kind !== 'hedge') {
          debris(this, c.x, c.y - 10, b.size, OVER - 18);
          sound.play('boom');
        } else sound.play('hit');
        if (b.kind !== 'hedge') this.cameras.main.shake(140, 0.0035 * Math.min(2, b.size / 2));
      } else if (!b.destroyed && b.hp < b.maxHp && b.kind !== 'hedge') {
        const top = v.image.y - v.image.displayHeight * v.image.originY;
        this.drawBar(v.bar, v.image.x, top - 6 / this.cam.userZoom, b.hp / b.maxHp, 0x6fd651);
      }
      v.lastHp = b.hp;
    });

    // Troops: create, interpolate, bob.
    while (this.tviews.length < sim.troops.length) {
      const t = sim.troops[this.tviews.length];
      this.tviews.push(this.makeTroop(t.type, t.air));
    }
    const now = this.time.now;
    sim.troops.forEach((t, i) => {
      const v = this.tviews[i];
      if (t.dead) {
        if (!v.dead) {
          v.dead = true;
          v.bar.clear();
          const ix = v.image.x;
          const iy = v.image.y;
          this.puff(ix, iy - 8, 0.5);
          this.tweens.add({ targets: [v.image, v.shadow], alpha: 0, duration: 300, onComplete: () => { v.image.destroy(); v.shadow.destroy(); v.bar.destroy(); } });
        }
        return;
      }
      const x = t.px + (t.x - t.px) * a;
      const y = t.py + (t.y - t.py) * a;
      const w = tileToWorld(x, y);
      const moving = t.x !== t.px || t.y !== t.py;
      const bob = t.air ? Math.sin(now / 220 + i) * 4 : moving ? -Math.abs(Math.sin(now / 90 + i)) * 3 : 0;
      const lift = t.air ? AIR_HEIGHT : 0;
      v.image.setPosition(w.x, w.y - lift + bob).setDepth(t.air ? OVER - 30 + y : depthFor(x - 0.5, y - 0.5, 1) + 1);
      v.image.setFlipX(t.facing < 0);
      if (t.attacking && !t.air) v.image.setScale(v.baseScale * (1 + Math.max(0, Math.sin(now / 60)) * 0.08), v.baseScale * (1 - Math.max(0, Math.sin(now / 60)) * 0.06));
      else if (v.image.scaleX !== v.baseScale && !this.tweens.isTweening(v.image)) v.image.setScale(v.baseScale);
      v.shadow.setPosition(w.x, w.y + 1);
      // Guardians (the base's defenders) get red health bars, attackers yellow.
      if (t.hp < t.maxHp) this.drawBar(v.bar, w.x, w.y - lift - 34, t.hp / t.maxHp, t.side === 'guard' ? 0xff6b5b : 0xffd23f);
    });

    // Projectiles.
    const alive = new Set<number>();
    for (const p of sim.projectiles) {
      alive.add(p.id);
      let img = this.pviews.get(p.id);
      if (!img) {
        img = this.add.image(0, 0, Keys.projectile(p.kind)).setScale(1 / TEX_SCALE).setDepth(OVER - 15);
        this.pviews.set(p.id, img);
      }
      const prog = Math.min(1, (p.total - p.left + a) / p.total);
      const x = p.fromX + (p.toX - p.fromX) * prog;
      const y = p.fromY + (p.toY - p.fromY) * prog;
      const w = tileToWorld(x, y);
      const startH = p.targetBuilding >= 0 ? 10 : 40;
      const arc = p.arc ? 4 * 70 * prog * (1 - prog) : 0;
      img.setPosition(w.x, w.y - startH * (1 - prog) - arc - 8);
      if (p.kind === 'pinecone' || p.kind === 'acorn' || p.kind === 'seedbomb') img.setAngle(prog * 360);
      if (p.kind === 'sting' || p.kind === 'feather') {
        const to = tileToWorld(p.toX, p.toY);
        img.setRotation(Math.atan2(to.y - w.y, to.x - w.x));
      }
    }
    for (const [id, img] of this.pviews) {
      if (alive.has(id)) continue;
      img.destroy();
      this.pviews.delete(id);
    }
  }

  private handleEvents(): void {
    const sim = this.session.sim;
    for (const e of drainEvents(this.session)) {
      if (e.k === 'hit') {
        sound.play('hit');
        const w = tileToWorld(e.x, e.y);
        if (e.splash > 0) {
          this.puff(w.x, w.y, 1 + e.splash);
          this.stars(w.x, w.y - 6, 4);
          if (e.kind === 'pinecone') this.cameras.main.shake(100, 0.003);
        } else {
          this.stars(w.x, w.y - 16, 2);
        }
      } else if (e.k === 'buildingHit') {
        const v = this.bviews[e.building];
        if (v && !v.destroyed && !this.tweens.isTweening(v.image)) {
          const sx = v.image.scaleX;
          const sy = v.image.scaleY;
          this.tweens.add({ targets: v.image, scaleX: sx * 1.03, scaleY: sy * 0.97, duration: 60, yoyo: true });
        }
      } else if (e.k === 'fire') {
        const v = this.bviews[e.building];
        if (v && !this.tweens.isTweening(v.image)) {
          const sy = v.image.scaleY;
          this.tweens.add({ targets: v.image, scaleY: sy * 0.94, duration: 70, yoyo: true });
        }
      } else if (e.k === 'guardian') {
        const t = sim.troops[e.troop];
        const w = tileToWorld(t.x, t.y);
        this.puff(w.x, w.y - 6, 0.7);
        sound.play('notify');
      } else if (e.k === 'deploy' && this.session.mode === 'replay') {
        sound.play('deploy');
      } else if (e.k === 'trap') {
        sound.play('boom');
        const b = sim.buildings[e.building];
        const v = this.bviews[e.building];
        v.image.setVisible(true).setAlpha(1);
        const c = footprintCenter(b.x, b.y, b.size);
        this.puff(c.x, c.y, 1.6);
        this.tweens.add({ targets: v.image, alpha: 0, delay: 400, duration: 400 });
      }
    }
    void buildingDef;
  }
}
