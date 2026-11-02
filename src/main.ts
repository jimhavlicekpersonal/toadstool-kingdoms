import Phaser from 'phaser';
import './ui/styles.css';
import { Analytics, IdbEventStore, MemoryEventStore, type EventStore } from './analytics/events';
import { GameController } from './game/controller';
import { openGameDb } from './persist/idb';
import { IdbSaveStore, MemorySaveStore, type SaveStore } from './persist/saveStore';
import { registerServiceWorker } from './pwa/register';
import { Keys } from './render/assets';
import { VillageScene, type VillageSceneInit } from './render/VillageScene';
import { BattleScene } from './render/BattleScene';
import { App } from './app';
import { browserKeyValue, Connection, resolveServerUrl } from './net/connection';
import { LocalGroveSource, RemoteGroveSource, type GroveSource } from './game/groveSource';
import { sound } from './audio/sound';
import { notifyPrefs, prefs } from './platform/prefs';
import { WebReminders, type ReminderService } from './platform/reminders';
import { NativeReminders, isNative, platform } from './platform/native';
import { MockPaymentProvider, type PaymentProvider } from './payments/provider';
import { StoreKitPaymentProvider, UnavailablePaymentProvider } from './payments/storekit';
import { planNotifications, upcomingReminders } from './sim/reminders';
import { Tutorial } from './ui/tutorial';
import { OffsetClock, SystemClock } from './sim/clock';
import { defaultData } from './sim/data';
import { Bus, type UiEvents } from './ui/bus';
import { Hud } from './ui/hud';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

const DEBUG_OFFSET_KEY = 'tk.debugTimeOffsetMs';

/** The testing tool's time skip, kept in localStorage so a reload keeps it. */
function createDebugTime() {
  let offset = 0;
  try {
    offset = Number(localStorage.getItem(DEBUG_OFFSET_KEY)) || 0;
  } catch {
    offset = 0;
  }
  return {
    offsetMs: () => offset,
    skip(ms: number) {
      offset += ms;
      try {
        localStorage.setItem(DEBUG_OFFSET_KEY, String(offset));
      } catch {
        /* storage blocked: the skip lasts until reload */
      }
    },
  };
}

function platformName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac/.test(ua)) return 'mac';
  return 'other';
}

async function openStorage(): Promise<{ store: SaveStore; events: EventStore }> {
  try {
    const db = await openGameDb();
    const events = new IdbEventStore(db);
    void events.prune().catch(() => undefined);
    // Ask the browser not to evict our save (granted automatically for installed apps on most browsers).
    void navigator.storage?.persist?.().catch(() => undefined);
    return { store: new IdbSaveStore(db), events };
  } catch (e) {
    console.warn('Falling back to in-memory storage', e);
    return { store: new MemorySaveStore(), events: new MemoryEventStore() };
  }
}

async function boot(): Promise<void> {
  const debugTime = createDebugTime();
  const clock = new OffsetClock(new SystemClock(), debugTime.offsetMs);
  const { store, events } = await openStorage();
  const analytics = new Analytics(events, clock);
  // Payments: StoreKit on iPhone, nothing yet on Android, a mock store on the web.
  const storeKit = platform() === 'ios' ? new StoreKitPaymentProvider() : null;
  const payments: PaymentProvider = storeKit ?? (platform() === 'android' ? new UnavailablePaymentProvider() : new MockPaymentProvider(() => clock.now()));
  // Online play: the server chosen in Settings, else the one built into this version (VITE_SERVER_URL).
  const builtInUrl = (import.meta.env.VITE_SERVER_URL as string | undefined) || '';
  // With a server, real players raid this village instead of bots.
  const serverUrl = resolveServerUrl(browserKeyValue, builtInUrl);
  const { controller, offline, isNew, loadError } = await GameController.start({ clock, store, analytics, data: defaultData, payments, botRaids: !serverUrl });
  const connection = new Connection({ game: controller, builtInUrl });
  const groveSource: GroveSource = connection.enabled ? new RemoteGroveSource(controller, connection) : new LocalGroveSource(controller);
  if (storeKit) {
    void storeKit.listen((productId, transactionId) => {
      const r = controller.dispatch({ type: 'grantPurchase', productId, transactionId });
      if (r.ok) analytics.log('purchase', { productId, transactionId, provider: 'storekit', deferred: true });
    });
  }
  analytics.log('session_start', { isNew, awayMs: offline?.awayMs ?? 0, platform: platformName(), standalone: matchMedia('(display-mode: standalone)').matches });

  const host = document.getElementById('game')!;
  const renderScale = Math.min(window.devicePixelRatio || 1, 2);
  const size = () => ({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) });
  const { w, h } = size();
  const bus = new Bus<UiEvents>();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: host,
    backgroundColor: '#6fcdee',
    banner: false,
    disableContextMenu: true,
    scale: { mode: Phaser.Scale.NONE, width: w * renderScale, height: h * renderScale, zoom: 1 / renderScale },
    render: { antialias: true, powerPreference: 'high-performance' },
    input: { activePointers: 3, mouse: { preventDefaultWheel: true } },
    fps: { target: 60 },
  });
  const init: VillageSceneInit = { controller, bus, renderScale };
  game.scene.add('village', VillageScene, true, init);
  game.scene.add('battle', BattleScene, false);

  const onResize = () => {
    const s = size();
    game.scale.resize(s.w * renderScale, s.h * renderScale);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

  const thumbs = new Map<string, string | null>();
  const thumbOf = (key: string): string | null => {
    if (!thumbs.has(key)) thumbs.set(key, game.textures.exists(key) ? (game.textures.getBase64(key) as string) : null);
    return thumbs.get(key) ?? null;
  };
  let app: App | null = null;
  let tutorial: Tutorial | null = null;
  const reminders: ReminderService = isNative() ? new NativeReminders() : new WebReminders();
  const hud = new Hud({
    root: document.getElementById('hud')!,
    controller,
    bus,
    analytics,
    store,
    thumbnail: (type) => thumbOf(Keys.buildingBase(type)),
    getFps: () => game.loop.actualFps,
    troopThumb: (type) => thumbOf(Keys.troop(type)),
    onAttack: () => app?.scout(false),
    onReplay: (record) => app?.replay(record),
    onGroveAttack: (target) => app?.groveAttack(target),
    prefs,
    notifyPrefs,
    onRemindersEnabled: async () => {
      const ok = await reminders.enable();
      if (!ok) {
        prefs.set('reminders', false);
        hud.toast('Notifications are blocked. You can allow them in your device settings.', 'error');
      }
    },
    reminderNote: reminders.note,
    onReplayTutorial: () => tutorial?.restart(),
    debugTime,
    build: { version: __APP_VERSION__, builtAt: __BUILD_TIME__ },
    groveSource,
    connection,
  });

  app = new App({
    game,
    controller,
    hud,
    hudRoot: document.getElementById('hud')!,
    battleRoot: document.getElementById('battle-hud')!,
    renderScale,
    troopThumb: (type) => thumbOf(Keys.troop(type)),
    connection,
    groveSource,
  });

  connection.start();

  if (new URLSearchParams(location.search).has('debug')) {
    // Testing hook, only with ?debug in the URL.
    (window as unknown as Record<string, unknown>).tk = { game, controller, app, connection };
  }

  if (offline) {
    hud.showWelcomeBack(offline, () => {
      if (offline.raids.some((r) => r.result.destruction >= 50)) controller.triggerOffer('heavy_defense_loss');
    });
  }
  if (loadError) hud.toast(`${loadError} A backup was kept and a new village started.`, 'error');
  if (!store.persistent) hud.toast('This browser mode cannot save your village.', 'error');
  tutorial = new Tutorial(controller, analytics, document.body);
  tutorial.start();

  // Sound: unlock on the first touch (iOS needs a gesture), tap clicks, event cues, music.
  document.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
  document.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest?.('button, [role="button"]')) sound.play('tap');
  }, { capture: true });
  controller.onEvents((events) => {
    for (const e of events) {
      if (e.kind === 'purchase_granted') sound.play('coin');
      else if (e.kind === 'skip_used') sound.play('magic');
      else if (e.kind === 'reward') sound.play('star');
      else if (e.kind === 'donation') sound.play('collect');
      else if (e.kind === 'upgrade_start' || e.kind === 'clear_start' || e.kind === 'train_start') sound.play('build');
    }
  });
  controller.onOffer(() => sound.play('notify'));
  sound.music('village');

  // Healthy play: one friendly break suggestion after an hour of play.
  let playedMs = 0;
  let lastTick = performance.now();
  let breakShown = false;
  window.setInterval(() => {
    const t = performance.now();
    if (document.visibilityState === 'visible') playedMs += t - lastTick;
    lastTick = t;
    if (!breakShown && prefs.get('sessionReminder') && playedMs >= 60 * 60_000) {
      breakShown = true;
      analytics.log('session_reminder', { minutes: Math.round(playedMs / 60_000) });
      hud.modal(
        'Time for a break?',
        Object.assign(document.createElement('p'), { textContent: "You've been playing for an hour. How about a stretch and a glass of water? Your Beaver Builders will keep working while you're away." }),
        [{ label: 'Keep playing', primary: true, onClick: () => hud.closeAllModals() }],
      );
    }
  }, 5000);

  // Autosave regularly and whenever the app goes to the background or closes.
  window.setInterval(() => void controller.save(), 15_000);
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    sound.suspend(hidden);
    if (hidden) {
      void controller.save();
      void connection.uploadBase();
      if (prefs.get('reminders')) {
        // Opt-in only: the player's chosen types, no quiet-hours pings, a daily cap.
        const gd = controller.data;
        const planned = planNotifications(upcomingReminders(controller.state, controller.now(), gd), notifyPrefs.enabledSet(gd.notifications.types), controller.now(), new Date().getTimezoneOffset(), gd);
        void reminders.schedule(planned);
      }
    } else {
      void reminders.cancelAll();
    }
  });
  window.addEventListener('pagehide', () => void controller.save());

  if (!isNative()) registerServiceWorker((text) => hud.toast(text, 'info'));
  document.getElementById('boot')?.classList.add('done');
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot');
  if (el) el.innerHTML = `<div class="err">Something went wrong starting the game.<br><small>${String((e as Error)?.message ?? e)}</small></div>`;
});
