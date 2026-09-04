(() => {
  "use strict";

  const VERSION = "1.6.1";
  const ROOT_ID = "so-intel-overlay";
  const MAP_LAYER_ID = "so-intel-map-layer";
  const ENGINE_TOAST_ID = "so-intel-engine-toast";
  const ENGINE_FLASH_ID = "so-intel-engine-flash";
  const DRAWER_LAYOUT_CLASS = "so-intel-layout-active";
  const DRAWER_OPEN_CLASS = "so-intel-drawer-open";
  const STORE_KEY = "so-intel-overlay-v1";
  const LOCATION_TTL_MS = 30 * 60 * 1000;
  const XP_SAMPLE_BUCKET_MS = 60 * 1000;
  const XP_MIN_RATE_WINDOW_MS = 10 * 60 * 1000;
  const XP_ACTIVE_MAX_GAP_MS = 10 * 60 * 1000;
  const XP_ACTIVE_MIN_PAIR_MS = 20 * 1000;
  const RESOURCE_MIN_RATE_WINDOW_MS = 60 * 60 * 1000;
  const XP_ACTIVITIES = ["battling", "gathering", "crafting", "exploring"];
  const PVP_CORE_STATS = ["power", "precision", "evasion", "hull"];
  const PVP_CATALYST_STATS = ["defense", "armor_penetration", "lifesteal", "stun", "block", "dot", "precision", "evasion"];
  const PVP_CATALYST_INPUTS = PVP_CATALYST_STATS.map((stat) => `catalyst_${stat}`);
  const PVP_BUILD_STATS = [...PVP_CORE_STATS, ...PVP_CATALYST_INPUTS];
  const PVM_DAMAGE_TYPES = ["chemical", "electromagnetic", "energy", "explosive", "incendiary", "kinetic"];
  const PVM_NPCS = [
    { name: "brutes", location: "Belt", weakness: ["kinetic", "explosive"] },
    { name: "spectres", location: "Nebula", weakness: ["energy", "electromagnetic"] },
    { name: "glacials", location: "Icy Planet", weakness: ["explosive", "incendiary"] },
    { name: "machiners", location: "Asteroid", weakness: ["energy", "electromagnetic"] },
    { name: "scorchers", location: "Gas Planet", weakness: ["chemical", "kinetic"] },
    { name: "toxoids", location: "Crystal Planet", weakness: ["incendiary", "chemical"] },
    { name: "miners", location: "Rocky Planet", weakness: ["kinetic", "explosive"] },
    { name: "dusters", location: "Comet", weakness: ["electromagnetic", "chemical"] },
  ];
  const XP_WINDOWS = { "1h": 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, all: Infinity };
  const SYNC_IDLE_INTERVAL_MS = 15 * 60 * 1000;
  const SYNC_DIRTY_MIN_GAP_MS = 60 * 1000;
  const SYNC_DIRTY_DELAY_MS = 20 * 1000;
  const SYNC_HISTORY_DAYS = 30;
  const SYNC_OUTBOX_LIMIT = 1200;
  const SYSTEM_SYNC_BATCH_SIZE = 500;
  const BATTLE_SYNC_BATCH_SIZE = 3;
  const BATTLE_OUTBOX_LIMIT = 20;
  const BATTLE_OUTBOX_BYTES = 700000;
  const BATTLE_LOG_LIMIT = 5000;
  const BATTLE_SEEN_LIMIT = 1000;
  const FAVORITES_CLOCK_VERSION = 1;
  const SYSTEM_SYNC_VERSION = 3;
  const HISTORY_SYNC_VERSION = 2;
  const RESOURCE_HISTORY_VERSION = 2;
  const DEFAULT_SYNC_ENDPOINT = "https://stellar-odyssey-intel-sync.sthess28.workers.dev";
  const TAB_META = {
    nodes: ["Galaxy Intel", "Events, perfect resources and manual routes"],
    roster: ["Squad Operations", "Tracked players, stations and readiness"],
    profiles: ["Player Intel", "Profiles, levels, gear, pets and catalysts"],
    builds: ["Build & PvP Lab", "Compare profiles and test hypothetical bonuses"],
    pvm: ["NPC Combat Lab", "Official local simulation and stat optimization"],
    ops: ["Operations", "Personal timers, buffs and session recap"],
    xp: ["XP History", "Observed activity and experience rates"],
    ranks: ["Rankings", "Battle, gathering and resource comparisons"],
    alerts: ["Engine Alerts", "Cooldown-ready notification settings"],
    market: ["Market Intelligence", "Trends, volatility, alerts and holdings"],
    sync: ["Account Sync", "Steam-linked history across devices"],
    about: ["Rules & Privacy", "Passive-data boundaries and cache controls"],
  };

  if (window.__stellarOdysseyIntelOverlay) {
    window.__stellarOdysseyIntelOverlay.show();
    return { ok: true, version: VERSION, reused: true };
  }

  const safeParse = (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  const resourceSourceKind = (source) => {
    const label = String(source || "").trim().toLowerCase();
    if (["live", "live-profile", "live client stores"].includes(label)) return "live-profile";
    if (["profile", "public-profile", "official-profile", "shared-profile"].includes(label)) return label;
    if (label.includes("publicprofile")) return "public-profile";
    if (label.includes("official read-only api")) return "official-profile";
    if (label.includes("profile") || label === "shared companion database") return "profile";
    return "";
  };

  const cleanResourceHistory = (histories) => Object.fromEntries(Object.entries(histories || {}).map(([key, rows]) => {
    let highest = -Infinity;
    const clean = (Array.isArray(rows) ? rows : [])
      .map((row) => ({ ...row, at: Number(row?.at), value: Number(row?.value), source: resourceSourceKind(row?.source) }))
      .filter((row) => row.source && Number.isFinite(row.at) && Number.isFinite(row.value))
      .sort((a, b) => a.at - b.at)
      .filter((row) => {
        if (row.value < highest) return false;
        highest = Math.max(highest, row.value);
        return true;
      });
    return [key, clean];
  }).filter(([, rows]) => rows.length));

  const syncSampleKey = (row) => `${String(row?.username || "").trim().toLowerCase()}:${Math.floor(Number(row?.at || 0) / XP_SAMPLE_BUCKET_MS)}`;
  const coalesceSyncSamples = (rows) => {
    const unique = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = syncSampleKey(row);
      if (!key.startsWith(":") && Number(row?.at || 0) > 0) unique.set(key, row);
    }
    return [...unique.values()].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0)).slice(-SYNC_OUTBOX_LIMIT);
  };

  const saved = safeParse(localStorage.getItem(STORE_KEY), {}) || {};
  const migrateResourceHistory = Number(saved.sync?.resourceHistoryVersion || 0) < RESOURCE_HISTORY_VERSION;
  const savedFavorites = Array.isArray(saved.favorites) ? saved.favorites : [];
  const migrateFavoriteClock = savedFavorites.length > 0 && Number(saved.sync?.favoritesClockVersion || 0) < FAVORITES_CLOCK_VERSION;
  const migrateSystemSync = Number(saved.sync?.systemSyncVersion || 0) < SYSTEM_SYNC_VERSION;
  const hasSavedDrawerPreference = saved.drawerLayoutVersion === 1;
  const state = {
    tab: "nodes",
    open: hasSavedDrawerPreference ? saved.open === true : false,
    systems: saved.systems || {},
    nodeObservations: saved.nodeObservations && typeof saved.nodeObservations === "object" ? saved.nodeObservations : {},
    seen: saved.seen || {},
    profiles: saved.profiles || {},
    favorites: new Set(savedFavorites),
    locations: saved.locations || {},
    xpHistory: saved.xpHistory || {},
    resourceHistory: migrateResourceHistory ? cleanResourceHistory(saved.resourceHistory) : (saved.resourceHistory || {}),
    sharedSummaries: {
      xp: saved.sharedSummaries?.xp && typeof saved.sharedSummaries.xp === "object" ? saved.sharedSummaries.xp : {},
      resources: !migrateResourceHistory && saved.sharedSummaries?.resources && typeof saved.sharedSummaries.resources === "object" ? saved.sharedSummaries.resources : {},
    },
    resourceRankings: {
      rows: saved.resourceRankings?.rows || {},
      totalResults: Number.isFinite(Number(saved.resourceRankings?.totalResults)) ? Number(saved.resourceRankings.totalResults) : 0,
      capturedAt: Number.isFinite(Number(saved.resourceRankings?.capturedAt)) ? Number(saved.resourceRankings.capturedAt) : 0,
      currentRank: Number.isFinite(Number(saved.resourceRankings?.currentRank)) ? Number(saved.resourceRankings.currentRank) : 0,
      currentValue: Number.isFinite(Number(saved.resourceRankings?.currentValue)) ? Number(saved.resourceRankings.currentValue) : 0,
    },
    xpWindow: XP_WINDOWS[saved.xpWindow] ? saved.xpWindow : "24h",
    xpRateMode: saved.xpRateMode === "wall" ? "wall" : "active",
    selectedProfile: saved.selectedProfile || "",
    engineAlerts: {
      sound: saved.engineAlerts?.sound !== false,
      toast: saved.engineAlerts?.toast !== false,
      flash: saved.engineAlerts?.flash !== false,
      badge: saved.engineAlerts?.badge !== false,
      desktop: saved.engineAlerts?.desktop === true,
      volume: Number.isFinite(Number(saved.engineAlerts?.volume))
        ? Math.min(1, Math.max(0, Number(saved.engineAlerts.volume)))
        : 0.55,
      events: saved.engineAlerts?.events !== false,
      operations: saved.engineAlerts?.operations === true,
    },
    nodeFinder: {
      query: String(saved.nodeFinder?.query || ""),
      maxStops: Math.min(8, Math.max(1, Number(saved.nodeFinder?.maxStops || 4))),
    },
    waypoints: Array.isArray(saved.waypoints) ? saved.waypoints.slice(0, 30) : [],
    operations: saved.operations && typeof saved.operations === "object" ? saved.operations : {},
    session: saved.session && typeof saved.session === "object" ? saved.session : {
      startAt: Date.now(),
      lastActiveAt: Date.now(),
      baselineXp: {},
      baselineResources: null,
      baselineSeen: Object.keys(saved.seen || {}).length,
      baselinePerfect: Object.entries(saved.systems || {}).filter(([key, system]) => Number(saved.nodeObservations?.[key] || system?.verifiedAt || 0) > 0
        && (Array.isArray(system?.nodes) ? system.nodes : []).some((node) => Number(node?.quality) === 100)).length,
    },
    marketTools: {
      holdings: saved.marketTools?.holdings && typeof saved.marketTools.holdings === "object" ? saved.marketTools.holdings : {},
      alerts: saved.marketTools?.alerts && typeof saved.marketTools.alerts === "object" ? saved.marketTools.alerts : {},
      notified: saved.marketTools?.notified && typeof saved.marketTools.notified === "object" ? saved.marketTools.notified : {},
    },
    buildLab: {
      left: String(saved.buildLab?.left || ""),
      right: String(saved.buildLab?.right || ""),
      leftMods: saved.buildLab?.leftMods && typeof saved.buildLab.leftMods === "object" ? saved.buildLab.leftMods : { power: 0, precision: 0, evasion: 0, hull: 0 },
      rightMods: saved.buildLab?.rightMods && typeof saved.buildLab.rightMods === "object" ? saved.buildLab.rightMods : { power: 0, precision: 0, evasion: 0, hull: 0 },
      presets: Array.isArray(saved.buildLab?.presets) ? saved.buildLab.presets.slice(0, 20) : [],
      imports: saved.buildLab?.imports && typeof saved.buildLab.imports === "object" ? saved.buildLab.imports : {},
    },
    pvmLab: {
      npc: String(saved.pvmLab?.npc || "brutes"),
      level: Math.max(1, Math.floor(Number(saved.pvmLab?.level || 1))),
      runs: [1000, 2500, 5000, 10000].includes(Number(saved.pvmLab?.runs)) ? Number(saved.pvmLab.runs) : 5000,
      threshold: Math.min(99.9, Math.max(50, Number(saved.pvmLab?.threshold || 98))),
      upperBound: Math.max(10, Math.floor(Number(saved.pvmLab?.upperBound || 10000))),
      budget: Math.max(4, Math.floor(Number(saved.pvmLab?.budget || 4))),
      baseline: saved.pvmLab?.baseline && typeof saved.pvmLab.baseline === "object" ? saved.pvmLab.baseline : null,
      build: saved.pvmLab?.build && typeof saved.pvmLab.build === "object" ? saved.pvmLab.build : null,
      result: saved.pvmLab?.result && typeof saved.pvmLab.result === "object" ? saved.pvmLab.result : null,
      maxResult: saved.pvmLab?.maxResult && typeof saved.pvmLab.maxResult === "object" ? saved.pvmLab.maxResult : null,
      optimizer: saved.pvmLab?.optimizer && typeof saved.pvmLab.optimizer === "object" ? saved.pvmLab.optimizer : null,
      loadedAt: Number(saved.pvmLab?.loadedAt || 0),
      engineStatus: "idle",
      engineSource: "",
      job: "idle",
      progress: 0,
      message: "Open the NPC lab to load the official local combat engine",
    },
    officialApi: {
      available: Boolean(window.__soIntelNativeBridge?.baseUrl && window.__soIntelNativeBridge?.token),
      configured: false,
      status: window.__soIntelNativeBridge?.baseUrl ? "checking" : "upgrade",
      message: window.__soIntelNativeBridge?.baseUrl ? "Checking official API setup" : "Launcher 1.1.0 or newer is required",
      launcherVersion: String(window.__soIntelNativeBridge?.launcherVersion || ""),
      busy: false,
      lastRefreshAt: Number(saved.officialApi?.lastRefreshAt || 0),
      jumps: Number(saved.officialApi?.jumps || 0),
      journalSystems: Number(saved.officialApi?.journalSystems || 0),
      market: Array.isArray(saved.officialApi?.market) ? saved.officialApi.market.slice(0, 200) : [],
      stations: Array.isArray(saved.officialApi?.stations) ? saved.officialApi.stations.slice(0, 500) : [],
      dungeons: Array.isArray(saved.officialApi?.dungeons) ? saved.officialApi.dungeons.slice(0, 200) : [],
      soloDungeons: Array.isArray(saved.officialApi?.soloDungeons) ? saved.officialApi.soloDungeons.slice(0, 200) : [],
      activeRunes: Array.isArray(saved.officialApi?.activeRunes) ? saved.officialApi.activeRunes.slice(0, 200) : [],
      passiveEvents: Array.isArray(saved.officialApi?.passiveEvents) ? saved.officialApi.passiveEvents.slice(0, 100) : [],
      knownEventKeys: Array.isArray(saved.officialApi?.knownEventKeys) ? saved.officialApi.knownEventKeys.slice(-500) : [],
      caches: saved.officialApi?.caches && typeof saved.officialApi.caches === "object" ? saved.officialApi.caches : {},
    },
    sync: {
      enabled: saved.sync?.enabled === true,
      endpoint: String(saved.sync?.endpoint || DEFAULT_SYNC_ENDPOINT),
      token: String(saved.sync?.token || ""),
      authMode: saved.sync?.authMode === "steam" ? "steam" : "code",
      linkRequest: saved.sync?.linkRequest && typeof saved.sync.linkRequest === "object" ? saved.sync.linkRequest : null,
      favoritesUpdatedAt: Number(saved.sync?.favoritesUpdatedAt || 0),
      favoritesClockVersion: FAVORITES_CLOCK_VERSION,
      lastPushAt: Number(saved.sync?.lastPushAt || 0),
      lastPullAt: Number(saved.sync?.lastPullAt || 0),
      summaryPulledAt: migrateResourceHistory ? 0 : Number(saved.sync?.summaryPulledAt || 0),
      summaryPlayerSet: String(saved.sync?.summaryPlayerSet || ""),
      historyCursors: !migrateResourceHistory && Number(saved.sync?.historySyncVersion || 0) >= HISTORY_SYNC_VERSION && saved.sync?.historyCursors && typeof saved.sync.historyCursors === "object" ? saved.sync.historyCursors : {},
      historySyncVersion: HISTORY_SYNC_VERSION,
      resourceHistoryVersion: RESOURCE_HISTORY_VERSION,
      historyRequestKey: "",
      nextAttemptAt: Number(saved.sync?.nextAttemptAt || 0),
      failureCount: Number(saved.sync?.failureCount || 0),
      systemsPulledAt: Number(saved.sync?.systemsPulledAt || 0),
      outboxXp: coalesceSyncSamples(saved.sync?.outboxXp),
      outboxResources: coalesceSyncSamples(saved.sync?.outboxResources)
        .map((row) => ({ ...row, source: resourceSourceKind(row?.source) }))
        .filter((row) => row.source),
      outboxProfiles: saved.sync?.outboxProfiles && typeof saved.sync.outboxProfiles === "object" ? saved.sync.outboxProfiles : {},
      outboxSystems: Array.isArray(saved.sync?.outboxSystems)
        ? [...new Set(saved.sync.outboxSystems.map((value) => String(value || "")).filter(Boolean))].slice(-25000)
        : [],
      battleSharing: saved.sync?.battleSharing !== false,
      outboxBattles: Array.isArray(saved.sync?.outboxBattles)
        ? saved.sync.outboxBattles.filter((row) => row && /^[a-f0-9]{64}$/i.test(String(row.x || ""))).slice(-BATTLE_OUTBOX_LIMIT)
        : [],
      battleSeen: saved.sync?.battleSeen && typeof saved.sync.battleSeen === "object" ? saved.sync.battleSeen : {},
      battleModel: saved.sync?.battleModel && typeof saved.sync.battleModel === "object" ? saved.sync.battleModel : {},
      battleCaptured: Number(saved.sync?.battleCaptured || 0),
      lastBattleAt: Number(saved.sync?.lastBattleAt || 0),
      lastBattleKind: ["arena", "squadron"].includes(saved.sync?.lastBattleKind) ? saved.sync.lastBattleKind : "",
      systemSyncVersion: SYSTEM_SYNC_VERSION,
      status: "idle",
      message: saved.sync?.enabled ? "Waiting for the first sync" : "Shared sync is off",
      busy: false,
      authBusy: false,
    },
    engineCooldown: {
      phase: "idle",
      readyAt: 0,
      lastSeconds: null,
      lastObservedAt: 0,
      notifiedAt: 0,
      dismissed: false,
      testBadge: false,
    },
    selfProfileKey: "",
    squadMembers: [],
    dirty: false,
    lastPanelSignature: "",
  };

  if (migrateFavoriteClock) {
    state.sync.favoritesUpdatedAt = Date.now();
    state.dirty = true;
  }
  if (migrateSystemSync) {
    state.sync.systemsPulledAt = 0;
    state.sync.outboxSystems = [...new Set([...state.sync.outboxSystems, ...Object.keys(state.seen)])].slice(-25000);
    state.dirty = true;
  }

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const cleanLabel = (value) => String(value ?? "")
    .replace(/_level$/i, "")
    .replace(/_slot$/i, "")
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  const plain = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  };

  const finite = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const verifiedPerfectCount = () => Object.entries(state.systems).filter(([key, system]) => Number(state.nodeObservations[key] || system?.verifiedAt || 0) > 0
    && (Array.isArray(system?.nodes) ? system.nodes : []).some((node) => Number(node?.quality) === 100)).length;

  const compactNumber = (value) => {
    const number = finite(value);
    if (number === null) return String(value ?? "—");
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(number) >= 100000 ? "compact" : "standard" }).format(number);
  };

  const xpRateNumber = (value) => {
    const number = finite(value);
    if (number === null) return "—";
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
  };

  const markDirty = () => {
    state.dirty = true;
  };

  let syncWakeTimer = 0;
  let syncWakeAt = 0;
  const scheduleSharedSync = (delay = SYNC_DIRTY_DELAY_MS) => {
    if (!state.sync.enabled) return;
    const dueAt = Date.now() + delay;
    if (syncWakeTimer && syncWakeAt <= dueAt) return;
    if (syncWakeTimer) clearTimeout(syncWakeTimer);
    syncWakeAt = dueAt;
    syncWakeTimer = setTimeout(() => {
      syncWakeTimer = 0;
      syncWakeAt = 0;
      runSharedSync(false);
    }, delay);
  };

  let drawerResizeTimer = 0;
  const syncDrawerLayout = () => {
    const html = document.documentElement;
    const changed = html.classList.contains(DRAWER_OPEN_CLASS) !== state.open;
    html.classList.add(DRAWER_LAYOUT_CLASS);
    html.classList.toggle(DRAWER_OPEN_CLASS, state.open);
    if (!state.open) closeHeaderBoostPopover();
    if (!changed) return;
    clearTimeout(drawerResizeTimer);
    drawerResizeTimer = setTimeout(() => window.dispatchEvent(new Event("resize")), 240);
  };

  const persist = () => {
    if (!state.dirty) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: state.open,
        drawerLayoutVersion: 1,
        systems: state.systems,
        nodeObservations: state.nodeObservations,
        seen: state.seen,
        profiles: state.profiles,
        favorites: [...state.favorites],
        locations: state.locations,
        xpHistory: state.xpHistory,
        resourceHistory: state.resourceHistory,
        sharedSummaries: state.sharedSummaries,
        resourceRankings: state.resourceRankings,
        xpWindow: state.xpWindow,
        xpRateMode: state.xpRateMode,
        selectedProfile: state.selectedProfile,
        engineAlerts: state.engineAlerts,
        nodeFinder: state.nodeFinder,
        waypoints: state.waypoints.slice(0, 30),
        operations: state.operations,
        session: state.session,
        marketTools: state.marketTools,
        buildLab: state.buildLab,
        pvmLab: {
          npc: state.pvmLab.npc,
          level: state.pvmLab.level,
          runs: state.pvmLab.runs,
          threshold: state.pvmLab.threshold,
          upperBound: state.pvmLab.upperBound,
          budget: state.pvmLab.budget,
          baseline: state.pvmLab.baseline,
          build: state.pvmLab.build,
          result: state.pvmLab.result,
          maxResult: state.pvmLab.maxResult,
          optimizer: state.pvmLab.optimizer,
          loadedAt: state.pvmLab.loadedAt,
        },
        officialApi: {
          lastRefreshAt: state.officialApi.lastRefreshAt,
          jumps: state.officialApi.jumps,
          journalSystems: state.officialApi.journalSystems,
          market: state.officialApi.market.slice(0, 200),
          stations: state.officialApi.stations.slice(0, 500),
          dungeons: state.officialApi.dungeons.slice(0, 200),
          soloDungeons: state.officialApi.soloDungeons.slice(0, 200),
          activeRunes: state.officialApi.activeRunes.slice(0, 200),
          passiveEvents: state.officialApi.passiveEvents.slice(0, 100),
          knownEventKeys: state.officialApi.knownEventKeys.slice(-500),
          caches: state.officialApi.caches,
        },
        sync: {
          enabled: state.sync.enabled,
          endpoint: state.sync.endpoint,
          token: state.sync.token,
          authMode: state.sync.authMode,
          linkRequest: state.sync.linkRequest,
          favoritesUpdatedAt: state.sync.favoritesUpdatedAt,
          favoritesClockVersion: state.sync.favoritesClockVersion,
          lastPushAt: state.sync.lastPushAt,
          lastPullAt: state.sync.lastPullAt,
          summaryPulledAt: state.sync.summaryPulledAt,
          summaryPlayerSet: state.sync.summaryPlayerSet,
          historyCursors: state.sync.historyCursors,
          historySyncVersion: state.sync.historySyncVersion,
          resourceHistoryVersion: state.sync.resourceHistoryVersion,
          nextAttemptAt: state.sync.nextAttemptAt,
          failureCount: state.sync.failureCount,
          systemsPulledAt: state.sync.systemsPulledAt,
          outboxXp: state.sync.outboxXp.slice(-SYNC_OUTBOX_LIMIT),
          outboxResources: state.sync.outboxResources.slice(-SYNC_OUTBOX_LIMIT),
          outboxProfiles: state.sync.outboxProfiles,
          outboxSystems: state.sync.outboxSystems.slice(-25000),
          battleSharing: state.sync.battleSharing,
          outboxBattles: state.sync.outboxBattles.slice(-BATTLE_OUTBOX_LIMIT),
          battleSeen: state.sync.battleSeen,
          battleModel: state.sync.battleModel,
          battleCaptured: state.sync.battleCaptured,
          lastBattleAt: state.sync.lastBattleAt,
          lastBattleKind: state.sync.lastBattleKind,
          systemSyncVersion: state.sync.systemSyncVersion,
        },
      }));
      state.dirty = false;
    } catch (error) {
      console.warn("[SO Intel] Could not persist local cache", error);
    }
  };

  const getApp = () => document.querySelector("#q-app")?.__vue_app__;
  const getPinia = () => getApp()?.config?.globalProperties?.$pinia;

  let pvmEnginePromise = null;
  let pvmJobToken = 0;

  const refreshPvmPanel = () => {
    state.lastPanelSignature = "";
    renderPanel();
  };

  const pvmClamp = (value, minimum, maximum, fallback = minimum) => {
    const number = finite(value);
    return number === null ? fallback : Math.min(maximum, Math.max(minimum, number));
  };

  const pvmDamageTypes = (value) => {
    const entries = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.entries(value).filter(([, enabled]) => enabled).map(([key]) => key)
        : [];
    return [...new Set(entries.map((entry) => String(entry || "").toLowerCase()).filter((entry) => PVM_DAMAGE_TYPES.includes(entry)))].slice(0, 2);
  };

  const pvmSafeBuild = (value) => {
    if (!value || typeof value !== "object") return null;
    const clones = (Array.isArray(value.clones) ? value.clones : []).slice(0, 100).map((clone, index) => ({
      name: `Clone ${index + 1}`,
      critical_chance: pvmClamp(clone?.critical_chance, 0, 100000, 0),
      critical_damage: pvmClamp(clone?.critical_damage, 0, 100000, 0),
      dual_shot: pvmClamp(clone?.dual_shot, 0, 100000, 0),
    }));
    const catalysts = Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, pvmClamp(value.catalysts?.[stat], 0, 100000, 0)]));
    return {
      power: pvmClamp(value.power, 0, 1e15, 0),
      precision: pvmClamp(value.precision, 0, 1e15, 0),
      evasion: pvmClamp(value.evasion, 0, 1e15, 0),
      hull: pvmClamp(value.hull, 0, 1e15, 0),
      weaponValue: pvmClamp(value.weaponValue, 0, 1e15, 0),
      shieldValue: pvmClamp(value.shieldValue, 0, 1e15, 0),
      weaponType1: PVM_DAMAGE_TYPES.includes(value.weaponType1) ? value.weaponType1 : "",
      weaponType2: PVM_DAMAGE_TYPES.includes(value.weaponType2) && value.weaponType2 !== value.weaponType1 ? value.weaponType2 : "",
      shieldType1: PVM_DAMAGE_TYPES.includes(value.shieldType1) ? value.shieldType1 : "",
      shieldType2: PVM_DAMAGE_TYPES.includes(value.shieldType2) && value.shieldType2 !== value.shieldType1 ? value.shieldType2 : "",
      weaponAnomaly: value.weaponAnomaly === true,
      shieldAnomaly: value.shieldAnomaly === true,
      weaponBoost: pvmClamp(value.weaponBoost, 0, 100000, 0),
      hullBoost: pvmClamp(value.hullBoost, 0, 100000, 0),
      precisionBoost: pvmClamp(value.precisionBoost, 0, 100000, 0),
      evasionBoost: pvmClamp(value.evasionBoost, 0, 100000, 0),
      cloneCount: Math.floor(pvmClamp(value.cloneCount, 1, 100, Math.max(1, clones.length))),
      cloneCritOverride: value.cloneCritOverride === null || value.cloneCritOverride === undefined || String(value.cloneCritOverride).trim() === "" ? null : pvmClamp(value.cloneCritOverride, 0, 100000, 0),
      cloneCritDamageOverride: value.cloneCritDamageOverride === null || value.cloneCritDamageOverride === undefined || String(value.cloneCritDamageOverride).trim() === "" ? null : pvmClamp(value.cloneCritDamageOverride, 0, 100000, 0),
      cloneDualShotOverride: value.cloneDualShotOverride === null || value.cloneDualShotOverride === undefined || String(value.cloneDualShotOverride).trim() === "" ? null : pvmClamp(value.cloneDualShotOverride, 0, 100000, 0),
      ssBoost: pvmClamp(value.ssBoost, 0, 100000, 0),
      catalysts,
      clones: clones.length ? clones : [{ name: "Clone 1", critical_chance: 0, critical_damage: 0, dual_shot: 0 }],
    };
  };

  const pvmCurrentBuild = () => {
    const pinia = getPinia();
    const user = pinia?._s?.get("UserStore");
    const player = user?.player;
    const ship = pinia?._s?.get("ShipStore");
    if (!player?.stats || !ship) return null;
    const slots = ["weapon_slot", "shield_slot", "laser_slot", "probes_slot", "engine_slot", "sensors_slot"].map((slot) => ship[slot]).filter(Boolean);
    const catalystsStore = pinia._s.get("CatalystStore");
    let catalystBonuses = {};
    try {
      catalystBonuses = plain(catalystsStore?.getEquippedBonusesForShip?.(slots, "default")) || {};
    } catch (error) {
      console.warn("[SO Intel] Could not read the current catalyst bonus summary", error);
    }
    const clones = (Array.isArray(player.clones) ? player.clones : []).slice(0, 100).map((clone, index) => ({
      name: `Clone ${index + 1}`,
      critical_chance: finite(clone?.critical_chance) || 0,
      critical_damage: finite(clone?.critical_damage) || 0,
      dual_shot: finite(clone?.dual_shot) || 0,
    }));
    const weaponTypes = pvmDamageTypes(ship.weapon_slot?.bonuses);
    const shieldTypes = pvmDamageTypes(ship.shield_slot?.bonuses);
    const squad = pinia._s.get("squadronStore");
    return pvmSafeBuild({
      power: player.stats.power,
      precision: player.stats.precision,
      evasion: player.stats.evasion,
      hull: player.stats.hull,
      weaponValue: ship.weapon_slot?.value,
      shieldValue: ship.shield_slot?.value,
      weaponType1: weaponTypes[0] || "",
      weaponType2: weaponTypes[1] || "",
      shieldType1: shieldTypes[0] || "",
      shieldType2: shieldTypes[1] || "",
      weaponAnomaly: ship.weapon_slot?.anomaly === true,
      shieldAnomaly: ship.shield_slot?.anomaly === true,
      weaponBoost: player.skills?.battling_weapon_boost,
      hullBoost: player.skills?.battling_hull_boost,
      precisionBoost: player.skills?.battling_precision_boost,
      evasionBoost: player.skills?.battling_evasion_boost,
      cloneCount: Math.max(1, clones.length),
      cloneCritOverride: null,
      cloneCritDamageOverride: null,
      cloneDualShotOverride: null,
      ssBoost: squad?.effectiveSSBattlingBoost,
      catalysts: Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, finite(catalystBonuses[stat]) || 0])),
      clones,
    });
  };

  const pvmContext = (buildValue) => {
    const build = pvmSafeBuild(buildValue);
    if (!build) return null;
    const sourceClones = build.clones;
    const average = (field) => sourceClones.reduce((sum, clone) => sum + (finite(clone[field]) || 0), 0) / Math.max(1, sourceClones.length);
    const clones = Array.from({ length: build.cloneCount }, (_, index) => {
      const source = sourceClones[index] || {
        critical_chance: average("critical_chance"),
        critical_damage: average("critical_damage"),
        dual_shot: average("dual_shot"),
      };
      return {
        name: `Clone ${index + 1}`,
        critical_chance: build.cloneCritOverride ?? source.critical_chance,
        critical_damage: build.cloneCritDamageOverride ?? source.critical_damage,
        dual_shot: build.cloneDualShotOverride ?? source.dual_shot,
      };
    });
    return {
      stats: { power: build.power, precision: build.precision, evasion: build.evasion, hull: build.hull, available: 0 },
      skills: {
        battling_weapon_boost: build.weaponBoost,
        battling_hull_boost: build.hullBoost,
        battling_precision_boost: build.precisionBoost,
        battling_evasion_boost: build.evasionBoost,
      },
      ship: {
        weapon_slot: { value: build.weaponValue, bonuses: [build.weaponType1, build.weaponType2].filter(Boolean), anomaly: build.weaponAnomaly },
        shield_slot: { value: build.shieldValue, bonuses: [build.shieldType1, build.shieldType2].filter(Boolean), anomaly: build.shieldAnomaly },
        laser_slot: null,
        probes_slot: null,
        engine_slot: null,
        sensors_slot: null,
      },
      clones,
    };
  };

  const pvmInvalidateResults = () => {
    state.pvmLab.result = null;
    state.pvmLab.maxResult = null;
    state.pvmLab.optimizer = null;
    if (state.pvmLab.job !== "idle") pvmJobToken += 1;
    state.pvmLab.job = "idle";
    state.pvmLab.progress = 0;
    state.pvmLab.message = "Inputs changed — run the local simulator to refresh results";
  };

  const loadCurrentPvmBuild = (notify = true) => {
    const build = pvmCurrentBuild();
    if (!build) {
      state.pvmLab.message = "Your live NPC build is not available yet";
      if (notify) showEngineToast(state.pvmLab.message, true);
      refreshPvmPanel();
      return false;
    }
    const battle = getPinia()?._s?.get("BattleStore");
    const npc = String(battle?.currentNPC || battle?.lastNPC || state.pvmLab.npc || "brutes").toLowerCase();
    if (PVM_NPCS.some((row) => row.name === npc)) state.pvmLab.npc = npc;
    const level = Math.floor(finite(battle?.currentNPCLevel) || state.pvmLab.level || 1);
    state.pvmLab.level = Math.max(1, level);
    state.pvmLab.baseline = plain(build);
    state.pvmLab.build = plain(build);
    state.pvmLab.loadedAt = Date.now();
    state.pvmLab.budget = Math.max(4, Math.floor(build.power + build.precision + build.evasion + build.hull + (finite(getPinia()?._s?.get("UserStore")?.player?.stats?.available) || 0)));
    state.pvmLab.upperBound = Math.min(10000000, Math.max(state.pvmLab.upperBound, state.pvmLab.level * 2, state.pvmLab.budget * 5, 1000));
    pvmInvalidateResults();
    state.pvmLab.message = "Current live build loaded as the comparison baseline";
    markDirty();
    refreshPvmPanel();
    if (notify) showEngineToast("Current NPC build loaded", true);
    return true;
  };

  const loadPvmEngine = async () => {
    if (pvmEnginePromise) return pvmEnginePromise;
    state.pvmLab.engineStatus = "loading";
    state.pvmLab.message = "Loading the official local NPC combat engine";
    pvmEnginePromise = (async () => {
      const mainUrl = [...document.scripts].map((script) => script.src).find((url) => /\/assets\/index-[^/]+\.js(?:$|\?)/.test(url));
      if (!mainUrl) throw new Error("The game client bundle could not be located");
      const gameModule = await import(mainUrl);
      const library = typeof gameModule.yt === "function" ? gameModule.yt() : null;
      if (!library || typeof library.simulateBattle !== "function" || typeof library.findMaxLevelAtThreshold !== "function" || typeof library.findOptimalBuild !== "function" || !Array.isArray(library.battlingNPCs)) {
        throw new Error("The game updated its local combat-library interface");
      }
      state.pvmLab.engineStatus = "ready";
      state.pvmLab.engineSource = decodeURIComponent(mainUrl.split("/").pop()?.split("?")[0] || "game client");
      if (state.pvmLab.job === "idle") state.pvmLab.message = "Official local NPC engine ready";
      refreshPvmPanel();
      return library;
    })().catch((error) => {
      pvmEnginePromise = null;
      state.pvmLab.engineStatus = "error";
      state.pvmLab.message = String(error?.message || "The official local NPC engine is unavailable");
      refreshPvmPanel();
      throw error;
    });
    return pvmEnginePromise;
  };

  const pvmRng = (seed) => {
    let value = seed >>> 0;
    return () => {
      value += 0x6D2B79F5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  };

  const pvmNpcFromEngine = (engine) => engine.battlingNPCs.find((row) => row.name === state.pvmLab.npc) || engine.battlingNPCs[0];
  const pvmCatalysts = (build) => Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, finite(build?.catalysts?.[stat]) || 0]));

  const pvmSimulationSummary = async (engine, context, build, npc, level, runs, seed, progressStart, progressSpan, token) => {
    let wins = 0;
    let timeouts = 0;
    let rounds = 0;
    let cloneHpPercent = 0;
    const rng = pvmRng(seed);
    const chunkSize = 200;
    for (let offset = 0; offset < runs; offset += chunkSize) {
      if (token !== pvmJobToken) throw new Error("Simulation cancelled because the inputs changed");
      const end = Math.min(runs, offset + chunkSize);
      for (let index = offset; index < end; index += 1) {
        const result = engine.simulateBattle(context, { npc, level, ssBoost: build.ssBoost, catalystBonuses: pvmCatalysts(build), rng });
        if (result.win === "player") wins += 1;
        if (!result.win) timeouts += 1;
        rounds += finite(result.round) || 0;
        const clones = Array.isArray(result.clones) ? result.clones : [];
        const maximum = clones.reduce((sum, clone) => sum + Math.max(0, finite(clone.maxHp) || 0), 0);
        const remaining = clones.reduce((sum, clone) => sum + Math.max(0, finite(clone.hp) || 0), 0);
        cloneHpPercent += maximum > 0 ? remaining / maximum * 100 : 0;
      }
      state.pvmLab.progress = progressStart + progressSpan * (end / runs);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      runs,
      wins,
      losses: runs - wins - timeouts,
      timeouts,
      winRate: wins / runs * 100,
      averageRounds: rounds / runs,
      averageCloneHpPercent: cloneHpPercent / runs,
    };
  };

  const runPvmComparison = async () => {
    if (!state.pvmLab.baseline || !state.pvmLab.build) loadCurrentPvmBuild(false);
    if (!state.pvmLab.baseline || !state.pvmLab.build) return;
    const token = ++pvmJobToken;
    state.pvmLab.job = "simulating";
    state.pvmLab.progress = 0;
    state.pvmLab.message = "Running matched-seed current and test simulations";
    refreshPvmPanel();
    try {
      const engine = await loadPvmEngine();
      const npc = pvmNpcFromEngine(engine);
      const level = Math.max(1, Math.floor(state.pvmLab.level));
      const runs = state.pvmLab.runs;
      const baseline = pvmSafeBuild(state.pvmLab.baseline);
      const test = pvmSafeBuild(state.pvmLab.build);
      const seed = (0x51A7E11 ^ level ^ runs ^ state.pvmLab.npc.length) >>> 0;
      const baselineResult = await pvmSimulationSummary(engine, pvmContext(baseline), baseline, npc, level, runs, seed, 0, 0.48, token);
      const testResult = await pvmSimulationSummary(engine, pvmContext(test), test, npc, level, runs, seed, 0.52, 0.48, token);
      if (token !== pvmJobToken) return;
      state.pvmLab.result = { npc: npc.name, level, runs, baseline: baselineResult, test: testResult, at: Date.now() };
      state.pvmLab.job = "idle";
      state.pvmLab.progress = 1;
      state.pvmLab.message = "Comparison complete using the game’s official local simulation rules";
      markDirty();
      refreshPvmPanel();
    } catch (error) {
      if (token !== pvmJobToken) return;
      state.pvmLab.job = "error";
      state.pvmLab.message = String(error?.message || "NPC comparison failed");
      refreshPvmPanel();
    }
  };

  const runPvmMaxScan = async () => {
    if (!state.pvmLab.baseline || !state.pvmLab.build) loadCurrentPvmBuild(false);
    if (!state.pvmLab.baseline || !state.pvmLab.build) return;
    const token = ++pvmJobToken;
    state.pvmLab.job = "scanning";
    state.pvmLab.progress = 0;
    state.pvmLab.message = "Finding the maximum NPC level for the selected win-rate target";
    refreshPvmPanel();
    try {
      const engine = await loadPvmEngine();
      const npc = pvmNpcFromEngine(engine);
      const baseline = pvmSafeBuild(state.pvmLab.baseline);
      const test = pvmSafeBuild(state.pvmLab.build);
      const options = (build, seed, start, span) => ({
        npc,
        ssBoost: build.ssBoost,
        catalystBonuses: pvmCatalysts(build),
        upperBound: state.pvmLab.upperBound,
        threshold: state.pvmLab.threshold,
        searchRuns: 1200,
        confirmRuns: Math.max(2000, Math.min(10000, state.pvmLab.runs)),
        seed,
        onProgress: (progress) => { if (token === pvmJobToken) state.pvmLab.progress = start + span * progress; },
      });
      const baselineResult = await engine.findMaxLevelAtThreshold(pvmContext(baseline), options(baseline, 19141, 0, 0.48));
      if (token !== pvmJobToken) return;
      const testResult = await engine.findMaxLevelAtThreshold(pvmContext(test), options(test, 19141, 0.52, 0.48));
      if (token !== pvmJobToken) return;
      state.pvmLab.maxResult = { npc: npc.name, threshold: state.pvmLab.threshold, upperBound: state.pvmLab.upperBound, baseline: baselineResult, test: testResult, at: Date.now() };
      state.pvmLab.job = "idle";
      state.pvmLab.progress = 1;
      state.pvmLab.message = "Maximum-level comparison complete";
      markDirty();
      refreshPvmPanel();
    } catch (error) {
      if (token !== pvmJobToken) return;
      state.pvmLab.job = "error";
      state.pvmLab.message = String(error?.message || "Maximum-level scan failed");
      refreshPvmPanel();
    }
  };

  const runPvmOptimizer = async () => {
    if (!state.pvmLab.build) loadCurrentPvmBuild(false);
    if (!state.pvmLab.build) return;
    const token = ++pvmJobToken;
    state.pvmLab.job = "optimizing";
    state.pvmLab.progress = 0;
    state.pvmLab.message = "Optimizing the four combat stats within your selected budget";
    refreshPvmPanel();
    try {
      const engine = await loadPvmEngine();
      const npc = pvmNpcFromEngine(engine);
      const test = pvmSafeBuild(state.pvmLab.build);
      const result = await engine.findOptimalBuild(pvmContext(test), {
        npc,
        budget: state.pvmLab.budget,
        ssBoost: test.ssBoost,
        catalystBonuses: pvmCatalysts(test),
        upperBound: state.pvmLab.upperBound,
        wrThreshold: state.pvmLab.threshold,
        searchRuns: 1200,
        confirmRuns: Math.max(2000, Math.min(10000, state.pvmLab.runs)),
        rng: pvmRng(77123),
        onProgress: (event) => {
          if (token !== pvmJobToken) return;
          const phase = String(event?.phase || "");
          state.pvmLab.progress = phase === "current-max" ? 0.08 : phase === "screening" ? 0.22 : phase === "refining" ? 0.35 + 0.45 * ((finite(event?.params?.current) || 0) / Math.max(1, finite(event?.params?.total) || 1)) : phase === "confirm" ? 0.92 : state.pvmLab.progress;
          state.pvmLab.message = phase === "refining" ? `Refining candidate ${event?.params?.current || 0} of ${event?.params?.total || 0}` : cleanLabel(phase || "optimizing");
        },
      });
      if (token !== pvmJobToken) return;
      state.pvmLab.optimizer = { ...plain(result), budget: state.pvmLab.budget, npc: npc.name, threshold: state.pvmLab.threshold, at: Date.now() };
      state.pvmLab.job = "idle";
      state.pvmLab.progress = 1;
      state.pvmLab.message = "Official stat-allocation optimization complete";
      markDirty();
      refreshPvmPanel();
    } catch (error) {
      if (token !== pvmJobToken) return;
      state.pvmLab.job = "error";
      state.pvmLab.message = String(error?.message || "NPC optimizer failed");
      refreshPvmPanel();
    }
  };

  const componentName = (component) => component?.type?.__name || component?.type?.name || "";

  const findComponent = (wantedName, start = document.querySelector("#q-app")?._vnode) => {
    const seen = new Set();
    let found = null;
    const visit = (vnode) => {
      if (!vnode || found || seen.has(vnode)) return;
      seen.add(vnode);
      const component = vnode.component;
      if (component) {
        if (componentName(component) === wantedName) {
          found = component;
          return;
        }
        visit(component.subTree);
      }
      if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
      if (vnode.suspense) visit(vnode.suspense.activeBranch);
    };
    visit(start);
    return found;
  };

  const findChildComponent = (parent, wantedName) => parent ? findComponent(wantedName, parent.subTree) : null;

  const directCoordinates = (object) => {
    if (!object || typeof object !== "object") return null;
    const candidates = [
      object,
      object.currentSystem,
      object.current_system,
      object.system,
      object.location,
      object.position,
      object.coordinates,
      object.player?.currentSystem,
      object.player?.system,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const x = finite(candidate.coordinate_x ?? candidate.x);
      const y = finite(candidate.coordinate_y ?? candidate.y);
      const z = finite(candidate.coordinate_z ?? candidate.z ?? 1);
      if (x !== null && y !== null) return { x, y, z: z ?? 1 };
    }
    return null;
  };

  const recordLocation = (username, coordinates, source) => {
    if (!username || !coordinates) return;
    state.locations[String(username).toLowerCase()] = {
      username: String(username),
      x: coordinates.x,
      y: coordinates.y,
      z: coordinates.z ?? 1,
      seenAt: Date.now(),
      source: String(source || "game client"),
    };
    markDirty();
  };

  const scanPlayerLocations = (value, source, depth = 0, visited = new WeakSet()) => {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => scanPlayerLocations(entry, source, depth + 1, visited));
      return;
    }
    const username = typeof value.username === "string"
      ? value.username
      : typeof value.user?.username === "string"
        ? value.user.username
        : typeof value.player?.username === "string"
          ? value.player.username
          : null;
    if (username) recordLocation(username, directCoordinates(value), source);
    for (const child of Object.values(value)) scanPlayerLocations(child, source, depth + 1, visited);
  };

  const primitiveMap = (value, limit = 36) => {
    const output = {};
    if (!value || typeof value !== "object") return output;
    for (const [key, entry] of Object.entries(plain(value) || {})) {
      if (Object.keys(output).length >= limit) break;
      if (["string", "number", "boolean"].includes(typeof entry) || entry === null) output[key] = entry;
    }
    return output;
  };

  const displayMap = (value, limit = 160) => {
    const output = {};
    if (!value || typeof value !== "object") return output;
    for (const [key, entry] of Object.entries(plain(value) || {})) {
      if (Object.keys(output).length >= limit) break;
      if (key.startsWith("_")) continue;
      if (["string", "number", "boolean"].includes(typeof entry) || entry === null) {
        output[key] = entry;
      } else if (entry && typeof entry === "object" && "$numberDecimal" in entry) {
        output[key] = finite(entry.$numberDecimal) ?? entry.$numberDecimal;
      }
    }
    return output;
  };

  const normalizeBonuses = (value) => {
    if (Array.isArray(value)) return Object.fromEntries(value.slice(0, 20).map((bonus, index) => [`bonus_${index + 1}`, bonus]));
    return primitiveMap(value || {}, 20);
  };

  // Mirrors the display-only catalyst formula used by the game client.
  const CATALYST_RARITY_MULTIPLIER = {
    normal: 1,
    uncommon: 1.5,
    rare: 2,
    unique: 2.5,
    epic: 3,
    legendary: 4,
  };
  const CATALYST_STAT_BASE = {
    defense: 10,
    armor_penetration: 10,
    lifesteal: 3,
    stun: 10,
    block: 10,
    dot: 10,
    precision: 5,
    evasion: 5,
    battling_xp: 10,
    battling_credits: 10,
    gathering_xp: 10,
    gathering_yield: 10,
    exploring_xp: 10,
    cosmic_dust_bonus: 10,
    crafting_xp: 10,
    crafting_scrap: 10,
    catalyst_drop_chance: 5,
    fuel_efficiency: 5,
    voyager_jumps_bonus: 2,
    base_upkeep_reduction: 5,
  };

  const catalystBonus = (catalyst) => {
    const stat = String(catalyst.stat ?? catalyst.name ?? catalyst.type ?? "").toLowerCase();
    const rarity = String(catalyst.rarity ?? "normal").toLowerCase();
    const quality = finite(catalyst.range ?? catalyst.quality ?? catalyst.value);
    const base = CATALYST_STAT_BASE[stat];
    const multiplier = CATALYST_RARITY_MULTIPLIER[rarity];
    if (base === undefined || multiplier === undefined || quality === null) return "";
    const value = base * multiplier * (quality / 100) * (catalyst.halved ? 0.5 : 1);
    return stat === "voyager_jumps_bonus" ? `+${value.toFixed(0)} jumps` : `+${value.toFixed(2)}%`;
  };

  const normalizeCatalysts = (value) => {
    const entries = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
    return entries.filter(Boolean).slice(0, 12).map((catalyst) => {
      const normalized = {
        stat: catalyst.stat ?? catalyst.name ?? catalyst.type ?? "Catalyst",
        range: catalyst.range ?? catalyst.quality ?? catalyst.value ?? "",
        rarity: catalyst.rarity ?? "",
        category: catalyst.category ?? catalyst.activity ?? "",
        halved: Boolean(catalyst.halved),
        slotIndex: catalyst.slotIndex ?? "",
      };
      normalized.bonus = catalystBonus(normalized);
      return normalized;
    });
  };

  const normalizeGear = (ship) => {
    if (!ship || typeof ship !== "object") return [];
    const ignored = new Set(["skin", "effect"]);
    const output = [];
    for (const [slot, rawValue] of Object.entries(plain(ship) || {})) {
      if (ignored.has(slot) || !rawValue || typeof rawValue !== "object") continue;
      const item = rawValue.item || (rawValue.value && typeof rawValue.value === "object" ? rawValue.value : rawValue);
      if (!slot.toLowerCase().includes("slot") && !item?.name && !item?.item?.name) continue;
      const catalysts = normalizeCatalysts(rawValue.catalysts || item.catalysts || rawValue.installedCatalysts || item.installedCatalysts);
      const bonuses = normalizeBonuses(rawValue.bonuses || item.bonuses || {});
      output.push({
        slot: cleanLabel(slot),
        name: item?.item?.name || item?.name || rawValue.name || "Empty",
        level: item?.level ?? item?.statLevel ?? rawValue.level ?? "",
        rarity: item?.rarity ?? rawValue.rarity ?? "",
        quality: item?.quality ?? item?.range ?? rawValue.quality ?? "",
        bonuses,
        catalysts,
      });
    }
    return output;
  };

  const xpActivitiesFromLevels = (levels) => {
    const activities = {};
    for (const activity of XP_ACTIVITIES) {
      const level = finite(levels?.[`${activity}_level`]);
      const current = finite(levels?.[`${activity}_current_xp`]);
      const target = finite(levels?.[`${activity}_target_xp`]);
      if (level === null || current === null) continue;
      activities[activity] = [level, current, target ?? 0];
    }
    return activities;
  };

  const pruneXpHistory = (history, now = Date.now()) => {
    const buckets = new Set();
    const kept = [];
    for (const sample of [...history].sort((a, b) => b.at - a.at)) {
      const age = Math.max(0, now - sample.at);
      if (age > 30 * 24 * 60 * 60 * 1000) continue;
      const bucketSize = age <= 6 * 60 * 60 * 1000
        ? XP_SAMPLE_BUCKET_MS
        : age <= 7 * 24 * 60 * 60 * 1000
          ? 30 * 60 * 1000
          : 6 * 60 * 60 * 1000;
      const bucket = `${bucketSize}:${Math.floor(sample.at / bucketSize)}`;
      if (buckets.has(bucket)) continue;
      buckets.add(bucket);
      kept.push(sample);
    }
    return kept.sort((a, b) => a.at - b.at).slice(-800);
  };

  const syncUsername = (value) => String(value || "").trim().slice(0, 64);

  const syncEndpoint = () => {
    const raw = String(state.sync.endpoint || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    try {
      const url = new URL(raw);
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "";
      if (url.host === location.host) return "";
      return url.href.replace(/\/+$/, "");
    } catch {
      return "";
    }
  };

  const createSyncToken = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  };

  const syncOwner = () => syncUsername(state.profiles[state.selfProfileKey]?.username);

  const companionJson = async (path, body, timeoutMs = 15000) => {
    const endpoint = syncEndpoint();
    if (!endpoint) throw new Error("The companion endpoint is not valid");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = safeParse(await response.text(), null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  };

  const nativeBridgeConfig = () => {
    const bridge = window.__soIntelNativeBridge;
    if (!bridge || typeof bridge !== "object") return null;
    const baseUrl = String(bridge.baseUrl || "");
    const token = String(bridge.token || "");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) || !/^[a-f0-9]{64}$/.test(token)) return null;
    return { baseUrl, token, launcherVersion: String(bridge.launcherVersion || "") };
  };

  const nativeBridgeJson = async (path, { method = "GET", body = null, timeoutMs = 30000 } = {}) => {
    const bridge = nativeBridgeConfig();
    if (!bridge) throw new Error("Install launcher 1.1.0 or newer to use the official API");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${bridge.baseUrl}${path}`, {
        method,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          "X-SO-Intel-Token": bridge.token,
          ...(body === null ? {} : { "Content-Type": "application/json" }),
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const result = safeParse(await response.text(), null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || `Local helper returned HTTP ${response.status}`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  };

  const steamAuthorizeUrl = (requestId) => {
    try {
      const endpoint = syncEndpoint();
      if (!endpoint || !requestId) return "";
      const url = new URL("/auth/steam/start", `${endpoint}/`);
      url.searchParams.set("request", requestId);
      return url.toString();
    } catch {
      return "";
    }
  };

  const openSteamWindow = (authorizeUrl) => {
    if (!authorizeUrl) return false;
    try {
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      return true;
    } catch {
      return false;
    }
  };

  const beginSteamLink = async ({ requestId = "", authorizeUrl = "", opened = false } = {}) => {
    if (state.sync.authBusy) return;
    const owner = syncOwner();
    if (!owner) {
      state.sync.status = "setup";
      state.sync.message = "Open your own Stellar Odyssey profile first so the account can be detected";
      state.lastPanelSignature = "";
      renderPanel();
      return;
    }
    state.sync.authBusy = true;
    state.sync.status = "linking";
    state.sync.message = `Preparing Steam connection for ${owner}`;
    state.lastPanelSignature = "";
    renderPanel();
    const deviceToken = createSyncToken();
    try {
      const result = await companionJson("/v1/auth/steam/start", {
        version: VERSION,
        owner,
        deviceToken,
        requestId,
        legacyToken: state.sync.authMode === "code" ? state.sync.token : "",
        previousDeviceToken: state.sync.authMode === "steam" ? state.sync.token : "",
      });
      state.sync.linkRequest = {
        requestId: String(result.requestId || ""),
        deviceToken,
        authorizeUrl: String(result.authorizeUrl || ""),
        expiresAt: Number(result.expiresAt || 0),
      };
      state.sync.message = opened
        ? "Finish the Steam confirmation in your browser — use the link below if no window appeared"
        : "Steam sign-in is ready — use the link below";
      markDirty();
      persist();
    } catch (error) {
      state.sync.status = "error";
      state.sync.message = error?.name === "AbortError" ? "Steam connection timed out" : `Steam connection failed: ${String(error?.message || error).slice(0, 120)}`;
    } finally {
      state.sync.authBusy = false;
      state.lastPanelSignature = "";
      markDirty();
      renderPanel();
    }
  };

  let steamLinkPolling = false;
  const pollSteamLink = async () => {
    const link = state.sync.linkRequest;
    if (steamLinkPolling || !link?.requestId || !link?.deviceToken) return;
    if (Number(link.expiresAt || 0) < Date.now()) {
      state.sync.linkRequest = null;
      state.sync.status = "error";
      state.sync.message = "Steam connection expired — select Connect with Steam again";
      markDirty();
      state.lastPanelSignature = "";
      renderPanel();
      return;
    }
    steamLinkPolling = true;
    try {
      const result = await companionJson("/v1/auth/steam/status", {
        requestId: link.requestId,
        deviceToken: link.deviceToken,
      }, 10000);
      if (result.status === "approved") {
        state.sync.token = link.deviceToken;
        state.sync.authMode = "steam";
        state.sync.linkRequest = null;
        state.sync.enabled = true;
        state.sync.status = "setup";
        state.sync.message = `${syncOwner() || result.owner || "Account"} is connected through Steam`;
        if (!state.sync.outboxXp.length && !state.sync.outboxResources.length && !Object.keys(state.sync.outboxProfiles).length) bootstrapSyncOutbox();
        markDirty();
        persist();
        state.lastPanelSignature = "";
        renderPanel();
        runSharedSync(true);
      } else if (["failed", "expired"].includes(result.status)) {
        state.sync.linkRequest = null;
        state.sync.status = "error";
        state.sync.message = result.error || "Steam connection did not complete";
        markDirty();
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        state.sync.status = "error";
        state.sync.message = `Could not check Steam connection: ${String(error?.message || error).slice(0, 120)}`;
      }
    } finally {
      steamLinkPolling = false;
      state.lastPanelSignature = "";
      renderPanel();
    }
  };

  const revokeSteamLink = async () => {
    if (state.sync.authMode !== "steam" || !state.sync.token || state.sync.authBusy) return;
    state.sync.authBusy = true;
    state.sync.status = "linking";
    state.sync.message = "Disconnecting this device";
    state.lastPanelSignature = "";
    renderPanel();
    try {
      await companionJson("/v1/auth/steam/revoke", { owner: syncOwner(), token: state.sync.token });
      state.sync.token = "";
      state.sync.authMode = "code";
      state.sync.linkRequest = null;
      state.sync.enabled = false;
      state.sync.status = "idle";
      state.sync.message = "This device is disconnected";
      markDirty();
      persist();
    } catch (error) {
      state.sync.status = "error";
      state.sync.message = `Disconnect failed: ${String(error?.message || error).slice(0, 120)}`;
    } finally {
      state.sync.authBusy = false;
      state.lastPanelSignature = "";
      renderPanel();
    }
  };

  const queueSyncXp = (username, sample) => {
    if (!state.sync.enabled || !sample) return;
    state.sync.outboxXp = coalesceSyncSamples([...state.sync.outboxXp, { username: syncUsername(username), ...plain(sample) }]);
    scheduleSharedSync();
  };

  const queueSyncResource = (username, sample) => {
    if (!state.sync.enabled || !sample) return;
    const source = resourceSourceKind(sample.source);
    if (!source) return;
    state.sync.outboxResources = coalesceSyncSamples([...state.sync.outboxResources, { username: syncUsername(username), ...plain(sample), source }]);
    scheduleSharedSync();
  };

  const sanitizedSyncProfile = (profile) => profile ? {
    username: syncUsername(profile.username),
    squadron: String(profile.squadron || "").slice(0, 100),
    clones: profile.clones ?? "",
    droids: profile.droids ?? "",
    lastSeen: profile.lastSeen ?? "",
    levels: primitiveMap(profile.levels || {}, 28),
    stats: Object.fromEntries(Object.entries(primitiveMap(profile.stats || {}, 80)).filter(([stat]) => !/^npcMat_/i.test(stat))),
    technology: primitiveMap(profile.technology || {}, 40),
    pets: plain(Array.isArray(profile.pets) ? profile.pets.slice(0, 30) : []),
    gear: plain(Array.isArray(profile.gear) ? profile.gear.slice(0, 12) : []),
    capturedAt: Number(profile.capturedAt) || Date.now(),
  } : null;

  const queueSyncProfile = (profile) => {
    if (!state.sync.enabled || !profile || profile.placeholder) return;
    const clean = sanitizedSyncProfile(profile);
    const key = clean?.username.toLowerCase();
    if (!key) return;
    state.sync.outboxProfiles[key] = clean;
    const newest = Object.entries(state.sync.outboxProfiles)
      .sort((a, b) => Number(b[1]?.capturedAt || 0) - Number(a[1]?.capturedAt || 0))
      .slice(0, 100);
    state.sync.outboxProfiles = Object.fromEntries(newest);
    scheduleSharedSync();
  };

  const systemCoordinates = (key) => {
    const match = String(key || "").match(/^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const [, z, x, y] = match.map(Number);
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  };

  const sanitizedSyncSystem = (key) => {
    const coordinates = systemCoordinates(key);
    if (!coordinates || !state.seen[key]) return null;
    const perfect = state.systems[key];
    const nodeObservedAt = Math.max(0, Number(state.nodeObservations[key] || perfect?.verifiedAt || 0));
    return {
      ...coordinates,
      firstSeenAt: Number(state.seen[key]) || Date.now(),
      id: String(perfect?.id || "").slice(0, 100),
      name: String(perfect?.name || "").slice(0, 120),
      nodeObservedAt,
      nodes: (nodeObservedAt > 0 && Array.isArray(perfect?.nodes) ? perfect.nodes : []).filter((node) => Number(node?.quality) === 100).slice(0, 24).map((node) => ({
        id: String(node?.id || "").slice(0, 100),
        type: String(node?.type || "resource").slice(0, 80),
        body: String(node?.body || "Planet").slice(0, 80),
        quality: 100,
      })),
    };
  };

  const queueSyncSystem = (key) => {
    if (!state.sync.enabled || !state.seen[key] || state.sync.outboxSystems.includes(key)) return;
    state.sync.outboxSystems.push(key);
    state.sync.outboxSystems = state.sync.outboxSystems.slice(-25000);
    scheduleSharedSync();
  };

  const battleNumber = (value, minimum = -1e15, maximum = 1e15) => {
    const number = finite(value);
    return number === null ? null : Math.max(minimum, Math.min(maximum, number));
  };

  const battleCombatStat = (profile, stat) => {
    const values = profile?.stats || {};
    for (const key of [`pvp_${stat}`, `combat_${stat}`, stat]) {
      const value = battleNumber(values[key], 0);
      if (value !== null && value > 0) return value;
    }
    const match = Object.entries(values).find(([key, value]) => key.toLowerCase().endsWith(`_${stat}`) && (battleNumber(value, 0) || 0) > 0);
    return match ? battleNumber(match[1], 0) : null;
  };

  const battleBuildEvidence = (username) => {
    const profile = state.profiles[String(username || "").trim().toLowerCase()];
    if (!profile || profile.placeholder) return null;
    const stats = {
      p: battleCombatStat(profile, "power"),
      r: battleCombatStat(profile, "precision"),
      e: battleCombatStat(profile, "evasion"),
      h: battleCombatStat(profile, "hull"),
    };
    if (Object.values(stats).filter((value) => value !== null && value > 0).length < 2) return null;
    const catalystTotals = (Array.isArray(profile.gear) && profile.gear.length)
      ? Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, 0]))
      : {};
    for (const gear of Array.isArray(profile.gear) ? profile.gear : []) {
      for (const catalyst of Array.isArray(gear?.catalysts) ? gear.catalysts : []) {
        const key = String(catalyst?.stat || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
        const match = String(catalyst?.bonus || "").match(/-?\d+(?:\.\d+)?/);
        const amount = match ? battleNumber(match[0], -1000, 1000) : null;
        if (key && amount !== null) catalystTotals[key] = (catalystTotals[key] || 0) + amount;
      }
    }
    const source = String(profile.source || "").toLowerCase();
    return {
      t: Number(profile.capturedAt || Date.now()),
      q: source.includes("official") ? "official" : profile.live ? "live" : source.includes("shared") ? "shared" : "profile",
      ...stats,
      c: catalystTotals,
    };
  };

  const battleActionCode = (value) => ({
    round: "r",
    attacks: "h",
    "misses hit on": "m",
    "attack blocked": "b",
    stuns: "s",
    "is stunned": "z",
    dies: "d",
    "applies dot": "a",
    "dot triggers": "t",
    focused: "f",
    won: "w",
  })[String(value || "").trim().toLowerCase()] || "u";

  const battleActorToken = (value, identities) => {
    const label = String(value || "");
    if (!label) return "";
    for (const identity of identities) {
      if (label === identity.team) return `${identity.side}t`;
      if (label === identity.name) return `${identity.side}${identity.slot}`;
      const prefix = `${identity.name}'s `;
      if (!label.startsWith(prefix)) continue;
      const cloneName = label.slice(prefix.length);
      let cloneIndex = identity.clones.findIndex((name) => String(name || "").toLowerCase() === cloneName.toLowerCase());
      if (cloneIndex < 0) {
        const cloneMatch = cloneName.match(/clone\s+(\d+)/i);
        if (cloneMatch) cloneIndex = Math.max(0, Number(cloneMatch[1]) - 1);
      }
      return cloneIndex >= 0 ? `${identity.side}${identity.slot}c${cloneIndex}` : `${identity.side}${identity.slot}`;
    }
    return "";
  };

  const compactBattleLogs = (logs, identities) => (Array.isArray(logs) ? logs : []).slice(0, BATTLE_LOG_LIMIT).map((row) => {
    const hp = String(row?.hpLeft || "").match(/\[\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*\]/);
    return [
      Math.max(0, Math.floor(battleNumber(row?.round, 0, 10000) || 0)),
      battleActionCode(row?.action),
      battleActorToken(row?.attacker, identities),
      battleActorToken(row?.defender, identities),
      battleNumber(row?.value),
      hp ? battleNumber(hp[1], 0) : null,
      hp ? battleNumber(hp[2], 0) : null,
    ];
  }).filter((row) => row[1] !== "u" || row[2] || row[3] || row[4] !== null);

  const battleDigest = async (value) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
  };

  const trimBattleOutbox = () => {
    state.sync.outboxBattles = state.sync.outboxBattles.filter((row) => row && /^[a-f0-9]{64}$/i.test(String(row.x || ""))).slice(-BATTLE_OUTBOX_LIMIT);
    while (state.sync.outboxBattles.length > 1 && JSON.stringify(state.sync.outboxBattles).length > BATTLE_OUTBOX_BYTES) state.sync.outboxBattles.shift();
    state.sync.battleSeen = Object.fromEntries(Object.entries(state.sync.battleSeen)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, BATTLE_SEEN_LIMIT));
  };

  const queueBattleObservation = async (record, fingerprintSource) => {
    if (!state.sync.enabled || !state.sync.battleSharing || !record?.g?.length) return;
    const key = await battleDigest(fingerprintSource);
    if (state.sync.battleSeen[key] || state.sync.outboxBattles.some((row) => row.x === key)) return;
    const queued = { ...record, x: key };
    if (JSON.stringify(queued).length > 280000) return;
    state.sync.outboxBattles.push(queued);
    state.sync.battleSeen[key] = Date.now();
    state.sync.battleCaptured += 1;
    state.sync.lastBattleAt = Date.now();
    state.sync.lastBattleKind = record.k;
    trimBattleOutbox();
    markDirty();
    scheduleSharedSync(3000);
    state.lastPanelSignature = "";
  };

  const battleMembers = (value) => {
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const arenaBattleObservation = (arena) => {
    const duel = plain(arena?.currentDuel);
    const cards = plain(arena?.currentDuelCards);
    if (!duel?.winner || !Array.isArray(duel.logs) || !duel.logs.some((row) => String(row?.action).toLowerCase() === "won")) return null;
    const attackerName = String(duel.attackerName || cards?.attacker?.username || "").trim();
    const defenderName = String(duel.defenderName || cards?.defender?.username || "").trim();
    if (!attackerName || !defenderName) return null;
    const identities = [
      { side: "a", slot: 0, name: attackerName, team: "", clones: [] },
      { side: "d", slot: 0, name: defenderName, team: "", clones: [] },
    ];
    const logs = compactBattleLogs(duel.logs, identities);
    const rounds = Math.max(0, ...logs.map((row) => row[0]));
    const created = Number(duel.created || 0);
    const observedAt = created > 1e12 ? created : created > 1e9 ? created * 1000 : Date.now();
    const record = {
      v: 1,
      k: "arena",
      o: observedAt,
      r: rounds,
      w: String(duel.winner).toLowerCase() === attackerName.toLowerCase() ? "a" : String(duel.winner).toLowerCase() === defenderName.toLowerCase() ? "d" : "tie",
      p: [
        { s: "a", i: 0, l: battleNumber(cards?.attacker?.levels?.battling_level, 0), d: null, h: null, m: null, c: [], b: battleBuildEvidence(attackerName) },
        { s: "d", i: 0, l: battleNumber(cards?.defender?.levels?.battling_level, 0), d: null, h: null, m: null, c: [], b: battleBuildEvidence(defenderName) },
      ],
      tb: { a: {}, d: {} },
      g: logs,
    };
    const fingerprint = JSON.stringify({ k: record.k, created, attackerName: attackerName.toLowerCase(), defenderName: defenderName.toLowerCase(), w: record.w, g: logs });
    return { record, fingerprint, marker: `${created}:${attackerName}:${defenderName}:${duel.logs.length}:${duel.winner}` };
  };

  const squadronBattleObservation = (battle) => {
    const source = plain(battle);
    if (!source?.winner || !Array.isArray(source.logs) || !source.logs.some((row) => String(row?.action).toLowerCase() === "won")) return null;
    const teams = {
      a: String(source.attacking_squadron?.name || "").trim(),
      d: String(source.defending_squadron?.name || "").trim(),
    };
    const members = { a: battleMembers(source.attacking_members), d: battleMembers(source.defending_members) };
    if (!members.a.length || !members.d.length) return null;
    const identities = [];
    const participants = [];
    for (const side of ["a", "d"]) members[side].slice(0, 40).forEach((member, slot) => {
      const name = String(member?.user || member?.username || "").trim();
      const clones = (Array.isArray(member?.clones) ? member.clones : []).slice(0, 20);
      identities.push({ side, slot, name, team: teams[side], clones: clones.map((clone) => clone?.name || "") });
      participants.push({
        s: side,
        i: slot,
        l: battleNumber(member?.levels?.battling_level, 0),
        d: battleNumber(member?.damage, 0),
        h: battleNumber(member?.hp, 0),
        m: battleNumber(member?.maxhp, 0),
        c: clones.map((clone) => ({
          d: String(clone?.damage_type || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 16),
          cc: battleNumber(clone?.critical_chance, 0, 1000),
          cd: battleNumber(clone?.critical_damage, 0, 1000),
          ds: battleNumber(clone?.dual_shot, 0, 1000),
        })),
        b: battleBuildEvidence(name),
      });
    });
    const logs = compactBattleLogs(source.logs, identities);
    const winner = String(source.winner || "").toLowerCase();
    const record = {
      v: 1,
      k: "squadron",
      o: Date.now(),
      r: Math.max(0, ...logs.map((row) => row[0])),
      w: winner === teams.a.toLowerCase() ? "a" : winner === teams.d.toLowerCase() ? "d" : "tie",
      p: participants,
      tb: {
        a: primitiveMap(source.attacking_squadron?.pvpBonuses || {}, 20),
        d: primitiveMap(source.defending_squadron?.pvpBonuses || {}, 20),
      },
      g: logs,
    };
    const names = identities.map((identity) => `${identity.side}:${identity.name.toLowerCase()}`).sort();
    const fingerprint = JSON.stringify({ k: record.k, teams, names, w: record.w, g: logs });
    return { record, fingerprint, marker: `${teams.a}:${teams.d}:${source.logs.length}:${source.winner}:${logs.at(-2)?.join(":")}` };
  };

  let battleCaptureBusy = false;
  const battleCaptureMarkers = { arena: "", squadron: "" };
  const captureBattleObservations = async () => {
    if (battleCaptureBusy || !state.sync.enabled || !state.sync.battleSharing) return;
    const pinia = getPinia();
    if (!pinia?._s) return;
    battleCaptureBusy = true;
    try {
      const observations = [
        arenaBattleObservation(pinia._s.get("PvPArenaStore")),
        squadronBattleObservation(pinia._s.get("squadronStore")?.lastBattleStats),
      ].filter(Boolean);
      for (const observation of observations) {
        const kind = observation.record.k;
        if (battleCaptureMarkers[kind] === observation.marker) continue;
        battleCaptureMarkers[kind] = observation.marker;
        await queueBattleObservation(observation.record, observation.fingerprint);
      }
    } catch (error) {
      console.warn("[SO Intel] Could not capture completed battle", error);
    } finally {
      battleCaptureBusy = false;
    }
  };

  const recordXpSnapshot = (username, levels, source, capturedAt = Date.now()) => {
    const key = String(username || "").trim().toLowerCase();
    const activities = xpActivitiesFromLevels(levels);
    if (!key || !Object.keys(activities).length) return false;
    const history = Array.isArray(state.xpHistory[key]) ? state.xpHistory[key] : [];
    const sample = { at: Number(capturedAt) || Date.now(), source: source === "live client stores" ? "live" : "public", activities };
    const last = history.at(-1);
    if (last && JSON.stringify(last.activities) === JSON.stringify(sample.activities)) return false;

    if (!last) {
      history.push(sample);
    } else {
      const sameBucket = Math.floor(last.at / XP_SAMPLE_BUCKET_MS) === Math.floor(sample.at / XP_SAMPLE_BUCKET_MS);
      const levelChanged = XP_ACTIVITIES.some((activity) => last.activities?.[activity]?.[0] !== sample.activities?.[activity]?.[0]);
      if (sameBucket && !levelChanged) {
        // Preserve the very first baseline; once two buckets exist, keep the newest sample in the active bucket current.
        if (history.length < 2) return false;
        history[history.length - 1] = sample;
      } else {
        history.push(sample);
      }
    }

    state.xpHistory[key] = pruneXpHistory(history, sample.at);
    queueSyncXp(username, sample);
    markDirty();
    return true;
  };

  const recordResourceSnapshot = (username, value, source, capturedAt = Date.now()) => {
    const key = String(username || "").trim().toLowerCase();
    const total = finite(value);
    const at = Number(capturedAt) || Date.now();
    const sourceKind = resourceSourceKind(source);
    if (!key || total === null || !sourceKind) return false;
    const history = (Array.isArray(state.resourceHistory[key]) ? state.resourceHistory[key] : [])
      .filter((row) => resourceSourceKind(row?.source))
      .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
    const sample = { at, value: total, source: sourceKind };
    const last = history.at(-1);
    if (last && at >= Number(last.at || 0) && total < Number(last.value || 0)) return false;
    if (!last) {
      history.push(sample);
    } else {
      const sameBucket = Math.floor(last.at / XP_SAMPLE_BUCKET_MS) === Math.floor(sample.at / XP_SAMPLE_BUCKET_MS);
      if (sameBucket) {
        if (last.value === sample.value) return false;
        if (history.length < 2) history.push(sample);
        else history[history.length - 1] = sample;
      } else {
        history.push(sample);
      }
    }
    state.resourceHistory[key] = pruneXpHistory(history, at);
    queueSyncResource(username, sample);
    markDirty();
    return true;
  };

  const seedResourceHistoryFromCache = () => {
    for (const [key, profile] of Object.entries(state.profiles)) {
      const value = finite(profile?.stats?.resources);
      if (value !== null) recordResourceSnapshot(profile.username || key, value, profile?.live ? "live-profile" : "profile", profile.capturedAt);
    }
  };

  const xpDelta = (first, last, activity) => {
    const start = first?.activities?.[activity];
    const end = last?.activities?.[activity];
    if (!start || !end) return null;
    const [startLevel, startCurrent, startTarget] = start;
    const [endLevel, endCurrent, endTarget] = end;
    if (endLevel < startLevel) return null;
    if (endLevel === startLevel) {
      const gained = endCurrent - startCurrent;
      return gained >= 0 ? { gained, confidence: "high", estimated: false } : null;
    }
    if (!(startTarget > 0) || !(endTarget > 0)) return null;
    const skippedLevels = Math.max(0, endLevel - startLevel - 1);
    const estimatedMiddle = skippedLevels * ((startTarget + endTarget) / 2);
    const gained = Math.max(0, startTarget - startCurrent) + estimatedMiddle + Math.max(0, endCurrent);
    return {
      gained,
      confidence: skippedLevels ? "low" : "medium",
      estimated: skippedLevels > 0,
    };
  };

  const findProfilePayload = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    const queue = [payload];
    const seen = new Set();
    while (queue.length) {
      const candidate = queue.shift();
      if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
      seen.add(candidate);
      if (typeof candidate.username === "string" && candidate.username) return candidate;
      for (const key of ["data", "profile", "player", "user", "result"]) {
        if (candidate[key] && typeof candidate[key] === "object") queue.push(candidate[key]);
      }
    }
    return null;
  };

  const routeProfileName = () => {
    const match = location.hash.match(/\/userprofile\/([^/?#]+)/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  const ensureProfileShell = (username, source = "loaded player list", squadron = "") => {
    const cleanName = String(username || "").trim();
    if (!cleanName) return null;
    const key = cleanName.toLowerCase();
    if (state.profiles[key]) return state.profiles[key];
    const profile = {
      username: cleanName,
      squadron: String(squadron || ""),
      clones: "",
      droids: "",
      lastSeen: "",
      levels: {},
      stats: {},
      technology: {},
      pets: [],
      gear: [],
      capturedAt: Date.now(),
      source,
      placeholder: true,
    };
    state.profiles[key] = profile;
    markDirty();
    return profile;
  };

  const normalizeProfile = (payload, sourceUrl) => {
    const profile = findProfilePayload(payload);
    if (!profile) return null;
    if (!profile.username) return null;
    const normalized = {
      username: String(profile.username),
      squadron: profile.squadron?.name || profile.squadron || "",
      clones: profile.clones ?? "",
      droids: profile.droids ?? "",
      lastSeen: profile.lastSeen ?? "",
      levels: primitiveMap(profile.levels || profile.player?.levels || {}, 28),
      stats: Object.fromEntries(Object.entries(primitiveMap(profile.statistics || profile.stats || profile.player?.stats || {}, 80)).filter(([stat]) => !/^npcMat_/i.test(stat))),
      technology: primitiveMap(profile.technology || {}, 40),
      pets: (Array.isArray(profile.pets) ? profile.pets : []).slice(0, 30).map((pet) => ({
        name: pet.name || pet.pet_type || pet.type || "Pet",
        level: pet.level ?? "",
        active: Boolean(pet.active ?? pet.equipped),
        xpboost: pet.xpboost ?? "",
      })),
      gear: normalizeGear(profile.ship || profile.gear || profile.equipment || {}),
      capturedAt: Date.now(),
      source: sourceUrl,
      placeholder: false,
    };
    const resourceRanking = (Array.isArray(profile.rankings) ? profile.rankings : [])
      .find((entry) => String(entry?.ranking || entry?.category || "").toLowerCase() === "totalresources");
    const resourceValue = finite(
      profile.statistics?.resources?.$numberDecimal
      ?? profile.stats?.resources?.$numberDecimal
      ?? profile.statistics?.resources
      ?? profile.stats?.resources
      ?? resourceRanking?.magnitude1
      ?? resourceRanking?.magnitude
      ?? resourceRanking?.value?.magnitude1
      ?? resourceRanking?.value,
    );
    const resourceRank = finite(resourceRanking?.rank ?? resourceRanking?.rankingPosition);
    if (resourceValue !== null) normalized.stats.resources = resourceValue;
    const coordinates = directCoordinates(profile);
    if (coordinates) recordLocation(normalized.username, coordinates, "public profile");
    const key = normalized.username.toLowerCase();
    const previous = state.profiles[key];
    if (previous?.live) return previous;
    state.profiles[key] = {
      ...previous,
      ...normalized,
      levels: { ...(previous?.levels || {}), ...normalized.levels },
      stats: { ...(previous?.stats || {}), ...normalized.stats },
      technology: { ...(previous?.technology || {}), ...normalized.technology },
      pets: normalized.pets.length ? normalized.pets : (previous?.pets || []),
      gear: normalized.gear.length ? normalized.gear : (previous?.gear || []),
    };
    if (resourceValue !== null) {
      state.resourceRankings.rows[key] = {
        username: normalized.username,
        squadron: normalized.squadron,
        rank: resourceRank,
        value: resourceValue,
        source: "public profile",
        capturedAt: normalized.capturedAt,
      };
      state.resourceRankings.capturedAt = normalized.capturedAt;
      recordResourceSnapshot(normalized.username, resourceValue, "public-profile", normalized.capturedAt);
    }
    recordXpSnapshot(normalized.username, state.profiles[key].levels, "public profile", normalized.capturedAt);
    queueSyncProfile(state.profiles[key]);
    if (!state.selectedProfile || routeProfileName().toLowerCase() === key) state.selectedProfile = key;
    markDirty();
    return state.profiles[key];
  };

  const normalizeSelfProfile = (pinia) => {
    const user = pinia?._s?.get("UserStore");
    const player = user?.player;
    const username = String(user?.username || "");
    if (!username || !player) return;

    const battle = pinia._s.get("BattleStore");
    const gather = pinia._s.get("GatherStore");
    const craft = pinia._s.get("CraftStore");
    const explore = pinia._s.get("ExploreStore");
    const petsStore = pinia._s.get("PetsStore");
    const shipStore = pinia._s.get("ShipStore");
    const key = username.toLowerCase();

    const levels = {
      battling_level: battle?.battling_level,
      battling_current_xp: battle?.battling_current_xp,
      battling_target_xp: battle?.battling_target_xp,
      gathering_level: gather?.gathering_level,
      gathering_current_xp: gather?.gathering_current_xp,
      gathering_target_xp: gather?.gathering_target_xp,
      crafting_level: craft?.crafting_level,
      crafting_current_xp: craft?.crafting_current_xp,
      crafting_target_xp: craft?.crafting_target_xp,
      exploring_level: explore?.exploring_level,
      exploring_current_xp: explore?.exploring_current_xp,
      exploring_target_xp: explore?.exploring_target_xp,
    };
    for (const levelKey of Object.keys(levels)) if (levels[levelKey] === undefined) delete levels[levelKey];

    const stats = {};
    for (const [stat, value] of Object.entries(displayMap(player.stats))) stats[`combat_${stat}`] = value;
    for (const [stat, value] of Object.entries(displayMap(player.pvpstats))) stats[`pvp_${stat}`] = value;
    for (const [stat, value] of Object.entries(displayMap(player.statistics))) {
      if (/^npcMat_/i.test(stat)) continue;
      stats[stat] = value;
    }

    const ship = Object.fromEntries([
      "weapon_slot",
      "shield_slot",
      "engine_slot",
      "sensors_slot",
      "laser_slot",
      "probes_slot",
    ].map((slot) => [slot, shipStore?.[slot]]).filter(([, item]) => item));

    const count = (value) => Array.isArray(value) ? value.length : value ?? "";
    const normalized = {
      username,
      squadron: user.squadron?.name || "",
      clones: count(player.clones),
      droids: count(player.droids),
      lastSeen: "",
      levels,
      stats,
      technology: displayMap(player.skills),
      pets: (Array.isArray(petsStore?.pets) ? plain(petsStore.pets) : []).slice(0, 30).map((pet) => ({
        name: pet.name || pet.pet_type || pet.type || "Pet",
        level: pet.level ?? "",
        active: Boolean(pet.active ?? pet.equipped),
        xpboost: pet.xpboost ?? "",
      })),
      gear: normalizeGear(ship),
      capturedAt: Date.now(),
      source: "live client stores",
      live: true,
    };

    const previous = state.profiles[key];
    const comparable = (profile) => JSON.stringify({ ...profile, capturedAt: 0 });
    const profileChanged = !(previous && comparable(previous) === comparable(normalized));
    if (!profileChanged) normalized.capturedAt = previous.capturedAt;
    else markDirty();
    state.profiles[key] = normalized;
    recordXpSnapshot(username, levels, "live client stores", Date.now());
    if (profileChanged) queueSyncProfile(normalized);
    const selfResources = finite(stats.resources);
    if (selfResources !== null) {
      const observedAt = Date.now();
      const previousResource = state.resourceRankings.rows[key];
      const resourceChanged = finite(previousResource?.value) !== selfResources;
      const capturedAt = resourceChanged ? observedAt : Number(previousResource?.capturedAt || normalized.capturedAt || observedAt);
      state.resourceRankings.rows[key] = {
        ...(previousResource || {}),
        username,
        squadron: normalized.squadron,
        value: selfResources,
        source: "live client stores",
        capturedAt,
      };
      state.resourceRankings.currentValue = selfResources;
      if (resourceChanged || !state.resourceRankings.capturedAt) state.resourceRankings.capturedAt = capturedAt;
      recordResourceSnapshot(username, selfResources, "live-profile", observedAt);
    }
    updateSessionFromProfile(normalized);
    state.selfProfileKey = key;
    if (state.favorites.delete(key)) markDirty();
    if (!state.selectedProfile || !state.profiles[state.selectedProfile]) state.selectedProfile = key;
  };

  const ingestSystems = (systems, fallbackZ = 1) => {
    const values = Array.isArray(systems)
      ? systems
      : systems && typeof systems === "object"
        ? Object.values(systems)
        : [];
    let changed = false;
    for (const system of values) {
      if (!system || typeof system !== "object") continue;
      const x = finite(system.coordinate_x);
      const y = finite(system.coordinate_y);
      const z = finite(system.coordinate_z ?? fallbackZ) ?? fallbackZ;
      if (x === null || y === null || !Array.isArray(system.bodies)) continue;
      const key = `${z}:${x},${y}`;
      if (!state.seen[key]) {
        state.seen[key] = Date.now();
        queueSyncSystem(key);
        changed = true;
      }
      const observedAt = Date.now();
      const previousNodeObservedAt = Number(state.nodeObservations[key] || 0);
      const perfect = system.bodies.filter((body) => Number(body?.nodeQuality) === 100).map((body) => ({
        id: String(body._id || ""),
        type: String(body.nodeType || body.type || "resource"),
        body: String(body.type || "Planet"),
        quality: 100,
      }));
      if (perfect.length) {
        const normalized = {
          id: String(system._id || ""),
          name: String(system.name || "Unknown system"),
          x,
          y,
          z,
          nodes: perfect,
          seenAt: observedAt,
          verifiedAt: observedAt,
        };
        const comparable = (value) => JSON.stringify({
          id: value?.id || "",
          name: value?.name || "",
          x: value?.x,
          y: value?.y,
          z: value?.z,
          nodes: value?.nodes || [],
        });
        if (!previousNodeObservedAt || comparable(state.systems[key]) !== comparable(normalized)) {
          state.nodeObservations[key] = observedAt;
          state.systems[key] = normalized;
          queueSyncSystem(key);
          changed = true;
        }
      } else if (!previousNodeObservedAt || state.systems[key]) {
        state.nodeObservations[key] = observedAt;
        if (state.systems[key]) delete state.systems[key];
        queueSyncSystem(key);
        changed = true;
      }
    }
    if (Object.keys(state.seen).length > 25000) {
      const newest = Object.entries(state.seen).sort((a, b) => b[1] - a[1]).slice(0, 20000);
      state.seen = Object.fromEntries(newest);
      changed = true;
    }
    if (changed) {
      state.lastPanelSignature = "";
      markDirty();
    }
  };

  const responsePayload = (xhr) => {
    try {
      if (xhr.responseType === "json") return xhr.response;
      if (xhr.responseType === "" || xhr.responseType === "text") return safeParse(xhr.responseText, null);
    } catch {
      return null;
    }
    return null;
  };

  const scanXpProfiles = (value, source, depth = 0, visited = new WeakSet()) => {
    if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => scanXpProfiles(entry, source, depth + 1, visited));
      return;
    }
    if (typeof value.username === "string" && value.levels && typeof value.levels === "object") {
      const levels = primitiveMap(value.levels, 28);
      if (Object.keys(xpActivitiesFromLevels(levels)).length) {
        const profile = ensureProfileShell(value.username, source);
        profile.levels = { ...(profile.levels || {}), ...levels };
        profile.capturedAt = Date.now();
        profile.source = source;
        profile.placeholder = false;
        recordXpSnapshot(value.username, profile.levels, source, profile.capturedAt);
      }
    }
    for (const child of Object.values(value)) scanXpProfiles(child, source, depth + 1, visited);
  };

  const ingestResourceRankings = (url, payload) => {
    if (!/\/api\/rankings\/player\/(?:totalResources|currentrank\/totalResources)(?:\?|$)/i.test(String(url || ""))) return;
    const now = Date.now();
    let changed = false;
    const storeRow = (row) => {
      if (!row || typeof row !== "object") return;
      const username = String(row.user || row.username || "").trim();
      const rank = finite(row.rank ?? row.ranking);
      const value = finite(row.value?.magnitude1 ?? row.value ?? row.totalResources ?? row.resources);
      if (!username || rank === null || value === null) return;
      const key = username.toLowerCase();
      state.resourceRankings.rows[key] = {
        username,
        squadron: String(row.squadron || ""),
        rank,
        value,
        source: "public leaderboard",
        capturedAt: now,
      };
      if (username.toLowerCase() === state.selfProfileKey) {
        state.resourceRankings.currentRank = rank;
        state.resourceRankings.currentValue = value;
      }
      changed = true;
    };

    const results = payload?.results || payload?.data?.results;
    if (Array.isArray(results)) results.forEach(storeRow);
    if (/\/currentrank\/totalResources/i.test(String(url || ""))) {
      const current = payload?.ranking ?? payload?.data?.ranking;
      if (current && typeof current === "object") storeRow(current);
      else {
        const rank = finite(current);
        if (rank !== null) {
          state.resourceRankings.currentRank = rank;
          const selfResources = finite(state.profiles[state.selfProfileKey]?.stats?.resources);
          if (selfResources !== null) state.resourceRankings.currentValue = selfResources;
          changed = true;
        }
      }
    }

    const totalResults = finite(payload?.totalResults ?? payload?.data?.totalResults);
    if (totalResults !== null) state.resourceRankings.totalResults = totalResults;
    if (!changed && totalResults === null) return;
    state.resourceRankings.rows = Object.fromEntries(Object.entries(state.resourceRankings.rows)
      .sort((a, b) => Number(a[1]?.rank || Infinity) - Number(b[1]?.rank || Infinity))
      .slice(0, 500));
    state.resourceRankings.capturedAt = now;
    markDirty();
  };

  const interestingUrl = (url) => /\/api\/(player\/publicprofile|social\/users|squadrons\/members|systems\/|rankings?(?:\/|\?|$)|leaderboards?(?:\/|\?|$))/i.test(String(url || ""));

  const captureResponse = (url, payload) => {
    if (!payload || !interestingUrl(url)) return;
    try {
      if (/\/api\/player\/publicprofile\//i.test(url)) normalizeProfile(payload, url);
      if (/\/api\/systems\//i.test(url)) {
        const candidates = [payload, payload?.data, payload?.systems, payload?.data?.systems];
        for (const candidate of candidates) ingestSystems(candidate);
      }
      ingestResourceRankings(url, payload);
      if (!/\/api\/systems\//i.test(url)) scanXpProfiles(payload, url);
      scanPlayerLocations(payload, url);
    } catch (error) {
      console.debug("[SO Intel] Ignored an unrecognized response shape", error);
    }
  };

  let uninstallNetworkObservers = () => {};

  const installNetworkObservers = () => {
    const registryKey = "__soIntelPassiveNetworkRegistryV1";
    const existing = window[registryKey];
    if (existing?.listeners instanceof Set) {
      existing.listeners.add(captureResponse);
      uninstallNetworkObservers = () => existing.listeners.delete(captureResponse);
      return;
    }
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const registry = { listeners: new Set([captureResponse]), originalOpen, originalSend, originalFetch: window.fetch };
    window[registryKey] = registry;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__soIntelUrl = String(url || "");
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (interestingUrl(this.__soIntelUrl)) {
        this.addEventListener("loadend", () => {
          const payload = responsePayload(this);
          registry.listeners.forEach((listener) => listener(this.__soIntelUrl, payload));
        }, { once: true });
      }
      return originalSend.apply(this, args);
    };

    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch.bind(window);
      const wrappedFetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = String(args[0]?.url || args[0] || response.url || "");
        if (interestingUrl(url)) response.clone().json().then((payload) => {
          registry.listeners.forEach((listener) => listener(url, payload));
        }).catch(() => {});
        return response;
      };
      window.fetch = wrappedFetch;
    }

    uninstallNetworkObservers = () => {
      registry.listeners.delete(captureResponse);
      if (registry.listeners.size) return;
      XMLHttpRequest.prototype.open = registry.originalOpen;
      XMLHttpRequest.prototype.send = registry.originalSend;
      window.fetch = registry.originalFetch;
      if (window[registryKey] === registry) delete window[registryKey];
    };
  };

  const ingestLiveClientState = () => {
    const pinia = getPinia();
    if (!pinia?._s) return;
    normalizeSelfProfile(pinia);
    capturePassiveGalaxyEvents(pinia);
    const userStore = pinia._s.get("UserStore");
    const chatStore = pinia._s.get("ChatStore");
    const squadStore = pinia._s.get("squadronStore");
    const map = findComponent("GalaxyMapCanvas");
    if (map?.props?.systems) ingestSystems(map.props.systems, map.props.currentZ ?? 1);

    const squadMembers = plain(userStore?.squadron?.members || squadStore?.squadronList || []) || [];
    state.squadMembers = squadMembers.map((member) => ({
      username: String(member?.username || member?.user?.username || member?.name || ""),
      id: String(member?._id || member?.user?._id || ""),
    })).filter((member) => member.username);

    const squadronName = userStore?.squadron?.name || "";
    state.squadMembers.forEach((member) => ensureProfileShell(member.username, "loaded squad roster", squadronName));
    ensureProfileShell(routeProfileName(), "current public profile route");

    scanPlayerLocations(chatStore?.userList, "live chat roster");
    scanPlayerLocations(squadStore?.squadronList, "live squad roster");
    scanPlayerLocations(squadMembers, "loaded squad roster");
  };

  const officialPayload = (result) => {
    const raw = result?.data;
    return raw?.data && typeof raw.data === "object" ? raw.data : raw;
  };

  const applyOfficialUser = (result) => {
    const profile = officialPayload(result);
    const username = String(profile?.username || "").trim();
    if (!username) throw new Error("The official user response did not include a username");
    const expected = syncOwner();
    if (expected && expected.toLowerCase() !== username.toLowerCase()) {
      throw new Error(`This API key belongs to ${username}, not the loaded account ${expected}`);
    }
    const key = username.toLowerCase();
    const previous = state.profiles[key];
    const stats = {};
    for (const [stat, value] of Object.entries(displayMap(profile.stats))) stats[`combat_${stat}`] = value;
    for (const [stat, value] of Object.entries(displayMap(profile.pvpstats))) stats[`pvp_${stat}`] = value;
    for (const [stat, value] of Object.entries(displayMap(profile.statistics))) {
      if (!/^npcMat_/i.test(stat)) stats[stat] = value;
    }
    const officialPets = (Array.isArray(profile.pet_slots) ? profile.pet_slots : [])
      .map((slot) => slot?.pet)
      .filter(Boolean)
      .map((pet) => ({
        name: pet.name || pet.pet_type || "Pet",
        level: pet.level ?? "",
        active: Boolean(pet.active_timer || pet.active),
        xpboost: pet.xpboost ?? "",
      }));
    const count = (value) => Array.isArray(value) ? value.length : value ?? "";
    const capturedAt = Number(result?.fetchedAt || Date.now());
    const normalized = {
      username,
      squadron: profile.squadron?.name || "",
      clones: count(profile.clones),
      droids: count(profile.droids),
      lastSeen: previous?.lastSeen || "",
      levels: displayMap(profile.levels, 28),
      stats,
      technology: displayMap(profile.skills, 40),
      pets: officialPets,
      gear: normalizeGear(profile.ship || {}),
      capturedAt,
      source: "official read-only API",
      placeholder: false,
      live: Boolean(previous?.live),
    };
    state.profiles[key] = {
      ...(previous || {}),
      ...normalized,
      source: previous?.live ? "live client + official read-only API" : normalized.source,
      levels: { ...normalized.levels, ...(previous?.live ? previous.levels : {}) },
      stats: { ...normalized.stats, ...(previous?.live ? previous.stats : {}) },
      technology: { ...normalized.technology, ...(previous?.live ? previous.technology : {}) },
      pets: normalized.pets.length ? normalized.pets : (previous?.pets || []),
      gear: normalized.gear.length ? normalized.gear : (previous?.gear || []),
    };
    state.selfProfileKey = key;
    if (!state.selectedProfile || !state.profiles[state.selectedProfile]) state.selectedProfile = key;
    const resourceValue = finite(state.profiles[key].stats?.resources);
    if (resourceValue !== null) {
      state.resourceRankings.rows[key] = {
        ...(state.resourceRankings.rows[key] || {}),
        username,
        squadron: normalized.squadron,
        value: resourceValue,
        source: "official read-only API",
        capturedAt,
      };
      state.resourceRankings.currentValue = resourceValue;
      state.resourceRankings.capturedAt = capturedAt;
      recordResourceSnapshot(username, resourceValue, "official-profile", capturedAt);
    }
    recordXpSnapshot(username, state.profiles[key].levels, "official read-only API", capturedAt);
    state.operations = {
      capturedAt,
      actions: plain(profile.actions || {}),
      laboratory: plain(profile.laboratory || {}),
      labqueue: plain(profile.labqueue || {}),
      base: plain(profile.base || {}),
      globalBoosts: Array.isArray(profile.globalBoosts) ? plain(profile.globalBoosts).slice(0, 30) : [],
      voyager: plain(profile.voyager || {}),
      dungeons: plain(profile.dungeons || {}),
      petSlots: Array.isArray(profile.pet_slots) ? plain(profile.pet_slots).slice(0, 30) : [],
      currency: displayMap(profile.currency, 40),
      squadron: plain(profile.squadron || {}),
      squadronSpaceStations: Array.isArray(profile.squadronSpaceStations) ? plain(profile.squadronSpaceStations).slice(0, 100) : [],
      currentSystem: plain(profile.currentSystem || {}),
    };
    updateSessionFromProfile(state.profiles[key]);
    queueSyncProfile(state.profiles[key]);
    if (profile.currentSystem) ingestSystems([profile.currentSystem], profile.currentSystem.coordinate_z ?? 1);
  };

  const applyOfficialJournal = (result) => {
    const payload = officialPayload(result) || {};
    const rows = Array.isArray(payload.fullJournal) ? payload.fullJournal : Array.isArray(payload.journal) ? payload.journal : [];
    let changed = false;
    for (const entry of rows) {
      const x = finite(entry?.coordinate_x);
      const y = finite(entry?.coordinate_y);
      const z = finite(entry?.coordinate_z ?? 1) ?? 1;
      if (x === null || y === null) continue;
      const key = `${z}:${x},${y}`;
      const seconds = finite(entry?.date);
      const visitedAt = seconds !== null ? seconds * 1000 : Number(result?.fetchedAt || Date.now());
      if (!state.seen[key] || visitedAt < state.seen[key]) {
        state.seen[key] = visitedAt;
        queueSyncSystem(key);
        changed = true;
      }
    }
    state.officialApi.jumps = finite(payload.jumps) ?? rows.length;
    state.officialApi.journalSystems = new Set(rows.map((entry) => {
      const x = finite(entry?.coordinate_x);
      const y = finite(entry?.coordinate_y);
      const z = finite(entry?.coordinate_z ?? 1) ?? 1;
      return x === null || y === null ? "" : `${z}:${x},${y}`;
    }).filter(Boolean)).size;
    if (changed) {
      state.lastPanelSignature = "";
      markDirty();
    }
  };

  const applyOfficialStations = (result) => {
    const payload = officialPayload(result);
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.stations) ? payload.stations : [];
    state.officialApi.stations = rows.slice(0, 500).map((station) => ({
      name: String(station?.name || "Squadron station").slice(0, 100),
      squadron: String(station?.squadron?.name || station?.squadron || "").slice(0, 100),
      x: finite(station?.coordinate_x ?? station?.x),
      y: finite(station?.coordinate_y ?? station?.y),
      z: finite(station?.coordinate_z ?? station?.z ?? 1) ?? 1,
    })).filter((station) => station.x !== null && station.y !== null);
  };

  const applyOfficialMarket = (result) => {
    const payload = officialPayload(result) || {};
    const orders = Array.isArray(payload.orders) ? payload.orders : [];
    state.officialApi.market = orders.slice(0, 200).map((order) => ({
      currency: String(order?.currency || "Unknown").slice(0, 80),
      prices: (Array.isArray(order?.prices) ? order.prices : []).slice(-48).map((price) => ({
        hour: finite(price?.hour),
        buy: finite(price?.buy),
        sell: finite(price?.sell),
      })).filter((price) => price.hour !== null),
    }));
    evaluateMarketAlerts();
  };

  const apiTimeMs = (value) => {
    if (value === null || value === undefined || value === "") return 0;
    const number = Number(value);
    if (Number.isFinite(number)) return number < 100000000000 ? number * 1000 : number;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const eventSystem = (row) => {
    for (const candidate of [row?.system, row?.location, row?.system_location, row?.systemLocation, row?.current_system]) {
      if (candidate && typeof candidate === "object") return candidate;
    }
    return row || {};
  };

  const eventRowsFromPayload = (payload, route = "") => {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    const keys = route === "activerunes"
      ? ["runeSystems", "activeRunes", "active_runes", "runes", "events", "results", "data"]
      : route === "solodungeons"
        ? ["soloDungeons", "solo_dungeons", "dungeons", "events", "results", "data"]
        : ["dungeons", "squadDungeons", "squad_dungeons", "events", "results", "data"];
    for (const key of keys) {
      if (Array.isArray(payload[key])) return payload[key];
      if (payload[key] && typeof payload[key] === "object") {
        const nested = eventRowsFromPayload(payload[key], route);
        if (nested.length) return nested;
      }
    }
    const values = Object.values(payload);
    if (values.length && values.length <= 200 && values.every((value) => value && typeof value === "object")) return values;
    return [];
  };

  const normalizeEventRows = (kind, rows, fetchedAt, source = "official API") => (Array.isArray(rows) ? rows : []).slice(0, 200).map((row, index) => {
    const system = eventSystem(row);
    const coordinateSource = row?.system_coords && typeof row.system_coords === "object" ? row.system_coords : {};
    const startsAt = apiTimeMs(row?.spawnAt ?? row?.spawn_at ?? row?.startsAt ?? row?.starts_at ?? row?.createdAt ?? row?.created_at);
    const endsAt = apiTimeMs(row?.expires_at ?? row?.expiresAt ?? row?.closesAt ?? row?.closes_at ?? row?.resetsAt ?? row?.resets_at ?? row?.fight_end_at ?? row?.endsAt ?? row?.ends_at);
    const name = kind === "rune" ? String(row?.rune_name || row?.runeName || row?.name || "Active rune")
      : kind === "solo" ? String(row?.display_name || row?.dungeon_name || row?.name || system?.name || "Solo dungeon")
        : kind === "boss" ? String(row?.display_name || row?.name || "Galaxy boss")
          : String(row?.display_name || row?.dungeon_name || row?.name || "Dungeon");
    const x = finite(system?.coordinate_x ?? system?.x ?? row?.coordinate_x ?? row?.x ?? coordinateSource.x);
    const y = finite(system?.coordinate_y ?? system?.y ?? row?.coordinate_y ?? row?.y ?? coordinateSource.y);
    const z = finite(system?.coordinate_z ?? system?.z ?? row?.coordinate_z ?? row?.z ?? coordinateSource.z ?? 1) ?? 1;
    const key = `${kind}:${name}:${x},${y},${z}:${endsAt || startsAt || index}`;
    return {
      key,
      kind,
      name: name.slice(0, 100),
      systemName: String(system?.name || row?.playerLocation || "Unknown system").slice(0, 100),
      x, y, z, startsAt, endsAt,
      status: String(row?.status || row?.event_status || row?.type || "").slice(0, 80),
      attempts: finite(row?.attempts),
      alreadyRan: Boolean(row?.alreadyRan),
      rewardModifier: finite(row?.reward_modifier),
      difficultyModifier: finite(row?.difficulty_modifier),
      weakness: String(row?.boss_weakness || row?.weakness || "").slice(0, 80),
      foundBy: String(row?.found_by || "").slice(0, 80),
      fetchedAt: Number(fetchedAt || Date.now()),
      source: String(source || "game client").slice(0, 40),
    };
  });

  const applyOfficialEvents = (route, result) => {
    const payload = officialPayload(result) || {};
    const kind = route === "activerunes" ? "rune" : route === "solodungeons" ? "solo" : "dungeon";
    const rows = normalizeEventRows(kind, eventRowsFromPayload(payload, route), result?.fetchedAt, "official API");
    const target = route === "activerunes" ? "activeRunes" : route === "solodungeons" ? "soloDungeons" : "dungeons";
    const known = new Set(state.officialApi.knownEventKeys);
    const initialized = known.size > 0;
    const fresh = rows.filter((row) => !known.has(row.key) && (!row.endsAt || row.endsAt > Date.now()));
    state.officialApi[target] = rows;
    rows.forEach((row) => known.add(row.key));
    state.officialApi.knownEventKeys = [...known].slice(-500);
    if (initialized && state.engineAlerts.events && fresh.length) {
      const event = fresh[0];
      notifyIntel(`${cleanLabel(event.kind)} detected`, `${event.name} at [${event.x}, ${event.y}, ${event.z}]`);
    }
  };

  const capturePassiveGalaxyEvents = (pinia = getPinia()) => {
    if (!pinia?._s) return;
    const dungeon = pinia._s.get("DungeonStore");
    const boss = pinia._s.get("GalaxyBossStore");
    const rows = [];
    rows.push(...normalizeEventRows("dungeon", Array.isArray(dungeon?.squadDungeons) ? dungeon.squadDungeons : [], Date.now(), "loaded game client"));
    if (dungeon?.activeDungeon && typeof dungeon.activeDungeon === "object") rows.push(...normalizeEventRows("dungeon", [dungeon.activeDungeon], Date.now(), "loaded game client"));
    if (dungeon?.soloCurrentDungeon && typeof dungeon.soloCurrentDungeon === "object") rows.push(...normalizeEventRows("solo", [dungeon.soloCurrentDungeon], Date.now(), "loaded game client"));
    if (boss?.currentEvent && typeof boss.currentEvent === "object") rows.push(...normalizeEventRows("boss", [boss.currentEvent], Date.now(), "loaded game client"));
    const fresh = rows.filter((row) => row.x !== null && row.y !== null && (!row.endsAt || row.endsAt > Date.now() - 5 * 60 * 1000));
    const signature = (value) => JSON.stringify((Array.isArray(value) ? value : []).map((row) => [row.key, row.endsAt, row.status]));
    if (signature(state.officialApi.passiveEvents) !== signature(fresh)) {
      state.officialApi.passiveEvents = fresh.slice(0, 100);
      markDirty();
    }
  };

  const applyOfficialResult = (route, result) => {
    state.officialApi.caches[route] = {
      fetchedAt: Number(result?.fetchedAt || 0),
      remaining: String(result?.remaining ?? ""),
      limit: String(result?.limit ?? ""),
      reset: String(result?.reset ?? ""),
      cached: Boolean(result?.cached),
      stale: Boolean(result?.stale),
    };
    if (route === "user") applyOfficialUser(result);
    else if (route === "journal") applyOfficialJournal(result);
    else if (route === "stations") applyOfficialStations(result);
    else if (route === "market") applyOfficialMarket(result);
    else if (["dungeons", "solodungeons", "activerunes"].includes(route)) applyOfficialEvents(route, result);
  };

  const refreshOfficialStatus = async () => {
    const bridge = nativeBridgeConfig();
    state.officialApi.available = Boolean(bridge);
    state.officialApi.launcherVersion = String(bridge?.launcherVersion || "");
    if (!bridge) {
      state.officialApi.configured = false;
      state.officialApi.status = "upgrade";
      state.officialApi.message = "Install launcher 1.2.0 or newer to use official API tools securely";
      return false;
    }
    const result = await nativeBridgeJson("/status", { timeoutMs: 5000 });
    state.officialApi.configured = result.configured === true;
    state.officialApi.launcherVersion = String(result.launcherVersion || bridge.launcherVersion || "");
    state.officialApi.caches = { ...state.officialApi.caches, ...(result.caches || {}) };
    if (!state.officialApi.configured) {
      state.officialApi.status = "setup";
      state.officialApi.message = "Add your personal API key once on this PC";
    }
    return state.officialApi.configured;
  };

  let officialRefreshPromise = null;
  const refreshOfficialApi = async (manual = false) => {
    if (officialRefreshPromise) return officialRefreshPromise;
    officialRefreshPromise = (async () => {
      state.officialApi.busy = true;
      state.officialApi.status = "syncing";
      state.officialApi.message = "Refreshing official read-only data";
      state.lastPanelSignature = "";
      renderPanel();
      try {
        if (!await refreshOfficialStatus()) return;
        const routes = ["user", "journal", "stations", "market", "dungeons", "solodungeons", "activerunes"];
        const results = await Promise.allSettled(routes.map((route) => nativeBridgeJson(`/official/${route}`, { timeoutMs: route === "user" ? 45000 : 30000 })));
        const errors = [];
        results.forEach((outcome, index) => {
          if (outcome.status === "fulfilled") {
            try { applyOfficialResult(routes[index], outcome.value); }
            catch (error) { errors.push(String(error?.message || error)); }
          } else errors.push(String(outcome.reason?.message || outcome.reason));
        });
        const successes = results.length - errors.length;
        if (!successes) throw new Error(errors[0] || "No official API routes could be refreshed");
        state.officialApi.lastRefreshAt = Date.now();
        state.officialApi.status = errors.length ? "warning" : "online";
        state.officialApi.message = errors.length
          ? `${successes} official feeds updated • ${errors[0].slice(0, 100)}`
          : `Official data current • ${manual ? "manual check complete" : "automatic cache refresh"}`;
        markDirty();
      } catch (error) {
        state.officialApi.status = "error";
        state.officialApi.message = error?.name === "AbortError" ? "Official API refresh timed out" : String(error?.message || error).slice(0, 150);
      } finally {
        state.officialApi.busy = false;
        state.lastPanelSignature = "";
        markDirty();
        renderPanel();
      }
    })();
    try { await officialRefreshPromise; }
    finally { officialRefreshPromise = null; }
  };

  const saveOfficialApiKey = async (key) => {
    state.officialApi.busy = true;
    state.officialApi.status = "syncing";
    state.officialApi.message = "Saving the key securely for this Windows account";
    state.lastPanelSignature = "";
    renderPanel();
    try {
      await nativeBridgeJson("/key", { method: "POST", body: { key }, timeoutMs: 10000 });
      state.officialApi.configured = true;
      state.officialApi.message = "API key saved securely • checking account data";
    } catch (error) {
      state.officialApi.status = "error";
      state.officialApi.message = String(error?.message || error).slice(0, 150);
    } finally {
      state.officialApi.busy = false;
      state.lastPanelSignature = "";
      renderPanel();
    }
    if (state.officialApi.configured) refreshOfficialApi(true);
  };

  const removeOfficialApiKey = async () => {
    state.officialApi.busy = true;
    state.officialApi.status = "syncing";
    state.officialApi.message = "Removing the local API key and encrypted cache";
    state.lastPanelSignature = "";
    renderPanel();
    try {
      await nativeBridgeJson("/key", { method: "DELETE", timeoutMs: 10000 });
      state.officialApi.configured = false;
      state.officialApi.caches = {};
      state.officialApi.market = [];
      state.officialApi.stations = [];
      state.officialApi.dungeons = [];
      state.officialApi.soloDungeons = [];
      state.officialApi.activeRunes = [];
      state.officialApi.status = "setup";
      state.officialApi.message = "Official API disconnected on this PC";
      markDirty();
    } catch (error) {
      state.officialApi.status = "error";
      state.officialApi.message = String(error?.message || error).slice(0, 150);
    } finally {
      state.officialApi.busy = false;
      state.lastPanelSignature = "";
      renderPanel();
    }
  };

  const bootstrapSyncOutbox = (includeSystems = true) => {
    for (const [key, history] of Object.entries(state.xpHistory)) {
      const username = state.profiles[key]?.username || key;
      for (const sample of Array.isArray(history) ? history : []) queueSyncXp(username, sample);
    }
    for (const [key, history] of Object.entries(state.resourceHistory)) {
      const username = state.profiles[key]?.username || state.resourceRankings.rows[key]?.username || key;
      for (const sample of Array.isArray(history) ? history : []) {
        const source = resourceSourceKind(sample?.source);
        if (source) queueSyncResource(username, { ...sample, source });
      }
    }
    Object.values(state.profiles).forEach(queueSyncProfile);
    if (includeSystems) Object.keys(state.seen).forEach(queueSyncSystem);
    state.sync.systemSyncVersion = SYSTEM_SYNC_VERSION;
    markDirty();
  };

  const syncPlayerKeys = () => {
    const keys = new Set([state.selfProfileKey]);
    state.squadMembers.forEach((member) => keys.add(String(member.username || "").toLowerCase()));
    state.favorites.forEach((key) => keys.add(key));
    return [...keys].filter(Boolean).slice(0, 100);
  };

  const requestDetailedHistory = (key) => {
    const normalized = String(key || state.selfProfileKey || syncPlayerKeys()[0] || "").toLowerCase();
    if (!normalized || !syncPlayerKeys().includes(normalized)) return;
    state.sync.historyRequestKey = normalized;
    scheduleSharedSync(250);
  };

  const mergeSharedXp = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const username = syncUsername(row?.username);
      const key = username.toLowerCase();
      if (!key || !row?.activities || !Object.keys(row.activities).length) continue;
      ensureProfileShell(username, "shared companion database");
      const local = Array.isArray(state.xpHistory[key]) ? state.xpHistory[key] : [];
      const remote = {
        at: Number(row.at) || 0,
        source: "shared",
        activities: plain(row.activities),
      };
      if (!remote.at) continue;
      const merged = [...local, remote];
      const unique = new Map(merged.map((sample) => [`${sample.at}:${JSON.stringify(sample.activities)}`, sample]));
      state.xpHistory[key] = pruneXpHistory([...unique.values()]);
    }
  };

  const mergeSharedResources = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const username = syncUsername(row?.username);
      const key = username.toLowerCase();
      const value = finite(row?.value);
      const at = finite(row?.at);
      const source = resourceSourceKind(row?.source);
      if (!key || value === null || at === null || !source) continue;
      ensureProfileShell(username, "shared companion database");
      const local = Array.isArray(state.resourceHistory[key]) ? state.resourceHistory[key] : [];
      const unique = new Map([...local, { at, value, source }].map((sample) => [`${sample.at}:${sample.value}`, sample]));
      state.resourceHistory[key] = pruneXpHistory(cleanResourceHistory({ [key]: [...unique.values()] })[key] || []);
    }
  };

  const mergeSharedProfiles = (rows) => {
    for (const remote of Array.isArray(rows) ? rows : []) {
      const username = syncUsername(remote?.username);
      const key = username.toLowerCase();
      if (!key) continue;
      const local = state.profiles[key];
      const capturedAt = Number(remote.capturedAt) || 0;
      if (local?.live || Number(local?.capturedAt || 0) >= capturedAt) continue;
      state.profiles[key] = {
        ...(local || {}),
        ...plain(remote),
        username,
        capturedAt,
        source: "shared companion database",
        placeholder: false,
        levels: primitiveMap(remote.levels || {}, 28),
        stats: Object.fromEntries(Object.entries(primitiveMap(remote.stats || {}, 80)).filter(([stat]) => !/^npcMat_/i.test(stat))),
        technology: primitiveMap(remote.technology || {}, 40),
        pets: Array.isArray(remote.pets) ? plain(remote.pets.slice(0, 30)) : [],
        gear: Array.isArray(remote.gear) ? plain(remote.gear.slice(0, 12)) : [],
      };
    }
  };

  const mergeSharedSummaries = (summaries) => {
    for (const row of Array.isArray(summaries?.xp) ? summaries.xp : []) {
      const username = syncUsername(row?.username || row?.key);
      const key = username.toLowerCase();
      if (!key || !row?.latest || !row?.baselines) continue;
      ensureProfileShell(username, "shared companion database");
      const previous = state.sharedSummaries.xp[key];
      if (!previous || Number(row.updatedAt || 0) >= Number(previous.updatedAt || 0)) state.sharedSummaries.xp[key] = plain({ ...row, key, username });
    }
    for (const row of Array.isArray(summaries?.resources) ? summaries.resources : []) {
      const username = syncUsername(row?.username || row?.key);
      const key = username.toLowerCase();
      if (!key || !row?.latest || !row?.baselines) continue;
      ensureProfileShell(username, "shared companion database");
      const previous = state.sharedSummaries.resources[key];
      if (!previous || Number(row.updatedAt || 0) >= Number(previous.updatedAt || 0)) state.sharedSummaries.resources[key] = plain({ ...row, key, username });
    }
  };

  const mergeSharedSystems = (rows) => {
    let changed = false;
    for (const remote of Array.isArray(rows) ? rows : []) {
      const x = finite(remote?.x);
      const y = finite(remote?.y);
      const z = finite(remote?.z);
      const firstSeenAt = finite(remote?.firstSeenAt);
      if (x === null || y === null || z === null || firstSeenAt === null) continue;
      const key = `${z}:${x},${y}`;
      if (!state.seen[key] || firstSeenAt < Number(state.seen[key])) {
        state.seen[key] = firstSeenAt;
        changed = true;
      }
      const nodeObservedAt = Math.max(0, Number(remote?.nodeObservedAt || 0));
      const localNodeObservedAt = Math.max(0, Number(state.nodeObservations[key] || state.systems[key]?.verifiedAt || 0));
      // Legacy rows did not carry proof of an exact native node-quality observation.
      // They remain useful for "systems seen" but cannot enter the perfect-node finder.
      if (!nodeObservedAt || nodeObservedAt <= localNodeObservedAt) continue;
      state.nodeObservations[key] = nodeObservedAt;
      const nodes = (Array.isArray(remote?.nodes) ? remote.nodes : []).filter((node) => Number(node?.quality) === 100).slice(0, 24).map((node) => ({
        id: String(node?.id || "").slice(0, 100),
        type: String(node?.type || "resource").slice(0, 80),
        body: String(node?.body || "Planet").slice(0, 80),
        quality: 100,
      }));
      if (!nodes.length) {
        if (state.systems[key]) delete state.systems[key];
        changed = true;
        continue;
      }
      const normalized = {
        id: String(remote?.id || "").slice(0, 100),
        name: String(remote?.name || "Unknown system").slice(0, 120),
        x,
        y,
        z,
        nodes,
        seenAt: Number(state.systems[key]?.seenAt || firstSeenAt),
        verifiedAt: nodeObservedAt,
      };
      const signature = (value) => JSON.stringify({
        id: value?.id || "",
        name: value?.name || "",
        x: value?.x,
        y: value?.y,
        z: value?.z,
        nodes: value?.nodes || [],
      });
      if (signature(state.systems[key]) !== signature(normalized)) {
        state.systems[key] = normalized;
        changed = true;
      }
    }
    if (changed) markDirty();
  };

  const applySharedSync = (payload, requestedHistoryKey = "") => {
    const serverFavoriteTime = Number(payload?.favoritesUpdatedAt || 0);
    if (serverFavoriteTime > state.sync.favoritesUpdatedAt && Array.isArray(payload?.favorites)) {
      state.favorites = new Set(payload.favorites.map((value) => String(value || "").toLowerCase()).filter(Boolean));
      if (state.selfProfileKey) state.favorites.delete(state.selfProfileKey);
      state.sync.favoritesUpdatedAt = serverFavoriteTime;
      state.sync.summaryPlayerSet = "";
      scheduleSharedSync(1000);
    }
    mergeSharedProfiles(payload?.profiles);
    mergeSharedSummaries(payload?.summaries);
    mergeSharedXp(payload?.xp);
    mergeSharedResources(payload?.resources);
    mergeSharedSystems(payload?.systems);
    const summaryPulledAt = Number(payload?.summaryCursor || 0);
    if (summaryPulledAt > state.sync.summaryPulledAt) state.sync.summaryPulledAt = summaryPulledAt;
    const historyPulledAt = Number(payload?.historyCursor || 0);
    if (payload?.historyIncluded === true && requestedHistoryKey && historyPulledAt > Number(state.sync.historyCursors[requestedHistoryKey] || 0)) {
      state.sync.historyCursors[requestedHistoryKey] = historyPulledAt;
      if (state.sync.historyRequestKey === requestedHistoryKey) state.sync.historyRequestKey = "";
    }
    const systemsPulledAt = Number(payload?.systemsCursor || 0);
    if (systemsPulledAt > state.sync.systemsPulledAt) state.sync.systemsPulledAt = systemsPulledAt;
    if (payload?.battleModel && typeof payload.battleModel === "object") state.sync.battleModel = plain(payload.battleModel);
    state.sync.lastPullAt = Date.now();
    state.lastPanelSignature = "";
    markDirty();
  };

  let syncDrainTimer = 0;
  const runSharedSync = async (force = false) => {
    if (!state.sync.enabled || state.sync.busy) return;
    if (!force && Date.now() < state.sync.nextAttemptAt) return;
    const endpoint = syncEndpoint();
    const owner = syncOwner();
    if (!endpoint || state.sync.token.length < 32 || !owner) {
      state.sync.status = "setup";
      state.sync.message = !owner ? "Waiting for your player profile" : state.sync.authMode === "steam" ? "Reconnect this device with Steam" : "Connect with Steam or add a recovery code";
      if (force) {
        state.lastPanelSignature = "";
        renderPanel();
      }
      return;
    }
    const players = syncPlayerKeys();
    const playerSet = [...players].sort().join("|");
    if (playerSet !== state.sync.summaryPlayerSet) {
      state.sync.summaryPlayerSet = playerSet;
      state.sync.summaryPulledAt = 0;
      markDirty();
    }
    const now = Date.now();
    const hasOutbound = state.sync.outboxXp.length > 0 || state.sync.outboxResources.length > 0
      || Object.keys(state.sync.outboxProfiles).length > 0 || state.sync.outboxSystems.length > 0 || state.sync.outboxBattles.length > 0;
    const dirtyDue = hasOutbound && now - state.sync.lastPushAt >= SYNC_DIRTY_MIN_GAP_MS;
    const idleDue = now - state.sync.lastPullAt >= SYNC_IDLE_INTERVAL_MS;
    const selectedHistoryKey = state.sync.historyRequestKey || (state.tab === "xp" && idleDue ? String(state.selectedProfile || state.selfProfileKey || "").toLowerCase() : "");
    const needsHistory = Boolean(selectedHistoryKey && players.includes(selectedHistoryKey));
    if (!force && !dirtyDue && !idleDue && !needsHistory && state.sync.summaryPulledAt > 0) {
      if (hasOutbound) scheduleSharedSync(Math.max(1000, SYNC_DIRTY_MIN_GAP_MS - (now - state.sync.lastPushAt) + 250));
      return;
    }

    state.sync.outboxXp = coalesceSyncSamples(state.sync.outboxXp);
    state.sync.outboxResources = coalesceSyncSamples(state.sync.outboxResources);
    trimBattleOutbox();
    const battleBatch = [];
    let battleBytes = 0;
    for (const battle of state.sync.outboxBattles.slice(0, BATTLE_SYNC_BATCH_SIZE)) {
      const bytes = JSON.stringify(battle).length;
      if (battleBytes + bytes > 280000) break;
      battleBatch.push(battle);
      battleBytes += bytes;
    }
    const xpBatch = state.sync.outboxXp.slice(0, battleBatch.length ? 50 : 250);
    const resourceBatch = state.sync.outboxResources.slice(0, battleBatch.length ? 50 : 250);
    const profileBatch = Object.values(state.sync.outboxProfiles).slice(0, battleBatch.length ? 2 : 40);
    const systemKeys = state.sync.outboxSystems.slice(0, battleBatch.length ? 10 : SYSTEM_SYNC_BATCH_SIZE);
    const systemBatch = systemKeys.map(sanitizedSyncSystem).filter(Boolean);
    let continueSync = false;
    state.sync.busy = true;
    state.sync.status = "syncing";
    state.sync.message = "Uploading observations and checking for updates";
    state.lastPanelSignature = "";
    renderPanel();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${endpoint}/v1/sync`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: VERSION,
          owner,
          token: state.sync.token,
          authMode: state.sync.authMode,
          favorites: [...state.favorites],
          favoritesUpdatedAt: state.sync.favoritesUpdatedAt,
          players,
          xp: xpBatch,
          resources: resourceBatch,
          profiles: profileBatch,
          systems: systemBatch,
          battles: battleBatch,
          systemsSince: state.sync.systemsPulledAt,
          summarySince: state.sync.summaryPulledAt,
          historyPlayers: needsHistory ? [selectedHistoryKey] : [],
          historySince: needsHistory ? Number(state.sync.historyCursors[selectedHistoryKey] || 0) : 0,
          historyDays: SYNC_HISTORY_DAYS,
        }),
        signal: controller.signal,
      });
      const result = safeParse(await response.text(), null);
      if (!response.ok || !result?.ok) {
        const failure = new Error(result?.error || `HTTP ${response.status}`);
        failure.retryAt = Number(result?.retryAt || 0);
        throw failure;
      }
      state.sync.outboxXp.splice(0, xpBatch.length);
      state.sync.outboxResources.splice(0, resourceBatch.length);
      state.sync.outboxSystems.splice(0, systemKeys.length);
      const sentBattles = new Set(battleBatch.map((row) => row.x));
      state.sync.outboxBattles = state.sync.outboxBattles.filter((row) => !sentBattles.has(row.x));
      for (const profile of profileBatch) {
        const key = String(profile?.username || "").toLowerCase();
        if (Number(state.sync.outboxProfiles[key]?.capturedAt) === Number(profile?.capturedAt)) delete state.sync.outboxProfiles[key];
      }
      state.sync.lastPushAt = Date.now();
      applySharedSync(result, needsHistory ? selectedHistoryKey : "");
      state.sync.failureCount = 0;
      state.sync.nextAttemptAt = 0;
      state.sync.status = "online";
      state.sync.message = `Connected • ${Number(result.accepted || 0)} queued items processed`;
      continueSync = state.sync.outboxXp.length > 0 || state.sync.outboxResources.length > 0
        || Object.keys(state.sync.outboxProfiles).length > 0 || state.sync.outboxSystems.length > 0 || state.sync.outboxBattles.length > 0 || result.systemsMore === true;
    } catch (error) {
      state.sync.failureCount = Math.min(10, state.sync.failureCount + 1);
      const serverRetryAt = Number(error?.retryAt || 0);
      const retryDelay = Math.min(30 * 60 * 1000, 30000 * (2 ** Math.max(0, state.sync.failureCount - 1)));
      state.sync.nextAttemptAt = serverRetryAt > Date.now() ? serverRetryAt : Date.now() + retryDelay;
      state.sync.status = "error";
      state.sync.message = error?.name === "AbortError" ? "Sync timed out — retrying later" : `Sync paused: ${String(error?.message || error).slice(0, 120)}`;
    } finally {
      clearTimeout(timeout);
      state.sync.busy = false;
      state.lastPanelSignature = "";
      markDirty();
      renderPanel();
      if (continueSync) {
        clearTimeout(syncDrainTimer);
        syncDrainTimer = setTimeout(() => runSharedSync(true), 2500);
      }
    }
  };

  const ageLabel = (timestamp) => {
    const age = Math.max(0, Date.now() - Number(timestamp || 0));
    if (age < 60000) return "now";
    if (age < 3600000) return `${Math.floor(age / 60000)}m`;
    if (age < 86400000) return `${Math.floor(age / 3600000)}h`;
    return `${Math.floor(age / 86400000)}d`;
  };

  const profileFor = (username) => state.profiles[String(username || "").toLowerCase()];
  const locationFor = (username) => state.locations[String(username || "").toLowerCase()];

  const listedPlayerKeys = (includeCurrentRoute = false) => {
    const keys = new Set(state.squadMembers.map((member) => member.username.toLowerCase()));
    state.favorites.forEach((key) => keys.add(key));
    if (state.selfProfileKey) keys.add(state.selfProfileKey);
    if (includeCurrentRoute) {
      const routeKey = routeProfileName().toLowerCase();
      if (routeKey) keys.add(routeKey);
    }
    return [...keys]
      .filter((key) => state.profiles[key])
      .sort((a, b) => state.profiles[a].username.localeCompare(state.profiles[b].username));
  };

  const currentCoordinates = () => {
    const current = getPinia()?._s?.get("ExploreStore")?.currentSystem || state.operations?.currentSystem;
    return {
      x: finite(current?.coordinate_x),
      y: finite(current?.coordinate_y),
      z: finite(current?.coordinate_z ?? 1) ?? 1,
      name: String(current?.name || "Current system"),
    };
  };

  const updateSessionFromProfile = (profile) => {
    if (!profile || !profile.live && String(profile.username || "").toLowerCase() !== state.selfProfileKey) return;
    const now = Date.now();
    if (!state.session.startAt || now - Number(state.session.lastActiveAt || now) > 6 * 60 * 60 * 1000) {
      state.session = {
        startAt: now,
        lastActiveAt: now,
        baselineXp: {},
        baselineResources: null,
        baselineSeen: Object.keys(state.seen).length,
        baselinePerfect: verifiedPerfectCount(),
      };
    }
    const activities = xpActivitiesFromLevels(profile.levels);
    const before = JSON.stringify([state.session.latestXp || {}, state.session.latestResources]);
    if (!Object.keys(state.session.baselineXp || {}).length) state.session.baselineXp = plain(activities);
    state.session.latestXp = plain(activities);
    const resources = finite(profile.stats?.resources);
    if (state.session.baselineResources === null && resources !== null) state.session.baselineResources = resources;
    if (resources !== null) state.session.latestResources = resources;
    const changed = before !== JSON.stringify([state.session.latestXp || {}, state.session.latestResources]);
    if (changed || now - Number(state.session.lastActiveAt || 0) >= 60 * 1000) {
      state.session.lastActiveAt = now;
      markDirty();
    }
  };

  const sessionXpGain = (activity) => xpDelta(
    { activities: state.session.baselineXp || {} },
    { activities: state.session.latestXp || {} },
    activity
  );

  const confidenceForTrend = (trend, minimumMs) => {
    if (!trend?.latest) return { level: "none", label: "No data", detail: "No observation has been recorded" };
    const age = Math.max(0, Date.now() - Number(trend.latest.at || 0));
    const samples = Number(trend.sampleCount || 0);
    const span = Number(trend.elapsed || 0);
    if (trend.withheld) return { level: "low", label: "Rate withheld", detail: `${trend.outliers} statistical outlier${trend.outliers === 1 ? "" : "s"} detected across ${samples} samples` };
    if (trend.rate === null || span < minimumMs) return { level: "pending", label: "Calibrating", detail: `${samples} samples • ${durationLabel(span)} span` };
    if (age > 24 * 60 * 60 * 1000) return { level: "low", label: "Stale", detail: `${samples} samples • last seen ${ageLabel(trend.latest.at)} ago` };
    if (span >= 24 * 60 * 60 * 1000 && samples >= 4) return { level: "high", label: "High confidence", detail: `${samples} samples • ${durationLabel(span)} span` };
    if (span >= 60 * 60 * 1000 && samples >= 2) return { level: "medium", label: "Medium confidence", detail: `${samples} samples • ${durationLabel(span)} span` };
    return { level: "low", label: "Low confidence", detail: `${samples} samples • ${durationLabel(span)} span` };
  };

  const filteredPerfectSystems = () => {
    const query = String(state.nodeFinder.query || "").trim().toLowerCase();
    return nodeRows().filter((system) => !query || system.name.toLowerCase().includes(query)
      || system.nodes.some((node) => `${node.type} ${node.body}`.toLowerCase().includes(query)));
  };

  const plannedNodeRoute = () => {
    const origin = currentCoordinates();
    const candidates = filteredPerfectSystems().filter((system) => Number(system.z) === Number(origin.z));
    const remaining = [...candidates];
    const route = [];
    let cursor = origin.x === null || origin.y === null ? null : { x: origin.x, y: origin.y };
    while (remaining.length && route.length < state.nodeFinder.maxStops) {
      let index = 0;
      if (cursor) {
        index = remaining.reduce((best, row, candidateIndex) => {
          const bestDistance = Math.hypot(remaining[best].x - cursor.x, remaining[best].y - cursor.y);
          const candidateDistance = Math.hypot(row.x - cursor.x, row.y - cursor.y);
          return candidateDistance < bestDistance ? candidateIndex : best;
        }, 0);
      }
      const next = remaining.splice(index, 1)[0];
      const distance = cursor ? Math.hypot(next.x - cursor.x, next.y - cursor.y) : null;
      route.push({ ...next, distance });
      cursor = next;
    }
    return route;
  };

  const allGalaxyEvents = () => [
    ...state.officialApi.dungeons,
    ...state.officialApi.soloDungeons,
    ...state.officialApi.activeRunes,
    ...state.officialApi.passiveEvents,
  ].filter((event) => event.endsAt ? event.endsAt > Date.now() - 5 * 60 * 1000 : Number(event.fetchedAt || 0) > Date.now() - 2 * 60 * 60 * 1000)
    .reduce((unique, event) => unique.set(event.key, event), new Map()).values();

  const activeGalaxyEvents = () => [...allGalaxyEvents()].sort((a, b) => (a.endsAt || Infinity) - (b.endsAt || Infinity));

  const countdownLabel = (timestamp) => {
    const due = Number(timestamp || 0);
    if (!due) return "time unavailable";
    const remaining = due - Date.now();
    return remaining > 0 ? `${cooldownTimeLabel(remaining)} remaining` : `${ageLabel(due)} ago`;
  };

  const nodeRows = () => {
    const current = currentCoordinates();
    const currentX = current.x;
    const currentY = current.y;
    const currentZ = current.z;
    return Object.entries(state.systems).filter(([key]) => Number(state.nodeObservations[key] || 0) > 0).map(([, system]) => ({
      ...system,
      nodes: (Array.isArray(system?.nodes) ? system.nodes : []).filter((node) => Number(node?.quality) === 100),
      distanceFromCurrent: currentX !== null && currentY !== null && Number(system?.z) === Number(currentZ)
        ? Math.hypot(Number(system.x) - currentX, Number(system.y) - currentY)
        : null,
    })).filter((system) => system.nodes.length).sort((a, b) => {
      if (currentX === null || currentY === null) return b.seenAt - a.seenAt;
      const da = a.distanceFromCurrent ?? Infinity;
      const db = b.distanceFromCurrent ?? Infinity;
      return da - db;
    });
  };

  const renderNodes = () => {
    const rows = filteredPerfectSystems();
    const route = plannedNodeRoute();
    const routeKeys = new Set(route.map((system) => `${system.z}:${system.x},${system.y}`));
    const remainingRows = rows.filter((system) => !routeKeys.has(`${system.z}:${system.x},${system.y}`));
    const events = activeGalaxyEvents();
    const eventFetchedAt = Math.max(0, ...["dungeons", "solodungeons", "activerunes"].map((key) => Number(state.officialApi.caches[key]?.fetchedAt || 0)));
    const eventFeedAge = eventFetchedAt ? Date.now() - eventFetchedAt : Infinity;
    const eventFeedClass = state.officialApi.status === "error" ? "error" : eventFeedAge > 60 * 60 * 1000 ? "stale" : "ready";
    const eventFeedTitle = state.officialApi.status === "error" ? "Official event feed needs attention" : eventFeedAge > 60 * 60 * 1000 ? "Official event feed is stale" : "Official event feed current";
    const eventFeedDetail = state.officialApi.status === "error"
      ? state.officialApi.message
      : eventFetchedAt ? `Last official event refresh ${ageLabel(eventFetchedAt)} ago` : "No official event refresh has completed";
    const seenCount = Object.keys(state.seen).length;
    const stationRows = state.officialApi.stations.filter((station) => {
      const squadron = String(state.profiles[state.selfProfileKey]?.squadron || "").toLowerCase();
      return !squadron || !station.squadron || station.squadron.toLowerCase() === squadron;
    });
    return `
      <div class="so-metrics">
        <div><strong>${seenCount}</strong><span>systems seen</span></div>
        <div><strong>${rows.length}</strong><span>matching perfect systems</span></div>
      </div>
      <section><h3>Galaxy event radar</h3>
        <p class="so-note">Official dungeon, solo-dungeon and active-rune feeds, plus events already loaded in the game client. Colored map markers are informational and never initiate travel.</p>
        <div class="so-event-feed ${eventFeedClass}"><strong>${esc(eventFeedTitle)}</strong><span>${esc(eventFeedDetail)}</span>${state.officialApi.status === "error" ? `<small>Open Sync, remove the rejected key, and save a newly generated key from your Stellar Odyssey profile.</small>` : ""}</div>
        <div class="so-event-list">${events.length ? events.slice(0, 40).map((event) => `
          <article class="so-event ${esc(event.kind)}">
            <span class="so-event-kind">${esc(event.kind === "solo" ? "SOLO" : event.kind.toUpperCase())}</span>
            <div><strong>${esc(event.name)}</strong><small>${esc(event.systemName)}${event.x !== null && event.y !== null ? ` • [${event.x}, ${event.y}, ${event.z}]` : " • coordinates unavailable"}${event.status ? ` • ${esc(event.status)}` : ""}</small><small>${event.endsAt ? esc(countdownLabel(event.endsAt)) : "expiry unavailable"}${event.weakness ? ` • Weakness: ${esc(cleanLabel(event.weakness))}` : ""} • ${esc(event.source || "official API")}</small></div>
            ${event.x !== null && event.y !== null ? `<button data-action="copy-coordinate" data-coordinate="${event.x}, ${event.y}, ${event.z}" title="Copy coordinates">Copy</button>` : ""}
          </article>`).join("") : `<div class="so-empty">No active event is available. A valid official API key supplies the global feed; opening the game's dungeon/event pages can also expose passive local entries.</div>`}</div>
      </section>
      <section><h3>Perfect-node finder</h3>
        <div class="so-tool-controls">
          <label>Resource or planet<input data-action="node-query" value="${esc(state.nodeFinder.query)}" placeholder="e.g. titanium"></label>
          <label>Route stops<select data-action="node-stops">${[1,2,3,4,5,6,7,8].map((value) => `<option value="${value}" ${value === state.nodeFinder.maxStops ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        </div>
        <p class="so-note">${state.officialApi.jumps ? `Journal: ${compactNumber(state.officialApi.jumps)} jumps across ${compactNumber(state.officialApi.journalSystems)} coordinates. ` : ""}Routes use a nearest-next heuristic on your current Z layer. Only systems with a version 1.6+ exact native <strong>nodeQuality = 100</strong> observation are eligible; legacy unverified records stay hidden until rescanned.</p>
        <div class="so-route-list">${route.length ? route.map((system, index) => `
          <article class="so-route-row"><b>${index + 1}</b><div><strong>${esc(system.name)}</strong><span>[${system.x}, ${system.y}, ${system.z}]${system.distanceFromCurrent !== null ? ` • ${system.distanceFromCurrent.toFixed(1)} units from you` : ""}${index > 0 && system.distance !== null ? ` • ${system.distance.toFixed(1)} from prior stop` : ""}</span></div><div class="so-inline-actions"><button data-action="add-waypoint" data-key="${system.z}:${system.x},${system.y}">Save</button><button data-action="copy-coordinate" data-coordinate="${system.x}, ${system.y}, ${system.z}">Copy</button></div></article>`).join("") : `<div class="so-empty">No matching perfect systems are available on this map layer.</div>`}</div>
      </section>
      <section><h3>${route.length ? "Other perfect-node matches" : "Perfect-node matches"}</h3><div class="so-list">
        ${remainingRows.length ? remainingRows.slice(0, 150).map((system) => `
          <article class="so-row">
            <div class="so-row-main"><strong>${esc(system.name)}</strong><span>[${system.x}, ${system.y}, ${system.z}]${system.distanceFromCurrent !== null ? ` • ${system.distanceFromCurrent.toFixed(1)} units away` : " • different Z layer"}</span></div>
            <div class="so-chips">${system.nodes.map((node) => `<span title="${esc(node.body)}">${esc(node.type)} 100%</span>`).join("")}</div>
            <div class="so-inline-actions"><button data-action="add-waypoint" data-key="${system.z}:${system.x},${system.y}">Save waypoint</button><button data-action="copy-coordinate" data-coordinate="${system.x}, ${system.y}, ${system.z}">Copy coordinates</button></div>
          </article>
        `).join("") : `<div class="so-empty">${route.length ? "All current matches are already included in the route above." : "No 100% resource nodes have appeared in loaded map data yet."}</div>`}
      </div></section>
      ${state.waypoints.length ? `<section><h3>Saved manual waypoints</h3><div class="so-list">${state.waypoints.map((waypoint, index) => `<article class="so-row"><div class="so-row-main"><strong>${esc(waypoint.name)}</strong><span>[${waypoint.x}, ${waypoint.y}, ${waypoint.z}]</span></div><div class="so-inline-actions"><button data-action="copy-coordinate" data-coordinate="${waypoint.x}, ${waypoint.y}, ${waypoint.z}">Copy</button><button data-action="remove-waypoint" data-index="${index}">Remove</button></div></article>`).join("")}</div><p class="so-note">Waypoints are manual notes stored on this device. They never control the map or move your ship.</p></section>` : ""}
      ${stationRows.length ? `<section><h3>Squadron stations from official API</h3><div class="so-list">${stationRows.slice(0, 30).map((station) => `
        <article class="so-row"><div class="so-row-main"><strong>${esc(station.name)}</strong><span>[${station.x}, ${station.y}, ${station.z}]</span></div><div class="so-chips muted"><span>${esc(station.squadron || "Squadron station")}</span></div></article>
      `).join("")}</div></section>` : ""}`;
  };

  const marketRows = () => state.officialApi.market.map((order) => {
    const prices = [...(Array.isArray(order.prices) ? order.prices : [])].sort((a, b) => Number(a.hour) - Number(b.hour));
    const latest = prices.at(-1);
    const first = prices[0];
    const sells = prices.map((price) => finite(price.sell)).filter((value) => value !== null);
    const average = sells.length ? sells.reduce((sum, value) => sum + value, 0) / sells.length : null;
    const deviation = average && sells.length > 1 ? Math.sqrt(sells.reduce((sum, value) => sum + (value - average) ** 2, 0) / sells.length) : null;
    return {
      currency: order.currency,
      prices,
      latest,
      buyChange: latest?.buy !== null && first?.buy !== null ? latest.buy - first.buy : null,
      sellChange: latest?.sell !== null && first?.sell !== null ? latest.sell - first.sell : null,
      low: sells.length ? Math.min(...sells) : null,
      high: sells.length ? Math.max(...sells) : null,
      volatility: average && deviation !== null ? deviation / average * 100 : null,
    };
  }).filter((row) => row.latest).sort((a, b) => a.currency.localeCompare(b.currency));

  const marketSparkline = (row) => {
    const values = row.prices.map((price) => finite(price.sell)).filter((value) => value !== null);
    if (values.length < 2) return "";
    const low = Math.min(...values);
    const range = Math.max(1, Math.max(...values) - low);
    const points = values.map((value, index) => `${(index / (values.length - 1) * 100).toFixed(1)},${(28 - (value - low) / range * 24).toFixed(1)}`).join(" ");
    return `<svg class="so-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label="24 hour sell trend"><polyline points="${points}"></polyline></svg>`;
  };

  const evaluateMarketAlerts = () => {
    for (const row of marketRows()) {
      const alert = state.marketTools.alerts[row.currency];
      const price = finite(row.latest?.sell);
      const target = finite(alert?.target);
      if (price === null || target === null) continue;
      const hit = alert.direction === "below" ? price <= target : price >= target;
      const signature = `${alert.direction}:${target}:${row.latest.hour}`;
      if (hit && state.marketTools.notified[row.currency] !== signature) {
        state.marketTools.notified[row.currency] = signature;
        notifyIntel(`${cleanLabel(row.currency)} market alert`, `Sell price ${compactNumber(price)} is ${alert.direction} ${compactNumber(target)}`);
        markDirty();
      }
    }
  };

  const renderMarket = () => {
    const rows = marketRows();
    const cache = state.officialApi.caches.market || {};
    const change = (value) => value === null ? "—" : `${value > 0 ? "+" : ""}${compactNumber(value)}`;
    const portfolio = rows.reduce((total, row) => total + Math.max(0, finite(state.marketTools.holdings[row.currency]) || 0) * Math.max(0, finite(row.latest?.sell) || 0), 0);
    return `
      <div class="so-market-summary">
        <strong>${rows.length}</strong><span>currencies with official 24-hour history</span>
        <small>${cache.fetchedAt ? `Snapshot ${ageLabel(cache.fetchedAt)} ago${cache.remaining !== undefined && cache.remaining !== "" ? ` • ${esc(cache.remaining)} of ${esc(cache.limit || 50)} calls left today` : ""}` : "Connect the official API in Sync to load prices."}</small>
      </div>
      <div class="so-market-portfolio"><span>Manual holdings estimate</span><strong>${compactNumber(portfolio)}</strong><small>Uses amounts you enter below × latest sell price. Inventory is never displayed or read for this.</small></div>
      <p class="so-note">Hourly summaries come from the official read-only API, not individual live listings. Alerts are checked only when a cached market refresh completes.</p>
      <div class="so-market-list">${rows.length ? rows.map((row) => {
        const alert = state.marketTools.alerts[row.currency] || {};
        return `<article class="so-market-card">
          <div class="so-market-heading"><strong>${esc(cleanLabel(row.currency))}</strong><span>${row.volatility === null ? "—" : row.volatility.toFixed(1) + "%"} volatility</span></div>
          ${marketSparkline(row)}
          <div class="so-market-values"><div><span>Buy</span><b>${compactNumber(row.latest.buy)}</b><small>${change(row.buyChange)} / 24h</small></div><div><span>Sell</span><b>${compactNumber(row.latest.sell)}</b><small>${change(row.sellChange)} / 24h</small></div><div><span>Low / high</span><b>${compactNumber(row.low)} / ${compactNumber(row.high)}</b><small>sell history</small></div></div>
          <div class="so-market-tools"><label>Holding<input type="number" min="0" data-action="market-holding" data-currency="${esc(row.currency)}" value="${esc(state.marketTools.holdings[row.currency] || "")}" placeholder="0"></label><label>Alert target<input type="number" min="0" data-action="market-alert-target" data-currency="${esc(row.currency)}" value="${esc(alert.target || "")}" placeholder="price"></label><select data-action="market-alert-direction" data-currency="${esc(row.currency)}"><option value="above" ${alert.direction !== "below" ? "selected" : ""}>at/above</option><option value="below" ${alert.direction === "below" ? "selected" : ""}>at/below</option></select></div>
        </article>`;
      }).join("") : `<div class="so-empty">No official market history is cached yet.</div>`}</div>`;
  };

  const renderRoster = () => {
    const squadNames = new Set(state.squadMembers.map((member) => member.username.toLowerCase()));
    const names = new Map();
    state.squadMembers.forEach((member) => names.set(member.username.toLowerCase(), member.username));
    state.favorites.forEach((key) => names.set(key, state.profiles[key]?.username || state.locations[key]?.username || key));
    const rows = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const readyCount = rows.filter(([key]) => {
      const profile = state.profiles[key];
      return profile && !profile.placeholder && Date.now() - Number(profile.capturedAt || 0) < 24 * 60 * 60 * 1000;
    }).length;
    const squadron = state.operations.squadron || {};
    const bonuses = displayMap(squadron.pvpBonuses || squadron.bonuses || {}, 24);
    const buildings = Array.isArray(squadron.buildings) ? squadron.buildings : [];
    const squadName = String(state.profiles[state.selfProfileKey]?.squadron || "").toLowerCase();
    const stations = state.officialApi.stations.filter((station) => !squadName || !station.squadron || station.squadron.toLowerCase() === squadName);
    return `
      <div class="so-metrics"><div><strong>${rows.length}</strong><span>tracked members</span></div><div><strong>${readyCount}</strong><span>fresh profiles</span></div></div>
      <p class="so-note">Readiness means a profile snapshot is less than 24 hours old; it does not predict whether a player is online. Favorites follow your Steam-linked companion account.</p>
      <div class="so-list">
        ${rows.length ? rows.map(([key, username]) => {
          const profile = state.profiles[key];
          const hasProfileData = Boolean(profile && !profile.placeholder);
          const location = state.locations[key];
          const fresh = location && Date.now() - location.seenAt <= LOCATION_TTL_MS;
          return `<article class="so-row so-player-row">
            <button class="so-star ${state.favorites.has(key) ? "active" : ""}" data-action="favorite" data-name="${esc(key)}" title="Toggle local friend">★</button>
            <button class="so-player" data-action="profile" data-name="${esc(key)}">
              <strong>${esc(username)}</strong>
              <span>${squadNames.has(key) ? "Squad" : "Friend"}${hasProfileData ? ` • snapshot ${ageLabel(profile.capturedAt)} old` : " • basic profile"}</span>
            </button>
            <span class="so-location ${fresh ? "fresh" : ""}">${fresh ? `[${location.x},${location.y},${location.z}] ${ageLabel(location.seenAt)}` : "location unavailable"}</span>
          </article>`;
        }).join("") : `<div class="so-empty">No squad roster or local favorites are available yet.</div>`}
      </div>
      <section><h3>Squadron stations</h3>${stations.length ? `<div class="so-list">${stations.map((station) => `<article class="so-row"><div class="so-row-main"><strong>${esc(station.name)}</strong><span>[${station.x}, ${station.y}, ${station.z}]</span></div><div class="so-inline-actions"><button data-action="copy-coordinate" data-coordinate="${station.x}, ${station.y}, ${station.z}">Copy coordinates</button></div></article>`).join("")}</div>` : `<div class="so-empty">No station for the loaded squad is present in the current official snapshot.</div>`}</section>
      <section><h3>Squadron capability</h3>${Object.keys(bonuses).length ? `<div class="so-grid">${renderPairs(bonuses)}</div>` : `<div class="so-empty">No squadron bonus values are exposed in the current self-profile snapshot.</div>`}${buildings.length ? `<div class="so-chips muted">${buildings.slice(0, 30).map((building) => `<span>${esc(building.name || building.building || "Building")}${building.level ? ` • L${esc(building.level)}` : ""}</span>`).join("")}</div>` : `<p class="so-note">No squadron building list is exposed in the current self-profile snapshot.</p>`}</section>
      <section><h3>Coordination notes</h3><p class="so-note">Use saved manual waypoints in Galaxy Intel for copyable coordinates. True squad-wide sharing is intentionally not enabled until the service can cryptographically verify squad membership.</p></section>`;
  };

  const renderPairs = (object, className = "") => Object.entries(object || {}).map(([key, value]) => `
    <div class="so-pair ${className}"><span>${esc(cleanLabel(key))}</span><strong>${esc(compactNumber(value))}</strong></div>
  `).join("");

  const durationLabel = (milliseconds) => {
    const minutes = Math.max(0, milliseconds) / 60000;
    if (minutes < 60) return `${Math.max(1, Math.floor(minutes))}m`;
    const hours = minutes / 60;
    if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
    const days = hours / 24;
    return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  };

  const cooldownTimeLabel = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    return `${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  };

  let engineCooldownLabel = null;
  let engineAudioContext = null;
  let engineTestBadgeTimer = 0;

  const engineTimerSeconds = () => {
    if (!engineCooldownLabel?.isConnected || engineCooldownLabel.textContent.trim() !== "Engine cooldown:") {
      engineCooldownLabel = [...document.querySelectorAll(".exploration_page span")]
        .find((element) => element.textContent.trim() === "Engine cooldown:") || null;
    }
    const timerText = engineCooldownLabel?.nextElementSibling?.textContent || "";
    const parts = [...timerText.matchAll(/(\d+)\s*([hms])/gi)];
    if (!parts.length) return null;
    return parts.reduce((total, match) => {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      return total + value * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
    }, 0);
  };

  const showEngineToast = (message, force = false) => {
    if (!force && !state.engineAlerts.toast) return;
    document.getElementById(ENGINE_TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = ENGINE_TOAST_ID;
    toast.setAttribute("role", "status");
    toast.innerHTML = `<span>ENGINE</span><strong>${esc(message)}</strong>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6500);
  };

  const flashEngineReady = () => {
    if (!state.engineAlerts.flash) return;
    document.getElementById(ENGINE_FLASH_ID)?.remove();
    const flash = document.createElement("div");
    flash.id = ENGINE_FLASH_ID;
    document.body.appendChild(flash);
    flash.addEventListener("animationend", () => flash.remove(), { once: true });
    setTimeout(() => flash.remove(), 1800);
  };

  const playEngineChime = () => {
    if (!state.engineAlerts.sound || state.engineAlerts.volume <= 0) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      engineAudioContext ||= new AudioContext();
      engineAudioContext.resume?.().catch(() => {});
      const startAt = engineAudioContext.currentTime + 0.03;
      [659.25, 783.99, 987.77].forEach((frequency, index) => {
        const begins = startAt + index * 0.16;
        const oscillator = engineAudioContext.createOscillator();
        const gain = engineAudioContext.createGain();
        oscillator.type = index === 2 ? "sine" : "triangle";
        oscillator.frequency.setValueAtTime(frequency, begins);
        gain.gain.setValueAtTime(0.0001, begins);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.16 * state.engineAlerts.volume), begins + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, begins + 0.28);
        oscillator.connect(gain);
        gain.connect(engineAudioContext.destination);
        oscillator.start(begins);
        oscillator.stop(begins + 0.3);
      });
    } catch (error) {
      console.warn("[SO Intel] Engine alert audio unavailable", error);
    }
  };

  const showDesktopEngineNotification = () => {
    if (!state.engineAlerts.desktop || !("Notification" in window) || window.Notification.permission !== "granted") return;
    try {
      new window.Notification("Stellar Odyssey — Engine ready", {
        body: "Engine cooldown is complete and travel is available again.",
        silent: true,
      });
    } catch (error) {
      console.warn("[SO Intel] Desktop notification unavailable", error);
    }
  };

  const renderEngineBadge = () => {
    const badge = document.querySelector(`#${ROOT_ID} .so-engine-ready-badge`);
    if (!badge) return;
    const visible = state.engineAlerts.badge
      && ((state.engineCooldown.phase === "notified" && !state.engineCooldown.dismissed) || state.engineCooldown.testBadge);
    badge.classList.toggle("visible", visible);
    badge.textContent = state.engineCooldown.testBadge ? "TEST · ENGINE READY" : "ENGINE READY · dismiss";
  };

  const triggerEngineReady = (test = false) => {
    if (!test) {
      if (state.engineCooldown.phase === "notified") return;
      state.engineCooldown.phase = "notified";
      state.engineCooldown.notifiedAt = Date.now();
      state.engineCooldown.dismissed = false;
    }
    playEngineChime();
    showEngineToast(test ? "Test notification — engine ready" : "Cooldown complete — engine ready");
    flashEngineReady();
    showDesktopEngineNotification();
    if (test && state.engineAlerts.badge) {
      state.engineCooldown.testBadge = true;
      clearTimeout(engineTestBadgeTimer);
      engineTestBadgeTimer = setTimeout(() => {
        state.engineCooldown.testBadge = false;
        renderEngineBadge();
      }, 4000);
    }
    renderEngineBadge();
    if (state.tab === "alerts") {
      state.lastPanelSignature = "";
      renderPanel();
    }
  };

  const notifyIntel = (title, detail) => {
    playEngineChime();
    showEngineToast(`${title} — ${detail}`, true);
    if (state.engineAlerts.desktop && "Notification" in window && window.Notification.permission === "granted") {
      try { new window.Notification(`Stellar Odyssey — ${title}`, { body: detail, silent: true }); }
      catch { }
    }
  };

  const operationAlertState = new Map();
  const checkOperationAlerts = () => {
    const now = Date.now();
    for (const row of operationTimeline()) {
      const signature = `${row.key}:${row.dueAt}`;
      const previous = operationAlertState.get(row.key);
      if (!previous) operationAlertState.set(row.key, { signature, wasFuture: row.dueAt > now });
      else if (previous.signature !== signature) operationAlertState.set(row.key, { signature, wasFuture: row.dueAt > now });
      else if (previous.wasFuture && row.dueAt <= now) {
        previous.wasFuture = false;
        if (state.engineAlerts.operations) notifyIntel(`${row.kind} ready`, row.name);
      }
    }
  };

  const updateEngineCooldown = () => {
    const now = Date.now();
    const seconds = engineTimerSeconds();
    const cooldown = state.engineCooldown;
    if (seconds !== null && seconds > 0) {
      const estimatedReadyAt = now + seconds * 1000 + 600;
      const isNewCycle = cooldown.phase === "idle"
        || (cooldown.phase === "notified" && seconds > 2 && now - (cooldown.notifiedAt || 0) > 1200);
      if (isNewCycle) {
        cooldown.phase = "armed";
        cooldown.readyAt = estimatedReadyAt;
        cooldown.dismissed = false;
        cooldown.testBadge = false;
      } else if (cooldown.phase === "armed") {
        if (!cooldown.readyAt || Math.abs(estimatedReadyAt - cooldown.readyAt) > 3500) cooldown.readyAt = estimatedReadyAt;
        if (now >= cooldown.readyAt) cooldown.readyAt = estimatedReadyAt;
      }
      cooldown.lastSeconds = seconds;
      cooldown.lastObservedAt = now;
      renderEngineBadge();
      return;
    }
    if (seconds === 0) {
      cooldown.lastSeconds = 0;
      cooldown.lastObservedAt = now;
    }
    if (cooldown.phase === "armed" && (seconds === 0 || (seconds === null && cooldown.readyAt && now >= cooldown.readyAt))) {
      triggerEngineReady(false);
    }
  };

  const requestDesktopNotifications = async () => {
    if (!("Notification" in window)) {
      state.engineAlerts.desktop = false;
      showEngineToast("Desktop notifications are not supported by this game build", true);
    } else {
      try {
        const permission = window.Notification.permission === "granted"
          ? "granted"
          : await window.Notification.requestPermission();
        if (permission !== "granted") {
          state.engineAlerts.desktop = false;
          showEngineToast("Desktop notification permission was not granted", true);
        }
      } catch {
        state.engineAlerts.desktop = false;
        showEngineToast("Desktop notifications are unavailable", true);
      }
    }
    markDirty();
    state.lastPanelSignature = "";
    renderPanel();
  };

  const detectRateOutliers = (samples, deltaForPair) => {
    const rates = [];
    for (let index = 1; index < samples.length; index++) {
      const elapsed = Number(samples[index].at) - Number(samples[index - 1].at);
      const delta = elapsed >= XP_SAMPLE_BUCKET_MS ? finite(deltaForPair(samples[index - 1], samples[index])) : null;
      if (delta !== null && delta >= 0) rates.push(delta / (elapsed / 3600000));
    }
    if (rates.length < 4) return 0;
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!(median > 0)) return 0;
    return rates.filter((rate) => rate > median * 6).length;
  };

  const xpTrend = (history, activity, windowName) => {
    const samples = history.filter((sample) => sample.activities?.[activity]).sort((a, b) => a.at - b.at);
    const latest = samples.at(-1);
    if (!latest) return { latest: null, sampleCount: 0 };
    const windowMs = XP_WINDOWS[windowName] ?? XP_WINDOWS["24h"];
    const cutoff = latest.at - windowMs;
    let baseline = samples[0];
    if (Number.isFinite(windowMs)) {
      const atOrBefore = samples.filter((sample) => sample.at <= cutoff).at(-1);
      baseline = atOrBefore || samples[0];
    }
    const elapsed = latest.at - baseline.at;
    const delta = elapsed > 0 ? xpDelta(baseline, latest, activity) : null;
    const measuredSamples = samples.filter((sample) => sample.at >= baseline.at);
    const outliers = detectRateOutliers(measuredSamples, (first, last) => xpDelta(first, last, activity)?.gained);
    const eligibleRate = delta && elapsed >= XP_MIN_RATE_WINDOW_MS ? delta.gained / (elapsed / 3600000) : null;
    return {
      latest,
      baseline,
      elapsed,
      delta,
      rate: outliers ? null : eligibleRate,
      withheld: Boolean(outliers && eligibleRate !== null),
      outliers,
      sampleCount: samples.length,
    };
  };

  const xpActiveTrend = (history, activity, windowName) => {
    const samples = (Array.isArray(history) ? history : []).filter((sample) => sample.activities?.[activity]).sort((a, b) => a.at - b.at);
    const latest = samples.at(-1);
    if (!latest) return { activeRate: null, activeElapsed: 0, activeGained: 0, activeSampleCount: 0, activeOutliers: 0 };
    const windowMs = XP_WINDOWS[windowName] ?? XP_WINDOWS["24h"];
    const cutoff = Number.isFinite(windowMs) ? latest.at - windowMs : -Infinity;
    const windowSamples = samples.filter((sample) => sample.at >= cutoff);
    const pairs = [];
    for (let index = 1; index < windowSamples.length; index += 1) {
      const first = windowSamples[index - 1];
      const last = windowSamples[index];
      const elapsed = Number(last.at) - Number(first.at);
      if (elapsed < XP_ACTIVE_MIN_PAIR_MS || elapsed > XP_ACTIVE_MAX_GAP_MS) continue;
      const delta = xpDelta(first, last, activity);
      // Skipped-level interpolation is appropriate for wall-clock history, but not precise enough
      // to infer a short active-play interval.
      if (!delta || delta.estimated || !(delta.gained > 0)) continue;
      pairs.push({ elapsed, gained: delta.gained, rate: delta.gained / (elapsed / 3600000) });
    }
    if (!pairs.length) return { activeRate: null, activeElapsed: 0, activeGained: 0, activeSampleCount: 0, activeOutliers: 0 };
    const sortedRates = pairs.map((pair) => pair.rate).sort((a, b) => a - b);
    const median = sortedRates[Math.floor(sortedRates.length / 2)] || 0;
    const accepted = median > 0 ? pairs.filter((pair) => pair.rate <= median * 4) : pairs;
    const activeOutliers = pairs.length - accepted.length;
    const activeElapsed = accepted.reduce((total, pair) => total + pair.elapsed, 0);
    const activeGained = accepted.reduce((total, pair) => total + pair.gained, 0);
    const ready = accepted.length >= 3 && activeElapsed >= XP_MIN_RATE_WINDOW_MS;
    return {
      activeRate: ready ? activeGained / (activeElapsed / 3600000) : null,
      activeElapsed,
      activeGained,
      activeSampleCount: accepted.length + (accepted.length ? 1 : 0),
      activeOutliers,
      activeWithheld: Boolean(activeOutliers && !accepted.length),
    };
  };

  const xpTrendForKey = (key, activity, windowName) => {
    const local = xpTrend(state.xpHistory[key] || [], activity, windowName);
    const active = xpActiveTrend(state.xpHistory[key] || [], activity, windowName);
    const summary = state.sharedSummaries.xp[key];
    const baseline = summary?.baselines?.[windowName];
    const sharedLatest = summary?.latest;
    if (!baseline?.activities?.[activity] || !sharedLatest?.activities?.[activity]) return { ...local, ...active };
    const localLatest = local.latest?.at > Number(sharedLatest.at || 0) ? local.latest : null;
    const latest = localLatest || { at: Number(sharedLatest.at), activities: plain(sharedLatest.activities), source: "shared summary" };
    const start = { at: Number(baseline.at), activities: plain(baseline.activities), source: "shared summary" };
    const elapsed = latest.at - start.at;
    const delta = elapsed > 0 ? xpDelta(start, latest, activity) : null;
    const shared = {
      latest,
      baseline: start,
      elapsed,
      delta,
      rate: local.outliers ? null : delta && elapsed >= XP_MIN_RATE_WINDOW_MS ? delta.gained / (elapsed / 3600000) : null,
      sampleCount: Math.max(2, Number(local.sampleCount || 0)),
      outliers: Number(local.outliers || 0),
      withheld: Boolean(local.withheld),
    };
    const selected = !local.latest || local.rate === null || shared.latest.at >= local.latest.at || shared.elapsed > local.elapsed ? shared : local;
    return { ...selected, ...active };
  };

  const HEADER_BOOSTS = [
    { name: "Cooldown", label: "Cooldown", icon: "boost_cooldown" },
    { name: "Drop chance", label: "Drops", icon: "boost_drop_chance" },
    { name: "XP", label: "XP", icon: "boost_xp" },
    { name: "Income", label: "Income", icon: "boost_income" },
  ];

  const boostTimeLabel = (seconds) => {
    const remaining = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;
    return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  };

  const readHeaderBoosts = () => {
    try {
      const store = getPinia()?._s?.get("GlobalBoostsStore");
      const current = Array.from(store?.currentBoosts || []);
      const tiers = Array.from(store?.GlobalBoostTier || []);
      const now = Math.floor(Date.now() / 1000);
      return HEADER_BOOSTS.map((definition) => {
        const active = current.find((entry) => entry?.boost?.name === definition.name);
        const tier = tiers.find((entry) => entry?.boost === definition.name);
        const remaining = active ? Math.max(0, Number(active.timer || 0) - now) : 0;
        return {
          ...definition,
          bonus: Math.max(0, Number(tier?.bonus || 0)),
          tier: Math.max(0, Number(tier?.tier || 0)),
          remaining,
        };
      });
    } catch {
      return HEADER_BOOSTS.map((definition) => ({ ...definition, bonus: 0, tier: 0, remaining: 0 }));
    }
  };

  const closeHeaderBoostPopover = () => {
    const cluster = document.querySelector("#q-app .so-intel-boost-cluster");
    if (!cluster) return;
    cluster.classList.remove("open");
    cluster.querySelector(".so-intel-boost-trigger")?.setAttribute("aria-expanded", "false");
    const popover = cluster.querySelector(".so-intel-boost-popover");
    if (popover) popover.hidden = true;
  };

  const ensureHeaderBoostPopover = () => {
    const nativeItem = document.querySelector("#q-app .q-header .global_boosts");
    const nativeList = nativeItem?.closest(".q-list");
    const toolbar = nativeList?.parentElement;
    if (!nativeList || !toolbar) return null;
    nativeList.classList.add("so-intel-native-boosts");

    let cluster = toolbar.querySelector(":scope > .so-intel-boost-cluster");
    if (!cluster) {
      cluster = document.createElement("div");
      cluster.className = "so-intel-boost-cluster";
      cluster.innerHTML = `
        <button class="so-intel-boost-trigger" type="button" aria-label="Toggle boosts" aria-expanded="false">
          <span class="so-intel-boost-trigger-grid" aria-hidden="true">
            ${HEADER_BOOSTS.map((boost) => `<svg viewBox="0 0 26 26" preserveAspectRatio="xMidYMid meet"><use href="#${boost.icon}"></use></svg>`).join("")}
          </span>
        </button>
        <section class="so-intel-boost-popover" aria-label="Boosts" hidden>
          <strong>Boosts</strong>
          <div class="so-intel-boost-list">
            ${HEADER_BOOSTS.map((boost) => `
              <div class="so-intel-boost-item" data-boost-name="${boost.name}" tabindex="0">
                <svg viewBox="0 0 26 26" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><use href="#${boost.icon}"></use></svg>
                <span>${boost.label}</span>
                <div class="so-intel-boost-tooltip" role="tooltip">
                  <span class="so-intel-boost-bonus"></span>
                  <span>Time remaining: <b class="so-intel-boost-time"></b></span>
                </div>
              </div>`).join("")}
          </div>
        </section>`;
      toolbar.insertBefore(cluster, nativeList);
      cluster.addEventListener("click", (event) => {
        const trigger = event.target.closest(".so-intel-boost-trigger");
        if (!trigger) return;
        event.stopPropagation();
        const open = !cluster.classList.contains("open");
        cluster.classList.toggle("open", open);
        trigger.setAttribute("aria-expanded", String(open));
        cluster.querySelector(".so-intel-boost-popover").hidden = !open;
      });
      cluster.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeHeaderBoostPopover();
      });
    } else if (cluster.nextElementSibling !== nativeList) {
      toolbar.insertBefore(cluster, nativeList);
    }
    return cluster;
  };

  const renderHeaderBoosts = () => {
    const cluster = ensureHeaderBoostPopover();
    if (!cluster) return;
    for (const boost of readHeaderBoosts()) {
      const item = [...cluster.querySelectorAll(".so-intel-boost-item")]
        .find((candidate) => candidate.dataset.boostName === boost.name);
      if (!item) continue;
      const active = boost.remaining > 0;
      item.classList.toggle("inactive", !active);
      item.querySelector(".so-intel-boost-bonus").textContent = active
        ? `${boost.name} bonus: ${boost.bonus}% (Tier: ${boost.tier})`
        : `${boost.name} bonus: inactive`;
      item.querySelector(".so-intel-boost-time").textContent = active ? boostTimeLabel(boost.remaining) : "—";
      item.setAttribute("aria-label", active
        ? `${boost.label}, ${boost.bonus}% bonus, tier ${boost.tier}, ${boostTimeLabel(boost.remaining)} remaining`
        : `${boost.label}, inactive`);
    }
  };

  const xpLeaderboard = (keys, activity, windowName) => {
    const rows = keys.map((key) => ({
      key,
      username: state.profiles[key]?.username || key,
      trend: xpTrendForKey(key, activity, windowName),
    })).map((row) => ({ ...row, rankingRate: state.xpRateMode === "active" ? row.trend.activeRate : row.trend.rate }));
    const ranked = rows
      .filter((row) => row.rankingRate !== null)
      .sort((a, b) => b.rankingRate - a.rankingRate || a.username.localeCompare(b.username));
    let previousRate = null;
    let currentRank = 0;
    ranked.forEach((row, index) => {
      if (previousRate === null || row.rankingRate !== previousRate) currentRank = index + 1;
      row.rank = currentRank;
      previousRate = row.rankingRate;
    });
    for (const row of ranked) row.tied = ranked.filter((candidate) => candidate.rankingRate === row.rankingRate).length > 1;
    return { ranked, calibrating: rows.filter((row) => row.rankingRate === null) };
  };

  const renderXpLeaderboard = (keys, activity) => {
    const board = xpLeaderboard(keys, activity, state.xpWindow);
    const self = board.ranked.find((row) => row.key === state.selfProfileKey);
    const selfStatus = self
      ? `${self.tied ? "Tied " : ""}#${self.rank} of ${board.ranked.length} ranked`
      : board.calibrating.some((row) => row.key === state.selfProfileKey)
        ? "You are calibrating"
        : "Your profile is unavailable";
    return `
      <section class="so-xp-leaderboard-card">
        <div class="so-xp-leaderboard-head">
          <strong>${esc(cleanLabel(activity))}</strong>
          <span>${esc(selfStatus)}</span>
        </div>
        <div class="so-xp-leaderboard-list">
          ${board.ranked.length ? board.ranked.map((row) => {
            const evidence = state.xpRateMode === "active" ? { ...row.trend, rate: row.trend.activeRate, elapsed: row.trend.activeElapsed, sampleCount: row.trend.activeSampleCount, outliers: row.trend.activeOutliers, withheld: row.trend.activeWithheld } : row.trend;
            const confidence = confidenceForTrend(evidence, XP_MIN_RATE_WINDOW_MS);
            return `
            <div class="so-xp-leaderboard-row ${row.key === state.selfProfileKey ? "self" : ""}" title="${esc(confidence.detail)}">
              <b>${row.tied ? "T" : ""}#${row.rank}</b>
              <span>${esc(row.username)}${row.key === state.selfProfileKey ? " (You)" : ""}<small class="so-confidence ${confidence.level}">${esc(confidence.label)}</small></span>
              <strong>${state.xpRateMode === "wall" && row.trend.delta?.estimated ? "≈" : ""}${esc(xpRateNumber(row.rankingRate))}<small> ${state.xpRateMode === "active" ? "active " : ""}XP/h</small></strong>
            </div>`;
          }).join("") : `<div class="so-empty">No players have completed calibration for ${esc(activity)}.</div>`}
        </div>
        <div class="so-xp-leaderboard-foot">${board.ranked.length} ranked • ${board.calibrating.filter((row) => !row.trend.withheld).length} calibrating • ${board.calibrating.filter((row) => row.trend.withheld).length} withheld for outliers • ${state.xpRateMode === "active" ? "continuous gain intervals only" : "wall-clock average"}</div>
      </section>`;
  };

  const resourceTrend = (history, windowName) => {
    const samples = (Array.isArray(history) ? history : [])
      .filter((sample) => finite(sample?.value) !== null && finite(sample?.at) !== null)
      .sort((a, b) => a.at - b.at);
    const latest = samples.at(-1);
    if (!latest) return { latest: null, rate: null, sampleCount: 0 };
    const windowMs = XP_WINDOWS[windowName] ?? XP_WINDOWS["24h"];
    const cutoff = latest.at - windowMs;
    let baseline = samples[0];
    if (Number.isFinite(windowMs)) baseline = samples.filter((sample) => sample.at <= cutoff).at(-1) || samples[0];
    const elapsed = latest.at - baseline.at;
    const gained = finite(latest.value) - finite(baseline.value);
    const measuredSamples = samples.filter((sample) => sample.at >= baseline.at);
    const outliers = detectRateOutliers(measuredSamples, (first, last) => finite(last.value) - finite(first.value));
    const eligibleRate = gained >= 0 && elapsed >= RESOURCE_MIN_RATE_WINDOW_MS ? gained / (elapsed / 3600000) : null;
    return {
      latest,
      baseline,
      elapsed,
      gained: gained >= 0 ? gained : null,
      rate: outliers ? null : eligibleRate,
      withheld: Boolean(outliers && eligibleRate !== null),
      outliers,
      sampleCount: samples.length,
    };
  };

  const resourceTrendForKey = (key, windowName) => {
    const local = resourceTrend(state.resourceHistory[key], windowName);
    const summary = state.sharedSummaries.resources[key];
    const baseline = summary?.baselines?.[windowName];
    const sharedLatest = summary?.latest;
    const baselineValue = finite(baseline?.value);
    const sharedValue = finite(sharedLatest?.value);
    if (baselineValue === null || sharedValue === null) return local;
    const localLatest = Number(local.latest?.at || 0) > Number(sharedLatest.at || 0) ? local.latest : null;
    const latest = localLatest || { at: Number(sharedLatest.at), value: sharedValue, source: "shared summary" };
    const start = { at: Number(baseline.at), value: baselineValue, source: "shared summary" };
    const elapsed = latest.at - start.at;
    const gained = finite(latest.value) - finite(start.value);
    const shared = {
      latest,
      baseline: start,
      elapsed,
      gained: gained >= 0 ? gained : null,
      rate: local.outliers ? null : gained >= 0 && elapsed >= RESOURCE_MIN_RATE_WINDOW_MS ? gained / (elapsed / 3600000) : null,
      sampleCount: Math.max(2, Number(local.sampleCount || 0)),
      outliers: Number(local.outliers || 0),
      withheld: Boolean(local.withheld),
    };
    if (!local.latest || local.rate === null || shared.latest.at >= local.latest.at || shared.elapsed > local.elapsed) return shared;
    return local;
  };

  const renderResourceLeaderboard = (keys) => {
    const candidates = keys.map((key) => ({
      key,
      username: state.profiles[key]?.username || state.resourceRankings.rows[key]?.username || key,
      trend: resourceTrendForKey(key, state.xpWindow),
    }));
    const ranked = candidates
      .filter((row) => row.trend.rate !== null)
      .sort((a, b) => b.trend.rate - a.trend.rate || a.username.localeCompare(b.username));
    let previousRate = null;
    let currentRank = 0;
    ranked.forEach((row, index) => {
      if (previousRate === null || row.trend.rate !== previousRate) currentRank = index + 1;
      row.rank = currentRank;
      previousRate = row.trend.rate;
    });
    for (const row of ranked) row.tied = ranked.filter((candidate) => candidate.trend.rate === row.trend.rate).length > 1;
    const calibrating = candidates.filter((row) => row.trend.rate === null);
    const self = ranked.find((row) => row.key === state.selfProfileKey);
    const selfStatus = self
      ? `${self.tied ? "Tied " : ""}#${self.rank} of ${ranked.length} ranked`
      : calibrating.some((row) => row.key === state.selfProfileKey)
        ? "You are calibrating"
        : "Your profile is unavailable";
    return `
      <section class="so-xp-leaderboard-card so-resource-leaderboard-card">
        <div class="so-xp-leaderboard-head">
          <strong>RSS per Hour</strong>
          <span>${esc(selfStatus)}</span>
        </div>
        <div class="so-xp-leaderboard-list">
          ${ranked.length ? ranked.map((row) => {
            const confidence = confidenceForTrend(row.trend, RESOURCE_MIN_RATE_WINDOW_MS);
            return `
            <div class="so-xp-leaderboard-row ${row.key === state.selfProfileKey ? "self" : ""}" title="${esc(confidence.detail)}">
              <b>${row.tied ? "T" : ""}#${row.rank}</b>
              <span>${esc(row.username)}${row.key === state.selfProfileKey ? " (You)" : ""}<small class="so-confidence ${confidence.level}">${esc(confidence.label)}</small></span>
              <strong title="${esc(xpRateNumber(row.trend.rate))} RSS/hour • ${esc(xpRateNumber(row.trend.gained))} gained over ${esc(durationLabel(row.trend.elapsed))}">${esc(compactNumber(row.trend.rate))}<small> RSS/h</small></strong>
            </div>`;
          }).join("") : `<div class="so-empty">No tracked player has completed RSS-rate calibration for this window.</div>`}
        </div>
        <div class="so-xp-leaderboard-foot">${ranked.length} ranked • ${calibrating.filter((row) => !row.trend.withheld).length} calibrating • ${calibrating.filter((row) => row.trend.withheld).length} withheld for outliers • profile totals only</div>
      </section>`;
  };

  const renderXpRankings = () => {
    const keys = listedPlayerKeys(false);
    return `
      <div class="so-rank-controls">
        <label>Ranking window
          <select data-action="select-xp-window">${Object.keys(XP_WINDOWS).map((windowName) => `<option value="${windowName}" ${windowName === state.xpWindow ? "selected" : ""}>${windowName === "all" ? "All observed" : windowName}</option>`).join("")}</select>
        </label>
        <label>XP rate
          <select data-action="select-xp-rate-mode"><option value="active" ${state.xpRateMode === "active" ? "selected" : ""}>Active sessions</option><option value="wall" ${state.xpRateMode === "wall" ? "selected" : ""}>Wall clock</option></select>
        </label>
      </div>
      <div class="so-xp-leaderboards">
        <p class="so-note">Rankings include you, squad members, and favorited profiles. Active Sessions ranks only continuous, positive-XP intervals no more than 10 minutes apart; Wall Clock includes idle/offline time. RSS remains a wall-clock rate from cumulative profile totals.</p>
        ${keys.length ? `${renderXpLeaderboard(keys, "battling")}${renderXpLeaderboard(keys, "gathering")}` : `<div class="so-empty">No squad members or favorited profiles are available yet.</div>`}
        ${renderResourceLeaderboard(keys)}
      </div>
      <p class="so-note">Active XP needs at least three accepted gain intervals spanning 10 minutes. Players with sparse manual profile visits may have only a wall-clock rate until more continuous observations are contributed. RSS requires at least 60 minutes. Ties share the same place.</p>`;
  };

  const renderXpTrends = () => {
    const keys = listedPlayerKeys(false);
    if (!keys.length) return `<div class="so-empty">No squad members or favorited profiles are available yet.</div>`;
    const selected = keys.includes(state.selectedProfile)
      ? state.selectedProfile
      : keys.includes(state.selfProfileKey)
        ? state.selfProfileKey
        : keys[0];
    const history = state.xpHistory[selected] || [];
    const sharedSummary = state.sharedSummaries.xp[selected];
    const playerName = state.profiles[selected]?.username || selected;
    const controls = `<div class="so-xp-controls">
      <label>Player<select data-action="select-profile">${keys.map((key) => `<option value="${esc(key)}" ${key === selected ? "selected" : ""}>${esc(state.profiles[key]?.username || key)}${key === state.selfProfileKey ? " (You)" : ""}${key !== state.selfProfileKey && state.favorites.has(key) ? " ★" : ""}</option>`).join("")}</select></label>
      <label>Window<select data-action="select-xp-window">${Object.keys(XP_WINDOWS).map((windowName) => `<option value="${windowName}" ${windowName === state.xpWindow ? "selected" : ""}>${windowName === "all" ? "All observed" : windowName}</option>`).join("")}</select></label>
    </div>`;
    if (!history.length && !sharedSummary?.latest) return `${controls}<div class="so-empty">No XP baseline has been observed for ${esc(playerName)}. Open their public profile normally on separate occasions to build a history.</div>`;
    const firstAt = history[0]?.at || sharedSummary?.baselines?.all?.at || Date.now();
    const lastAt = history.at(-1)?.at || sharedSummary?.latest?.at || firstAt;
    return `
      ${controls}
      <div class="so-metrics so-xp-summary">
        <div><strong>${history.length || 2}</strong><span>${history.length ? "snapshots" : "summary points"}</span></div>
        <div><strong>${durationLabel(lastAt - firstAt)}</strong><span>observed span</span></div>
      </div>
      <p class="so-note">${esc(playerName)} • active-session estimates use continuous positive-XP intervals; wall-clock averages include idle and offline time. Open another player’s public profile normally on separate occasions to build their history.</p>
      <div class="so-xp-list">
        ${XP_ACTIVITIES.map((activity) => {
          const trend = xpTrendForKey(selected, activity, state.xpWindow);
          const current = trend.latest?.activities?.[activity];
          if (!current) return `<article class="so-xp-card"><div class="so-xp-title"><strong>${cleanLabel(activity)}</strong><span>Not exposed</span></div></article>`;
          const [level, currentXp, targetXp] = current;
          const progress = targetXp > 0 ? Math.max(0, Math.min(100, (currentXp / targetXp) * 100)) : 0;
          const ready = trend.rate !== null;
          const activeReady = trend.activeRate !== null;
          const calibrationRemaining = Math.max(0, XP_MIN_RATE_WINDOW_MS - (trend.elapsed || 0));
          const confidence = trend.withheld
            ? `rate withheld • ${trend.outliers} outlier${trend.outliers === 1 ? "" : "s"} detected`
            : !trend.delta
            ? "collecting comparable snapshots"
            : !ready
              ? `calibrating • ${durationLabel(calibrationRemaining)} remaining`
              : `${trend.delta.confidence} confidence`;
          return `<article class="so-xp-card">
            <div class="so-xp-title"><strong>${cleanLabel(activity)}</strong><span>Level ${esc(level)}</span></div>
            <div class="so-xp-progress"><i style="width:${progress.toFixed(2)}%"></i></div>
            <div class="so-xp-progress-text"><span>${esc(compactNumber(currentXp))} / ${esc(compactNumber(targetXp))}</span><span>${progress.toFixed(1)}%</span></div>
            <div class="so-xp-stats">
              <div><span>Active-session estimate</span><strong>${activeReady ? `${esc(xpRateNumber(trend.activeRate))} XP/hour` : "—"}</strong></div>
              <div><span>Wall-clock average</span><strong>${ready ? `${trend.delta.estimated ? "≈" : ""}${esc(xpRateNumber(trend.rate))} XP/hour` : "—"}</strong></div>
              <div><span>Gained</span><strong>${trend.delta ? `${trend.delta.estimated ? "≈" : ""}${esc(compactNumber(trend.delta.gained))}` : "—"}</strong></div>
            </div>
            <div class="so-xp-confidence ${ready ? trend.delta?.confidence || "pending" : "pending"}">${esc(confidence)}${trend.elapsed ? ` • ${durationLabel(trend.elapsed)} wall-clock` : ""}${activeReady ? ` • ${durationLabel(trend.activeElapsed)} active evidence` : ""}</div>
          </article>`;
        }).join("")}
      </div>
      <p class="so-note">Rates appear after at least 10 minutes to avoid misleading short-interval extrapolation. Active-session estimates exclude unchanged periods, gaps over 10 minutes, and skipped-level intervals; they are best for overlay users contributing minute snapshots. A one-level crossing is calculated exactly from prior remaining XP plus new-level progress. Multiple skipped levels remain a wall-clock interpolation marked low confidence.</p>`;
  };

  const combatStat = (profile, stat) => {
    const values = profile?.stats || {};
    for (const key of [`combat_${stat}`, `pvp_${stat}`, stat]) {
      const value = finite(values[key]);
      if (value !== null && value > 0) return value;
    }
    const match = Object.entries(values).find(([key, value]) => key.toLowerCase().endsWith(`_${stat}`) && (finite(value) || 0) > 0);
    return match ? finite(match[1]) : 0;
  };

  const buildStatCoverage = (profile) => PVP_CORE_STATS.filter((stat) => combatStat(profile, stat) > 0).length;

  const catalystStatsForProfile = (profile) => {
    if (profile?.catalystStats && typeof profile.catalystStats === "object") {
      return Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, finite(profile.catalystStats[stat])]).filter(([, value]) => value !== null));
    }
    const gear = Array.isArray(profile?.gear) ? profile.gear : [];
    if (!gear.length) return {};
    const totals = Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, 0]));
    for (const item of gear) for (const catalyst of Array.isArray(item?.catalysts) ? item.catalysts : []) {
      const stat = String(catalyst?.stat || "").toLowerCase();
      if (!PVP_CATALYST_STATS.includes(stat)) continue;
      const match = String(catalyst?.bonus || "").match(/-?\d+(?:\.\d+)?/);
      if (match) totals[stat] += Number(match[0]);
    }
    return totals;
  };

  const simulatedBuild = (profile, mods) => {
    const catalysts = catalystStatsForProfile(profile);
    return Object.fromEntries(PVP_BUILD_STATS.map((input) => {
      if (PVP_CORE_STATS.includes(input)) {
        const base = combatStat(profile, input);
        return [input, base * (1 + (finite(mods?.[input]) || 0) / 100)];
      }
      const stat = input.replace(/^catalyst_/, "");
      const base = finite(catalysts[stat]);
      const adjustment = finite(mods?.[input]) || 0;
      return [input, base === null && adjustment === 0 ? null : (base || 0) + adjustment];
    }));
  };

  const pvpEstimate = (leftProfile, rightProfile) => {
    const left = simulatedBuild(leftProfile, state.buildLab.leftMods);
    const right = simulatedBuild(rightProfile, state.buildLab.rightMods);
    const score = (attacker, defender) => Math.max(1, attacker.power)
      * Math.max(0.001, Math.min(0.999, attacker.precision / Math.max(1, attacker.precision + defender.evasion)))
      * Math.max(1, attacker.hull);
    const leftScore = score(left, right);
    const rightScore = score(right, left);
    const feature = Math.max(-8, Math.min(8, Math.log(Math.max(1e-9, leftScore / Math.max(1e-9, rightScore)))));
    const model = state.sync.battleModel?.arena || {};
    const matched = Math.max(0, Number(model.matched || 0));
    const inferred = Math.max(0, Number(model.inferred || 0));
    const effectiveSamples = matched + inferred * 0.25;
    const learnedWeight = effectiveSamples / (effectiveSamples + 25);
    const intercept = (finite(model.intercept) || 0) * learnedWeight;
    const coefficients = model.coefficients && typeof model.coefficients === "object" ? model.coefficients : {};
    const baseCoefficient = 1 + ((finite(coefficients.base) ?? finite(model.slope) ?? 1) - 1) * learnedWeight;
    const catalystFeatures = {};
    let catalystLogit = 0;
    for (const stat of PVP_CATALYST_STATS) {
      const input = `catalyst_${stat}`;
      if (finite(left[input]) === null || finite(right[input]) === null) continue;
      const value = Math.max(-5, Math.min(5, (left[input] - right[input]) / 100));
      catalystFeatures[stat] = value;
      catalystLogit += (finite(coefficients[stat]) || 0) * learnedWeight * value;
    }
    const chance = 100 / (1 + Math.exp(-Math.max(-30, Math.min(30, intercept + baseCoefficient * feature + catalystLogit))));
    return { left, right, chance, feature, model, learnedWeight, effectiveSamples, catalystFeatures };
  };

  const battleModelConfidence = (examples) => examples >= 200 ? "high" : examples >= 50 ? "medium" : examples >= 10 ? "low" : "experimental";

  const renderBuildLab = (keys) => {
    const buildProfile = (key) => state.profiles[key] || state.buildLab.imports[key];
    const usable = [...new Set([...keys.filter((key) => state.profiles[key] && !state.profiles[key].placeholder && buildStatCoverage(state.profiles[key]) >= 2), ...Object.keys(state.buildLab.imports)])];
    if (!usable.length) return `<div class="so-empty">No complete profile is available for comparison yet. Open your profile or another player’s public profile normally, then return to Builds.</div>`;
    if (!usable.includes(state.buildLab.left)) state.buildLab.left = usable.includes(state.selectedProfile) ? state.selectedProfile : usable[0];
    if (!usable.includes(state.buildLab.right)) state.buildLab.right = usable.find((key) => key !== state.buildLab.left) || state.buildLab.left;
    const leftProfile = buildProfile(state.buildLab.left);
    const rightProfile = buildProfile(state.buildLab.right);
    const result = pvpEstimate(leftProfile, rightProfile);
    const arenaModel = result.model || {};
    const modelBattles = Math.max(0, Number(arenaModel.battles || 0));
    const matchedBattles = Math.max(0, Number(arenaModel.matched || 0));
    const inferredBattles = Math.max(0, Number(arenaModel.inferred || 0));
    const modelConfidence = battleModelConfidence(result.effectiveSamples);
    const hitRate = finite(arenaModel.hitRate);
    const averageRounds = finite(arenaModel.averageRounds);
    const selector = (side, selected) => `<select data-action="build-player" data-side="${side}">${usable.map((key) => `<option value="${esc(key)}" ${key === selected ? "selected" : ""}>${esc(buildProfile(key).username)}${state.buildLab.imports[key] ? " (shared)" : ""}</option>`).join("")}</select>`;
    const modifiers = (side, values) => `<div class="so-build-mods">${PVP_BUILD_STATS.map((stat) => `<label>${cleanLabel(stat)} ${PVP_CORE_STATS.includes(stat) ? "%" : "pts"}<input type="number" step="0.1" min="-90" max="500" data-action="build-mod" data-side="${side}" data-stat="${stat}" value="${esc(values[stat] || 0)}"></label>`).join("")}</div>`;
    return `<section><h3>Build lab & PvP sandbox</h3>
      <p class="so-note">Build A is treated as the attacker. The estimate starts with the verified power, hull, precision and evasion relationship, then gradually blends in anonymized completed-battle evidence. It never starts a game action.</p>
      ${usable.length === 1 ? `<div class="so-build-warning">Only ${esc(leftProfile.username)} currently has enough exposed combat data. You can still compare hypothetical variants of this build, or import an SOI1 code generated from another player’s complete snapshot.</div>` : ""}
      <div class="so-build-selectors"><label>Build A${selector("left", state.buildLab.left)}</label><label>Build B${selector("right", state.buildLab.right)}</label></div>
      <div class="so-versus"><div><strong>${esc(leftProfile.username)}</strong><span>${result.chance.toFixed(1)}% win estimate</span></div><b>VS</b><div><strong>${esc(rightProfile.username)}</strong><span>${(100 - result.chance).toFixed(1)}% win estimate</span></div></div>
      <div class="so-model-card">
        <div><span>Learning confidence</span><strong class="${esc(modelConfidence)}">${esc(cleanLabel(modelConfidence))}</strong></div>
        <div><span>Recorded arena battles</span><strong>${compactNumber(modelBattles)}</strong></div>
        <div><span>Profile-matched training</span><strong>${compactNumber(matchedBattles)}</strong></div>
        <div><span>Lower-weight log training</span><strong>${compactNumber(inferredBattles)}</strong></div>
        <div><span>Evidence blended</span><strong>${Math.round(result.learnedWeight * 100)}%</strong></div>
        <small>${modelBattles ? `${hitRate === null ? "Hit rate collecting" : `${(hitRate * 100).toFixed(1)}% empirical hit rate`}${averageRounds === null ? "" : ` • ${averageRounds.toFixed(1)} average rounds`}.` : "No shared battles have reached this device yet; the formula baseline is being used."} Hidden opponent catalysts remain unknown unless a profile snapshot was available.</small>
      </div>
      <div class="so-build-columns"><div><strong>A modifiers</strong>${modifiers("left", state.buildLab.leftMods)}</div><div><strong>B modifiers</strong>${modifiers("right", state.buildLab.rightMods)}</div></div>
      <div class="so-grid">${PVP_CORE_STATS.map((stat) => `<div class="so-pair"><span>${cleanLabel(stat)}</span><strong>${compactNumber(result.left[stat])} / ${compactNumber(result.right[stat])}</strong></div>`).join("")}</div>
      <h3 class="so-subhead">Observed combat catalysts</h3>
      <div class="so-grid">${PVP_CATALYST_STATS.map((stat) => { const input = `catalyst_${stat}`; return `<div class="so-pair"><span>${cleanLabel(stat)}</span><strong>${finite(result.left[input]) === null ? "Unknown" : `${compactNumber(result.left[input])}%`} / ${finite(result.right[input]) === null ? "Unknown" : `${compactNumber(result.right[input])}%`}</strong></div>`; }).join("")}</div>
      <div class="so-inline-actions"><button data-action="save-build">Save A preset</button><button data-action="share-build">Copy A share code</button></div>
      <div class="so-build-import"><input data-build-share-code placeholder="Paste SOI1 build code"><button data-action="import-build">Import</button></div>
      ${state.buildLab.presets.length ? `<div class="so-chips muted">${state.buildLab.presets.map((preset, index) => `<span>${esc(preset.name)} <button data-action="load-build" data-index="${index}">load</button></span>`).join("")}</div>` : ""}
    </section>`;
  };

  const renderProfile = () => {
    const keys = listedPlayerKeys(true);
    if (!keys.includes(state.selectedProfile)) {
      const routeKey = routeProfileName().toLowerCase();
      state.selectedProfile = keys.includes(routeKey) ? routeKey : keys.includes(state.selfProfileKey) ? state.selfProfileKey : keys[0] || "";
    }
    const profile = state.profiles[state.selectedProfile];
    if (!profile) return `
      <div class="so-empty so-profile-empty">
        Open a player’s public profile using the game’s own search. The overlay will passively cache its display data; it will never request a profile itself.
      </div>`;
    return `
      <div class="so-profile-head">
        <div><strong>${esc(profile.username)}${profile.live ? " (You)" : ""}</strong><span>${esc(profile.squadron || "No squadron shown")}${profile.clones !== "" ? ` • ${esc(profile.clones)} clones` : ""}${profile.droids !== "" ? ` • ${esc(profile.droids)} droids` : ""}</span></div>
        ${state.selectedProfile === state.selfProfileKey
          ? `<span class="so-self-badge">Your profile</span>`
          : `<button class="so-profile-favorite ${state.favorites.has(state.selectedProfile) ? "active" : ""}" data-action="favorite" data-name="${esc(state.selectedProfile)}" title="${state.favorites.has(state.selectedProfile) ? "Remove from favorites" : "Add to profile and XP lists"}">${state.favorites.has(state.selectedProfile) ? "★ Favorited" : "☆ Favorite"}</button>`}
      </div>
      <label class="so-select-label">Profile
        <select data-action="select-profile">${keys.map((key) => `<option value="${esc(key)}" ${key === state.selectedProfile ? "selected" : ""}>${esc(state.profiles[key].username)}${key === state.selfProfileKey ? " (You)" : ""}${key !== state.selfProfileKey && state.favorites.has(key) ? " ★" : ""}</option>`).join("")}</select>
      </label>
      <section><h3>Levels</h3><div class="so-grid">${renderPairs(profile.levels)}</div></section>
      <section><h3>Stats</h3><div class="so-grid">${renderPairs(profile.stats)}</div></section>
      <section><h3>Gear & catalysts</h3>
        <div class="so-gear">${profile.gear.length ? profile.gear.map((gear) => `
          <article>
            <div class="so-gear-title"><span>${esc(gear.slot)}</span><strong>${esc(gear.name)}</strong></div>
            <div class="so-gear-meta">${gear.level !== "" ? `Lvl ${esc(gear.level)}` : ""}${gear.rarity ? ` • ${esc(gear.rarity)}` : ""}${gear.quality !== "" ? ` • Q ${esc(gear.quality)}` : ""}</div>
            ${Object.keys(gear.bonuses).length ? `<div class="so-chips muted">${Object.entries(gear.bonuses).map(([key, value]) => `<span>${esc(cleanLabel(key))}: ${esc(compactNumber(value))}</span>`).join("")}</div>` : ""}
            <div class="so-chips catalysts">${gear.catalysts.length ? gear.catalysts.map((catalyst) => `<span>${esc(cleanLabel(catalyst.stat))}${catalyst.bonus ? ` • ${esc(catalyst.bonus)}` : ""}${catalyst.range !== "" ? ` • Q${esc(compactNumber(catalyst.range))}` : ""}${catalyst.rarity ? ` • ${esc(catalyst.rarity)}` : ""}${catalyst.halved ? " • halved" : ""}</span>`).join("") : `<em>No installed catalysts exposed</em>`}</div>
          </article>
        `).join("") : ""}</div>
      </section>
      <section><h3>Pets</h3>
        <div class="so-chips pets">${profile.pets.length ? profile.pets.map((pet) => `<span>${esc(pet.name)} • Lvl ${esc(pet.level)}${pet.active ? " • active" : ""}</span>`).join("") : `<em>No pets exposed</em>`}</div>
      </section>
      <section><h3>Technology</h3><div class="so-grid">${renderPairs(profile.technology)}</div></section>
      <p class="so-note">${profile.live ? "Live from your currently loaded client stores." : profile.placeholder ? "Basic identity from a loaded player list. Open this player’s public profile in the game to expose any additional public data." : `Cached ${ageLabel(profile.capturedAt)} ago from the profile response the game loaded.`}</p>`;
  };

  const renderBuilds = () => renderBuildLab(listedPlayerKeys(true));

  const renderPvmLab = () => {
    const baseline = pvmSafeBuild(state.pvmLab.baseline);
    const build = pvmSafeBuild(state.pvmLab.build);
    const npc = PVM_NPCS.find((row) => row.name === state.pvmLab.npc) || PVM_NPCS[0];
    const busy = ["simulating", "scanning", "optimizing"].includes(state.pvmLab.job);
    const engineClass = state.pvmLab.engineStatus === "ready" ? "ready" : state.pvmLab.engineStatus === "error" ? "error" : "loading";
    const engineLabel = state.pvmLab.engineStatus === "ready" ? "Official engine ready" : state.pvmLab.engineStatus === "error" ? "Compatibility check failed" : "Loading official engine";
    if (!build || !baseline) return `<section class="so-pvm-lab"><h3>Official NPC combat lab</h3>
      <p class="so-note">This informational lab runs the game’s own NPC simulator locally. It never starts a battle or sends a game-server request.</p>
      <div class="so-empty">Your current combat build has not been loaded yet.</div>
      <div class="so-inline-actions"><button data-action="pvm-load-current">Load current build</button></div>
    </section>`;

    const numberField = (label, field, value, options = {}) => `<label>${esc(label)}<input type="number" data-pvm-field="${esc(field)}" step="${esc(options.step ?? 1)}" min="${esc(options.min ?? 0)}" max="${esc(options.max ?? 1000000000000000)}" value="${value === null || value === undefined ? "" : esc(value)}" ${busy ? "disabled" : ""}></label>`;
    const typeOptions = (selected) => `<option value="" ${!selected ? "selected" : ""}>None</option>${PVM_DAMAGE_TYPES.map((type) => `<option value="${type}" ${type === selected ? "selected" : ""}>${esc(cleanLabel(type))}</option>`).join("")}`;
    const typeField = (label, field, selected) => `<label>${esc(label)}<select data-pvm-field="${esc(field)}" ${busy ? "disabled" : ""}>${typeOptions(selected)}</select></label>`;
    const result = state.pvmLab.result;
    const maxResult = state.pvmLab.maxResult;
    const optimizer = state.pvmLab.optimizer;
    const signed = (value, digits = 1) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
    const simulationCard = result ? `<div class="so-pvm-result">
      <div class="so-pvm-result-head"><strong>${esc(cleanLabel(result.npc))} L${compactNumber(result.level)}</strong><span>${compactNumber(result.runs)} matched-seed runs</span></div>
      <div class="so-pvm-compare"><div><span>Current snapshot</span><strong>${result.baseline.winRate.toFixed(1)}%</strong><small>${result.baseline.averageRounds.toFixed(1)} avg rounds • ${result.baseline.averageCloneHpPercent.toFixed(1)}% avg clone HP</small></div><b class="${result.test.winRate >= result.baseline.winRate ? "positive" : "negative"}">${signed(result.test.winRate - result.baseline.winRate)} pts</b><div><span>Test build</span><strong>${result.test.winRate.toFixed(1)}%</strong><small>${result.test.averageRounds.toFixed(1)} avg rounds • ${result.test.averageCloneHpPercent.toFixed(1)}% avg clone HP</small></div></div>
      ${(result.baseline.timeouts || result.test.timeouts) ? `<small class="so-pvm-warning">Round-limit outcomes: ${compactNumber(result.baseline.timeouts)} current / ${compactNumber(result.test.timeouts)} test.</small>` : ""}
    </div>` : `<div class="so-empty">Run a comparison to calculate current-versus-test win rate and battle length.</div>`;
    const maxCard = maxResult ? `<div class="so-pvm-result">
      <div class="so-pvm-result-head"><strong>Maximum level at ${Number(maxResult.threshold).toFixed(1)}%+ win rate</strong><span>Search cap ${compactNumber(maxResult.upperBound)}</span></div>
      <div class="so-pvm-compare"><div><span>Current snapshot</span><strong>L${compactNumber(maxResult.baseline.maxLevel)}</strong><small>${Number(maxResult.baseline.winrate).toFixed(1)}% confirmation</small></div><b class="${maxResult.test.maxLevel >= maxResult.baseline.maxLevel ? "positive" : "negative"}">${signed(maxResult.test.maxLevel - maxResult.baseline.maxLevel, 0)} lvls</b><div><span>Test build</span><strong>L${compactNumber(maxResult.test.maxLevel)}</strong><small>${Number(maxResult.test.winrate).toFixed(1)}% confirmation</small></div></div>
    </div>` : "";
    const optimizerCard = optimizer ? `<div class="so-pvm-result">
      <div class="so-pvm-result-head"><strong>Optimized allocation</strong><span>${compactNumber(optimizer.budget)} total points • ${esc(cleanLabel(optimizer.optimalStartingPoint || "official search"))}</span></div>
      <div class="so-grid">${PVP_CORE_STATS.map((stat) => `<div class="so-pair"><span>${cleanLabel(stat)}</span><strong>${compactNumber(optimizer.optimalStats?.[stat] || 0)}</strong></div>`).join("")}</div>
      <div class="so-pvm-optimizer-summary"><span>Current allocation: L${compactNumber(optimizer.currentMaxLevel)} at ${Number(optimizer.currentMaxWR || 0).toFixed(1)}%</span><strong>Optimized: L${compactNumber(optimizer.optimalMaxLevel)} at ${Number(optimizer.optimalMaxWR || 0).toFixed(1)}%</strong><b>${signed(Number(optimizer.levelGain || 0), 0)} levels</b></div>
      <div class="so-inline-actions"><button data-action="pvm-apply-optimizer" ${busy ? "disabled" : ""}>Apply optimized stats to test build</button></div>
    </div>` : "";

    return `<section class="so-pvm-lab"><h3>Official NPC combat lab</h3>
      <p class="so-note">Uses <strong>simulateBattle</strong>, <strong>findMaxLevelAtThreshold</strong>, and <strong>findOptimalBuild</strong> from the game’s currently installed local client. Simulations are informational and never start a real battle.</p>
      <div class="so-pvm-engine"><span class="${engineClass}">${engineLabel}</span><small>${state.pvmLab.engineSource ? esc(state.pvmLab.engineSource) : "Current game client"}${state.pvmLab.loadedAt ? ` • build loaded ${ageLabel(state.pvmLab.loadedAt) === "now" ? "just now" : `${ageLabel(state.pvmLab.loadedAt)} ago`}` : ""}</small></div>
      <div class="so-inline-actions so-pvm-top-actions"><button data-action="pvm-load-current" ${busy ? "disabled" : ""}>Reload current build</button><button data-action="pvm-reset-test" ${busy ? "disabled" : ""}>Reset test changes</button></div>

      <h3 class="so-subhead">Target & accuracy</h3>
      <div class="so-pvm-fields">
        <label>NPC<select data-pvm-setting="npc" ${busy ? "disabled" : ""}>${PVM_NPCS.map((row) => `<option value="${row.name}" ${row.name === npc.name ? "selected" : ""}>${esc(cleanLabel(row.name))} • ${esc(row.location)}</option>`).join("")}</select></label>
        ${numberField("NPC level", "@level", state.pvmLab.level, { min: 1, max: 10000000 })}
        <label>Simulation runs<select data-pvm-setting="runs" ${busy ? "disabled" : ""}>${[1000, 2500, 5000, 10000].map((runs) => `<option value="${runs}" ${runs === state.pvmLab.runs ? "selected" : ""}>${compactNumber(runs)}</option>`).join("")}</select></label>
        ${numberField("Win-rate target %", "@threshold", state.pvmLab.threshold, { step: 0.1, min: 50, max: 99.9 })}
        ${numberField("Maximum level search cap", "@upperBound", state.pvmLab.upperBound, { min: 10, max: 10000000 })}
        ${numberField("Optimizer stat budget", "@budget", state.pvmLab.budget, { min: 4, max: 1000000000000000 })}
      </div>
      <div class="so-pvm-weakness"><span>${esc(cleanLabel(npc.name))} weaknesses</span><strong>${npc.weakness.map(cleanLabel).join(" + ")}</strong></div>

      <h3 class="so-subhead">Test build stats</h3>
      <div class="so-pvm-fields">${numberField("Power", "power", build.power)}${numberField("Precision", "precision", build.precision)}${numberField("Evasion", "evasion", build.evasion)}${numberField("Hull", "hull", build.hull)}</div>

      <h3 class="so-subhead">Weapon & shield</h3>
      <div class="so-pvm-fields">${numberField("Weapon value", "weaponValue", build.weaponValue)}${numberField("Shield value", "shieldValue", build.shieldValue)}${typeField("Weapon type 1", "weaponType1", build.weaponType1)}${typeField("Weapon type 2", "weaponType2", build.weaponType2)}${typeField("Shield type 1", "shieldType1", build.shieldType1)}${typeField("Shield type 2", "shieldType2", build.shieldType2)}</div>
      <div class="so-pvm-checks"><label><input type="checkbox" data-pvm-field="weaponAnomaly" ${build.weaponAnomaly ? "checked" : ""} ${busy ? "disabled" : ""}> Anomalous weapon</label><label><input type="checkbox" data-pvm-field="shieldAnomaly" ${build.shieldAnomaly ? "checked" : ""} ${busy ? "disabled" : ""}> Anomalous shield</label></div>

      <h3 class="so-subhead">Skills, clones & station</h3>
      <div class="so-pvm-fields">${numberField("Weapon skill %", "weaponBoost", build.weaponBoost, { step: 0.1 })}${numberField("Hull skill %", "hullBoost", build.hullBoost, { step: 0.1 })}${numberField("Precision skill %", "precisionBoost", build.precisionBoost, { step: 0.1 })}${numberField("Evasion skill %", "evasionBoost", build.evasionBoost, { step: 0.1 })}${numberField("Clone count", "cloneCount", build.cloneCount, { min: 1, max: 100 })}${numberField("Squad station boost %", "ssBoost", build.ssBoost, { step: 0.1 })}${numberField("Clone crit override %", "cloneCritOverride", build.cloneCritOverride, { step: 0.1 })}${numberField("Clone crit damage override %", "cloneCritDamageOverride", build.cloneCritDamageOverride, { step: 0.1 })}${numberField("Clone dual-shot override %", "cloneDualShotOverride", build.cloneDualShotOverride, { step: 0.1 })}</div>
      <p class="so-note">Leave clone overrides blank to preserve each live clone’s individual values. Added clones use the current clone average.</p>

      <h3 class="so-subhead">PvM catalyst bonuses</h3>
      <div class="so-pvm-fields so-pvm-catalysts">${PVP_CATALYST_STATS.map((stat) => numberField(`${cleanLabel(stat)} %`, `catalysts.${stat}`, build.catalysts[stat], { step: 0.1, max: 100000 })).join("")}</div>

      ${busy ? `<div class="so-pvm-progress"><i style="width:${Math.max(2, Math.min(100, state.pvmLab.progress * 100)).toFixed(1)}%"></i><span>${esc(state.pvmLab.message)}</span></div>` : `<p class="so-pvm-status ${state.pvmLab.job === "error" ? "error" : ""}">${esc(state.pvmLab.message)}</p>`}
      <div class="so-pvm-primary-actions"><button data-action="pvm-run" ${busy ? "disabled" : ""}>Run current vs test</button><button data-action="pvm-max-scan" ${busy ? "disabled" : ""}>Scan maximum level</button><button data-action="pvm-optimize" ${busy ? "disabled" : ""}>Optimize stat allocation</button></div>

      <h3 class="so-subhead">Simulation results</h3>${simulationCard}${maxCard}${optimizerCard}
      <p class="so-note">The same deterministic random sequence is used for Current and Test, which reduces noise in small before/after changes. Exact individual battles can still vary because combat uses RNG.</p>
    </section>`;
  };

  const operationDueAt = (value, startedAt = 0) => {
    const raw = finite(value);
    if (raw === null || raw <= 0) return 0;
    if (raw > 1000000000) return apiTimeMs(raw);
    const started = apiTimeMs(startedAt);
    if (started) return started + raw * 1000;
    return 0;
  };

  const operationTimeline = () => {
    const ops = state.operations || {};
    const rows = [];
    const queue = ops.labqueue || {};
    if (queue.building && !queue.done) rows.push({ key: `lab:${queue.building}`, kind: "Lab", name: String(queue.building), dueAt: operationDueAt(queue.timer || queue.total, queue.started) });
    const offlineAt = apiTimeMs(ops.actions?.offlineActionsExpiresAt);
    if (offlineAt) rows.push({ key: "offline", kind: "Offline actions", name: "Offline action capacity", dueAt: offlineAt });
    const stellariumAt = apiTimeMs(ops.base?.nextStellariumTick);
    if (stellariumAt) rows.push({ key: "stellarium", kind: "Stellarium", name: `Next tick${ops.base?.stellariumHourly ? ` • ${compactNumber(ops.base.stellariumHourly)}/h` : ""}`, dueAt: stellariumAt });
    for (const boost of Array.isArray(ops.globalBoosts) ? ops.globalBoosts : []) {
      const dueAt = operationDueAt(boost?.timer ?? boost?.expiresAt, boost?.startedAt);
      if (dueAt) rows.push({ key: `boost:${boost?.boost?.name || boost?.name || rows.length}`, kind: "Boost", name: String(boost?.boost?.name || boost?.name || "Active boost"), dueAt });
    }
    for (const [index, slot] of (Array.isArray(ops.petSlots) ? ops.petSlots : []).entries()) {
      const pet = slot?.pet || slot;
      const dueAt = operationDueAt(pet?.active_timer ?? pet?.timer ?? pet?.expiresAt, pet?.startedAt);
      if (dueAt) rows.push({ key: `pet:${index}`, kind: "Pet", name: String(pet?.name || pet?.pet_type || `Pet ${index + 1}`), dueAt });
    }
    return rows.filter((row) => row.dueAt).sort((a, b) => a.dueAt - b.dueAt);
  };

  const renderOperations = () => {
    const ops = state.operations || {};
    const timeline = operationTimeline();
    const duration = Math.max(1, Date.now() - Number(state.session.startAt || Date.now()));
    const resourcesGained = finite(state.session.latestResources) !== null && finite(state.session.baselineResources) !== null
      ? Math.max(0, Number(state.session.latestResources) - Number(state.session.baselineResources)) : null;
    const xpCards = ["battling", "gathering"].map((activity) => {
      const gain = sessionXpGain(activity);
      const rate = gain ? gain.gained / (duration / 3600000) : null;
      return `<div><span>${cleanLabel(activity)} XP</span><strong>${gain ? `${gain.estimated ? "≈" : ""}${compactNumber(gain.gained)}` : "—"}</strong><small>${rate !== null && duration >= XP_MIN_RATE_WINDOW_MS ? `${compactNumber(rate)}/h` : "calibrating"}</small></div>`;
    }).join("");
    const currentActions = [ops.actions?.currentNpc ? `Battling ${ops.actions.currentNpc}${ops.actions.currentNpcLevel ? ` L${ops.actions.currentNpcLevel}` : ""}` : "", ops.actions?.currentNode ? `Gathering ${ops.actions.currentNode}` : ""].filter(Boolean);
    return `<div class="so-ops">
      <div class="so-engine-status ${timeline.some((row) => row.dueAt <= Date.now()) ? "notified" : "armed"}"><span>Personal operations</span><strong>${currentActions.length ? esc(currentActions.join(" • ")) : "No active action exposed"}</strong><small>${ops.capturedAt ? `Official snapshot ${ageLabel(ops.capturedAt)} ago` : "Connect the official API in Sync for queues and timers"}</small></div>
      <section><h3>Timeline</h3><div class="so-timeline">${timeline.length ? timeline.map((row) => `<article class="${row.dueAt <= Date.now() ? "due" : ""}"><span>${esc(row.kind)}</span><strong>${esc(row.name)}</strong><b>${esc(countdownLabel(row.dueAt))}</b></article>`).join("") : `<div class="so-empty">No lab, stellarium, pet, boost, or offline-action timers are exposed in the cached snapshot.</div>`}</div></section>
      <section><h3>Current session</h3><div class="so-session-grid">${xpCards}<div><span>Resources</span><strong>${resourcesGained === null ? "—" : compactNumber(resourcesGained)}</strong><small>${resourcesGained !== null && duration >= RESOURCE_MIN_RATE_WINDOW_MS ? `${compactNumber(resourcesGained / (duration / 3600000))}/h` : "60m calibration"}</small></div><div><span>Travel / finds</span><strong>${Math.max(0, Object.keys(state.seen).length - Number(state.session.baselineSeen || 0))} / ${Math.max(0, verifiedPerfectCount() - Number(state.session.baselinePerfect || 0))}</strong><small>systems / perfect</small></div></div><p class="so-note">Session began ${ageLabel(state.session.startAt)} ago. Drop counts are withheld because the client has not exposed a reliable passive drop event.</p></section>
      <section><h3>Snapshot summary</h3><div class="so-grid">${renderPairs({ laboratory_items: Array.isArray(ops.laboratory) ? ops.laboratory.length : Object.keys(ops.laboratory || {}).length, base_modules: Array.isArray(ops.base?.modules) ? ops.base.modules.length : 0, active_buffs: Array.isArray(ops.globalBoosts) ? ops.globalBoosts.length : 0, pet_slots: Array.isArray(ops.petSlots) ? ops.petSlots.length : 0 })}</div></section>
      <button class="so-alert-test" data-action="reset-session">Start a new session recap</button>
    </div>`;
  };

  const renderEngineAlerts = () => {
    const cooldown = state.engineCooldown;
    const remaining = cooldown.phase === "armed" && cooldown.readyAt
      ? Math.max(0, cooldown.readyAt - Date.now())
      : 0;
    const status = cooldown.phase === "armed"
      ? `Ready in ${cooldownTimeLabel(remaining)}`
      : cooldown.phase === "notified"
        ? "Engine ready now"
        : "Waiting for an active cooldown";
    const detail = cooldown.phase === "armed"
      ? "Armed from the countdown exposed by the map"
      : cooldown.phase === "notified"
        ? "This alert rearms after a new positive timer appears"
        : "Open the galaxy map once while the engine timer is running";
    const toggle = (key, title, description) => `
      <label class="so-alert-option">
        <input type="checkbox" data-action="engine-setting" data-setting="${key}" ${state.engineAlerts[key] ? "checked" : ""}>
        <span><strong>${esc(title)}</strong><small>${esc(description)}</small></span>
      </label>`;
    const desktopPermission = "Notification" in window ? window.Notification.permission : "unsupported";
    return `
      <div class="so-alerts">
        <div class="so-engine-status ${cooldown.phase}">
          <span>Engine monitor</span>
          <strong>${esc(status)}</strong>
          <small>${esc(detail)}</small>
        </div>
        <section>
          <h3>Notification options</h3>
          <div class="so-alert-options">
            ${toggle("sound", "Audio chime", "Three short ascending tones")}
            ${toggle("toast", "In-game notification", "A centered message over the game")}
            ${toggle("flash", "Screen flash", "A brief gold edge pulse")}
            ${toggle("badge", "Persistent ready badge", "Stays visible until dismissed or the next cooldown")}
            ${toggle("desktop", "Desktop notification", `System notification permission: ${desktopPermission}`)}
            ${toggle("events", "Galaxy event alerts", "Notify when a newly observed official event appears")}
            ${toggle("operations", "Personal timer alerts", "Notify when an exposed lab, pet, boost, or base timer finishes")}
          </div>
        </section>
        <label class="so-alert-volume">
          <span>Chime volume <strong>${Math.round(state.engineAlerts.volume * 100)}%</strong></span>
          <input type="range" min="0" max="100" step="5" value="${Math.round(state.engineAlerts.volume * 100)}" data-action="engine-volume">
        </label>
        <button class="so-alert-test" data-action="test-engine-alert">Test selected notifications</button>
        <p class="so-note">Press the test button once after loading the overlay so Electron permits alert audio. Monitoring is local and passive: it observes the timer already shown by the game and never presses travel or sends a request.</p>
      </div>`;
  };

  const renderSync = () => {
    const connected = state.sync.status === "online";
    const owner = syncOwner();
    const steamConnected = state.sync.authMode === "steam" && state.sync.token.length >= 32;
    const pendingSteam = Boolean(state.sync.linkRequest?.requestId);
    const lastSync = state.sync.lastPullAt ? `${ageLabel(state.sync.lastPullAt)} ago` : "never";
    const nextSyncAttempt = state.sync.nextAttemptAt > Date.now() ? new Date(state.sync.nextAttemptAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const queued = state.sync.outboxXp.length + state.sync.outboxResources.length + Object.keys(state.sync.outboxProfiles).length + state.sync.outboxSystems.length + state.sync.outboxBattles.length;
    const officialLast = state.officialApi.lastRefreshAt ? `${ageLabel(state.officialApi.lastRefreshAt)} ago` : "never";
    const arenaModel = state.sync.battleModel?.arena || {};
    const squadModel = state.sync.battleModel?.squadron || {};
    return `
      <div class="so-sync">
        <div class="so-official-card ${esc(state.officialApi.status)}">
          <div class="so-account-heading">
            <span>Official read-only API</span>
            <strong>${state.officialApi.configured ? "Connected on this PC" : state.officialApi.available ? "One-time API key setup" : "Launcher upgrade required"}</strong>
            <small>${esc(state.officialApi.message)}${state.officialApi.configured ? ` • refreshed ${esc(officialLast)}` : ""}</small>
          </div>
          ${state.officialApi.available && !state.officialApi.configured ? `
            <label class="so-sync-field">Personal API key from your in-game profile
              <input type="password" data-official-api-key placeholder="Paste once — it stays encrypted on this PC" spellcheck="false" autocomplete="off">
            </label>
            <button class="so-official-button" data-action="official-api-save" ${state.officialApi.busy ? "disabled" : ""}>Save key & connect</button>
          ` : ""}
          ${state.officialApi.available && state.officialApi.configured ? `<div class="so-official-actions"><button class="so-official-button" data-action="official-api-refresh" ${state.officialApi.busy ? "disabled" : ""}>Refresh official data</button><button class="so-link-secondary danger" data-action="official-api-remove" ${state.officialApi.busy ? "disabled" : ""}>Remove key from this PC</button></div>` : ""}
          <small class="so-key-safety">The key is protected by Windows DPAPI, never saved in browser storage, and never uploaded to the shared database. The helper permits only documented GET routes.</small>
        </div>
        <div class="so-sync-status ${esc(state.sync.status)}">
          <span>${connected ? "Shared database online" : state.sync.enabled ? "Shared database" : "Shared database off"}</span>
          <strong>${esc(state.sync.message)}</strong>
          <small>Last successful pull: ${esc(lastSync)} • ${queued} queued item${queued === 1 ? "" : "s"}${nextSyncAttempt ? ` • retry after ${esc(nextSyncAttempt)}` : ""}</small>
        </div>
        <div class="so-account-card ${steamConnected ? "connected" : ""}">
          <div class="so-account-heading">
            <span>Stellar Odyssey account</span>
            <strong>${esc(owner || "Open your own profile to detect the account")}</strong>
            <small>${steamConnected ? "This device follows the account through Steam" : "Connect once on each new device — no code copying"}</small>
          </div>
          <button class="so-steam-button" data-action="sync-steam" ${state.sync.authBusy || !owner ? "disabled" : ""}>${steamConnected ? "Reconnect Steam" : pendingSteam ? "Restart connection" : "Connect with Steam"}</button>
          ${pendingSteam ? `<a class="so-link-secondary" href="${esc(String(state.sync.linkRequest?.authorizeUrl || ""))}" target="_blank" rel="noopener noreferrer">Open Steam sign-in</a><small class="so-link-wait">Waiting for Steam confirmation… If no browser opened, use the link above.</small>` : ""}
          ${steamConnected ? `<button class="so-link-secondary danger" data-action="sync-steam-revoke">Disconnect this device</button>` : ""}
        </div>
        <label class="so-sync-toggle">
          <input type="checkbox" data-action="sync-enabled" ${state.sync.enabled ? "checked" : ""}>
          <span><strong>Enable shared history and map index</strong><small>Connects only to the informational companion service, never to the game server.</small></span>
        </label>
        <label class="so-sync-toggle">
          <input type="checkbox" data-action="battle-sharing" ${state.sync.battleSharing ? "checked" : ""} ${state.sync.enabled ? "" : "disabled"}>
          <span><strong>Contribute anonymized completed battles</strong><small>Passively records Arena and Squadron results already loaded by the game. Player names, game IDs, credentials, and raw profile payloads are excluded.</small></span>
        </label>
        <div class="so-model-card so-research-card">
          <div><span>Arena observations</span><strong>${compactNumber(arenaModel.battles || 0)}</strong></div>
          <div><span>Profile-matched examples</span><strong>${compactNumber(arenaModel.matched || 0)}</strong></div>
          <div><span>Log-derived examples</span><strong>${compactNumber(arenaModel.inferred || 0)}</strong></div>
          <div><span>Squadron observations</span><strong>${compactNumber(squadModel.battles || 0)}</strong></div>
          <div><span>This device captured</span><strong>${compactNumber(state.sync.battleCaptured)}</strong></div>
          <small>${state.sync.lastBattleAt ? `Last captured ${esc(state.sync.lastBattleKind === "squadron" ? "Squadron" : "Arena")} battle ${esc(ageLabel(state.sync.lastBattleAt))} ago.` : "Waiting for a completed Arena or Squadron result."} ${state.sync.outboxBattles.length ? `${state.sync.outboxBattles.length} waiting to upload.` : "All captured battles are synchronized."}</small>
        </div>
        <details class="so-sync-advanced">
          <summary>Recovery and advanced settings</summary>
          <label class="so-sync-field">Companion endpoint
            <input type="url" data-sync-field="endpoint" value="${esc(state.sync.endpoint)}" placeholder="https://your-worker.example.workers.dev" spellcheck="false">
          </label>
          <label class="so-sync-field">Recovery sync code
            <input type="password" data-sync-field="token" value="${state.sync.authMode === "code" ? esc(state.sync.token) : ""}" placeholder="Optional fallback code" spellcheck="false" autocomplete="off">
          </label>
          <div class="so-sync-actions">
            <button data-action="sync-generate">Generate recovery code</button>
            <button data-action="sync-copy" ${state.sync.authMode === "code" && state.sync.token ? "" : "disabled"}>Copy recovery code</button>
            <button class="primary" data-action="sync-save">Use recovery code & sync</button>
          </div>
        </details>
        <p class="so-note">Steam linking and the API key have separate jobs: Steam carries favorites and shared history across PCs; the API key supplies this account’s own official snapshot, journal, stations, events, and hourly market history. Enter the API key once on each PC. If shared history is enabled, sanitized profile, XP, RSS, map, and opted-in completed-battle observations may be pooled; raw API responses are never uploaded.</p>
        <p class="so-note">Steam authentication happens in Steam’s browser page. The overlay never receives a Steam password and never uploads game cookies, session credentials, or the official API key.</p>
      </div>`;
  };

  const renderAbout = () => `
    <div class="so-about">
      <h3>Feature locations</h3>
      <div class="so-feature-index">
        <div><b>Nodes</b><span>event radar, perfect-node search, routes and waypoints</span></div>
        <div><b>Roster</b><span>squad readiness, stations, buildings and bonuses</span></div>
        <div><b>Profiles</b><span>levels, stats, gear, catalysts and pets</span></div>
        <div><b>Builds</b><span>PvP comparison sandbox, modifiers, presets and share codes</span></div>
        <div><b>Ops</b><span>personal timers and current-session recap</span></div>
        <div><b>Ranks</b><span>XP/RSS rankings and confidence safeguards</span></div>
        <div><b>Alerts</b><span>engine, event and personal-timer notification settings</span></div>
        <div><b>Market</b><span>charts, volatility, alerts and manual valuation</span></div>
      </div>
      <h3>Display-only compliance</h3>
      <p>This companion never sends gameplay actions, clicks controls, navigates profiles, or automates travel. With your explicit opt-in, its native helper uses only documented GET routes in the official read-only Public API.</p>
      <p>Engine alerts only observe the countdown already rendered by the map. They never activate the engine or initiate travel.</p>
      <p>XP provides separate active-session and wall-clock estimates from repeated snapshots. Active mode uses only continuous positive-gain intervals; wall-clock mode includes idle/offline gaps. Other players are never polled. Your own official snapshot is cached for at least 30 minutes, market history for at least one hour, and optional shared sync talks only to the separately configured companion service.</p>
      <p>Battle research observes only completed Arena and Squadron results the game has already loaded. Names and internal IDs are replaced with side/slot labels before upload. Known profile stats are marked observed, log-derived behavior is marked estimated, and unavailable catalysts stay unknown.</p>
      <p>The NPC Combat Lab imports the game’s already-installed local simulation library in memory. It performs calculations on this PC only, never starts combat, and never sends simulator inputs or results to the game server or companion database.</p>
      <h3>Map legend</h3>
      <div class="so-legend"><span class="node" aria-hidden="true"></span> golden halo: system with a 100% resource node</div>
      <div class="so-legend"><span class="squad">S</span> squad member with a recently exposed location</div>
      <div class="so-legend"><span class="friend">F</span> local friend with a recently exposed location</div>
      <div class="so-legend"><span class="event">D</span> official dungeon, solo-dungeon, or rune event</div>
      <p class="so-note">Player markers expire after 30 minutes. If the game never exposes a player’s coordinates to your client, the overlay intentionally shows “location unavailable.”</p>
      <button class="so-danger" data-action="clear-cache">Clear overlay cache</button>
      <div class="so-version">Stellar Odyssey Intel Overlay v${VERSION}</div>
    </div>`;

  const panelContent = () => state.tab === "nodes"
    ? renderNodes()
    : state.tab === "roster"
      ? renderRoster()
    : state.tab === "profiles"
      ? renderProfile()
      : state.tab === "builds"
        ? renderBuilds()
        : state.tab === "pvm"
          ? renderPvmLab()
          : state.tab === "ops"
            ? renderOperations()
            : state.tab === "xp"
              ? renderXpTrends()
              : state.tab === "ranks"
                ? renderXpRankings()
                : state.tab === "alerts"
                  ? renderEngineAlerts()
                  : state.tab === "market"
                    ? renderMarket()
                    : state.tab === "sync"
                      ? renderSync()
                      : renderAbout();

  const ensureUi = () => {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    const style = document.createElement("style");
    style.id = `${ROOT_ID}-style`;
    style.textContent = `
      @media(min-width:1101px){
        html.${DRAWER_LAYOUT_CLASS} #q-app{width:100%!important;max-width:100%!important;transition:width .22s ease,max-width .22s ease}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app{width:calc(100% - 432px)!important;max-width:calc(100% - 432px)!important}
        html.${DRAWER_LAYOUT_CLASS} #q-app .q-header,html.${DRAWER_LAYOUT_CLASS} #q-app .q-footer{transition:right .22s ease!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header,html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-footer{right:432px!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar{height:40px!important;min-height:40px!important;align-items:center!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.row.justify-between.items-center{display:flex!important;flex:1 1 auto!important;min-width:0!important;height:40px!important;min-height:40px!important;flex-wrap:nowrap!important;align-items:center!important;align-self:center!important;justify-content:flex-start!important;column-gap:0!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.row.justify-between.items-center>.playersOnline{flex:0 0 auto!important;white-space:nowrap!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.row.justify-between.items-center>.navbar_links{display:flex!important;flex:0 0 auto!important;min-width:max-content!important;flex-wrap:nowrap!important;align-items:center!important;white-space:nowrap!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.row.justify-between.items-center>.navbar_links>.navbar_link{flex:0 0 auto!important;margin-left:4px!important;margin-right:4px!important;white-space:nowrap!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.so-intel-native-boosts{display:none!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.so-intel-boost-cluster{display:flex!important}
        html.${DRAWER_LAYOUT_CLASS}.${DRAWER_OPEN_CLASS} #q-app .q-header>.q-toolbar>.q-list:not(.gt-sm){flex:0 0 auto!important;flex-wrap:nowrap!important;align-items:center!important;align-self:center!important}
      }
      #q-app .so-intel-boost-cluster{position:relative;z-index:3;display:none;flex:0 0 34px;width:34px;height:32px;align-items:center;justify-content:center;margin-right:4px;font:12px/1.35 Rubik,Segoe UI,sans-serif}
      #q-app .so-intel-boost-trigger{display:grid;width:30px;height:30px;place-items:center;padding:3px;border:1px solid #3d5e6d;border-radius:2px;background:#172a38;color:#dff;box-shadow:inset 0 0 8px #0006;cursor:pointer}
      #q-app .so-intel-boost-trigger-grid{display:grid;width:100%;height:100%;grid-template-columns:repeat(2,1fr);gap:1px}
      #q-app .so-intel-boost-trigger-grid svg{display:block;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
      #q-app .so-intel-boost-popover{position:absolute;z-index:20;top:36px;right:0;width:292px;padding:11px 12px 12px;border:1px solid #496b7b;border-radius:5px;background:#101f2d;color:#eaf4f8;box-shadow:0 14px 30px #0009;overflow:visible}
      #q-app .so-intel-boost-popover[hidden]{display:none!important}
      #q-app .so-intel-boost-popover:before{content:"";position:absolute;top:-6px;right:10px;width:10px;height:10px;transform:rotate(45deg);border-left:1px solid #496b7b;border-top:1px solid #496b7b;background:#101f2d}
      #q-app .so-intel-boost-popover>strong{display:block;margin-bottom:10px;color:#eaf4f8;font-size:12px;font-weight:500}
      #q-app .so-intel-boost-list{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
      #q-app .so-intel-boost-item{position:relative;display:flex;min-width:0;flex-direction:column;align-items:center;gap:4px;color:#a8c0ca;font-size:10px;text-align:center;cursor:default;outline-offset:2px}
      #q-app .so-intel-boost-item>svg{display:block;width:34px;height:34px}
      #q-app .so-intel-boost-item.inactive{filter:saturate(.25);opacity:.62}
      #q-app .so-intel-boost-tooltip{position:absolute;z-index:22;top:calc(100% + 8px);left:50%;display:none;width:max-content;min-width:224px;padding:8px 11px;transform:translateX(-50%);border-radius:4px;background:#263b4d;color:#e4edf2;box-shadow:0 5px 14px #0008;font-size:11px;line-height:1.45;text-align:left;white-space:nowrap;pointer-events:none}
      #q-app .so-intel-boost-tooltip:before{content:"";position:absolute;top:-5px;left:calc(50% - 5px);width:10px;height:10px;transform:rotate(45deg);background:#263b4d}
      #q-app .so-intel-boost-tooltip>span{display:block}#q-app .so-intel-boost-tooltip b{color:#8ba8bb;font-weight:400;font-variant-numeric:tabular-nums}
      #q-app .so-intel-boost-item:hover .so-intel-boost-tooltip,#q-app .so-intel-boost-item:focus .so-intel-boost-tooltip{display:block}
      #q-app .so-intel-boost-item:first-child .so-intel-boost-tooltip{left:0;transform:none}#q-app .so-intel-boost-item:first-child .so-intel-boost-tooltip:before{left:17px}
      #q-app .so-intel-boost-item:last-child .so-intel-boost-tooltip{right:0;left:auto;transform:none}#q-app .so-intel-boost-item:last-child .so-intel-boost-tooltip:before{right:17px;left:auto}
      #${ROOT_ID}{position:fixed;inset:0;z-index:2147483646;font:13px/1.4 Rubik,Segoe UI,sans-serif;color:#e8f5ff;pointer-events:none}
      #${ROOT_ID} *{box-sizing:border-box}
      #${ROOT_ID} button,#${ROOT_ID} select{font:inherit}
      #${ROOT_ID} .so-engine-ready-badge{display:none;pointer-events:auto;position:fixed;right:44px;top:52px;border:1px solid #ffd95a;background:linear-gradient(135deg,#503d0b,#231d0a);color:#fff0a4;border-radius:9px;padding:8px 11px;font-weight:900;letter-spacing:.05em;box-shadow:0 0 22px #ffc92877,0 7px 24px #0009;cursor:pointer;animation:soEngineBadgePulse 1.8s ease-in-out infinite;transition:right .22s ease}
      #${ROOT_ID} .so-engine-ready-badge.visible{display:block}
      #${ROOT_ID} .so-toggle{pointer-events:auto;position:fixed;right:0;top:50%;width:36px;height:118px;transform:translateY(-50%);border:1px solid #34d6cb;border-right:0;background:linear-gradient(180deg,#0d2635,#102f44);color:#bffbf5;border-radius:10px 0 0 10px;padding:10px 7px;font-weight:900;box-shadow:-7px 7px 24px #0009;cursor:pointer;letter-spacing:.08em;writing-mode:vertical-rl;text-orientation:mixed;transition:background .18s,color .18s,box-shadow .18s}
      #${ROOT_ID}:not(.collapsed) .so-toggle{opacity:0;visibility:hidden;pointer-events:none}
      #${ROOT_ID} .so-panel{pointer-events:auto;position:fixed;right:0;top:0;bottom:0;display:flex;width:min(432px,calc(100vw - 40px));max-height:none;margin:0;background:rgba(8,20,31,.985);border-left:1px solid #2e566c;box-shadow:-16px 0 48px #000c;overflow:hidden;backdrop-filter:blur(10px);transform:translateX(100%);opacity:0;visibility:hidden;transition:transform .22s ease,opacity .18s ease,visibility 0s linear .22s;will-change:transform}
      #${ROOT_ID}:not(.collapsed) .so-panel{transform:translateX(0);opacity:1;visibility:visible;transition:transform .22s ease,opacity .18s ease,visibility 0s linear 0s}
      #${ROOT_ID} .so-tabs{display:flex;flex:0 0 68px;min-width:68px;flex-direction:column;background:#091824;border-right:1px solid #203d50}
      #${ROOT_ID} .so-brand{display:flex;flex:0 0 64px;flex-direction:column;align-items:center;justify-content:center;border-bottom:1px solid #203d50;color:#69efe0;line-height:1.05;letter-spacing:.07em}
      #${ROOT_ID} .so-brand strong{font-size:15px}.so-brand span{margin-top:3px;color:#557b8c;font-size:8px;text-transform:uppercase}
      #${ROOT_ID} .so-tabs button{position:relative;display:flex;flex:0 0 52px;align-items:center;justify-content:center;min-width:0;border:0;border-left:2px solid transparent;border-bottom:1px solid #142f3d;background:transparent;color:#7897a7;padding:6px 3px;cursor:pointer;font-size:9px;letter-spacing:.02em;transition:background .15s,color .15s,border-color .15s}
      #${ROOT_ID} .so-tabs button:hover{background:#0e2736;color:#b9e6e3}
      #${ROOT_ID} .so-tabs button.active{color:#75eee2;background:#123044;border-left-color:#44d8cb;box-shadow:none}
      #${ROOT_ID} .so-tabs button.so-tab-bottom{margin-top:auto;border-top:1px solid #203d50}
      #${ROOT_ID} .so-workspace{display:flex;flex:1;min-width:0;flex-direction:column;background:rgba(8,20,31,.97)}
      #${ROOT_ID} .so-title{display:flex;flex:0 0 64px;justify-content:space-between;align-items:center;gap:10px;padding:10px 13px;background:linear-gradient(120deg,#12364a,#102637);border-bottom:1px solid #274b60}
      #${ROOT_ID} .so-title>div{display:flex;min-width:0;flex-direction:column}.so-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;letter-spacing:.03em;color:#d6ffff}.so-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:#71a4b6;letter-spacing:.02em}.so-drawer-close{display:grid;flex:0 0 28px;place-items:center;width:28px;height:28px;border:1px solid #31576a;background:#0c2230;color:#9cc5d1;border-radius:7px;cursor:pointer;font-size:18px!important;line-height:1}.so-drawer-close:hover{border-color:#58cbbf;color:#dffffb}
      #${ROOT_ID} .so-content{flex:1;min-height:0;max-height:none;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:12px 12px 28px;scrollbar-width:thin;scrollbar-color:#2b6175 #0b1926}
      #${ROOT_ID} .so-content::-webkit-scrollbar{width:10px}#${ROOT_ID} .so-content::-webkit-scrollbar-track{background:#0b1926}#${ROOT_ID} .so-content::-webkit-scrollbar-thumb{background:#2b6175;border:2px solid #0b1926;border-radius:8px}
      #${ROOT_ID} .so-footer{display:flex;flex:0 0 40px;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;border-top:1px solid #203d50;background:#091824;color:#6f8e9d;font-size:9px}
      #${ROOT_ID} .so-footer span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.so-footer b{flex:0 0 auto;color:#62ddcf;font-size:9px}
      #${ROOT_ID} .so-note{margin:7px 1px 11px;color:#88a6b5;font-size:11px}
      #${ROOT_ID} .so-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #${ROOT_ID} .so-metrics>div{display:flex;flex-direction:column;padding:10px;background:#10283a;border:1px solid #244b60;border-radius:8px}
      #${ROOT_ID} .so-metrics strong{font-size:20px;color:#66ebdf}.so-metrics span{color:#84a1b1;font-size:10px;text-transform:uppercase}
      #${ROOT_ID} .so-list{display:flex;flex-direction:column;gap:6px}
      #${ROOT_ID} .so-row{background:#0f2636;border:1px solid #1f4255;border-radius:8px;padding:8px}
      #${ROOT_ID} .so-row-main{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.so-row-main>*{min-width:0}.so-row-main strong{color:#dff}.so-row-main span{color:#7e9bab;font-size:11px}
      #${ROOT_ID} .so-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;min-width:0}.so-chips span{max-width:100%;overflow-wrap:anywhere;padding:2px 6px;border:1px solid #28786f;background:#103a3a;color:#74f3df;border-radius:999px;font-size:10px}.so-chips em{color:#718b99;font-size:11px}
      #${ROOT_ID} .so-chips.muted span{border-color:#355166;background:#182b39;color:#abc0cc}.so-chips.catalysts span{border-color:#81652a;background:#3a2f14;color:#ffd975}.so-chips.pets span{border-color:#653b86;background:#281a37;color:#d9b1ff}
      #${ROOT_ID} .so-player-row{display:grid;grid-template-columns:25px 1fr auto;align-items:center;gap:7px}
      #${ROOT_ID} .so-star{border:0;background:transparent;color:#496171;font-size:18px;line-height:1;cursor:pointer;padding:2px}.so-star.active{color:#ffd76a!important;text-shadow:0 0 10px #ffcf40}
      #${ROOT_ID} .so-player{border:0;background:transparent;color:#dff;text-align:left;cursor:pointer;padding:0}.so-player strong,.so-player span{display:block}.so-player span{font-size:10px;color:#7895a5}
      #${ROOT_ID} .so-location{font-size:9px;color:#657b88;text-align:right}.so-location.fresh{color:#6be6db}
      #${ROOT_ID} .so-empty{padding:20px 12px;text-align:center;color:#7f9aa8;border:1px dashed #2a4b5c;border-radius:8px}.so-profile-empty{margin-top:6px}
      #${ROOT_ID} .so-profile-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:10px;background:linear-gradient(135deg,#13364b,#202d46);border:1px solid #31536a;border-radius:9px}.so-profile-head>div{min-width:0}.so-profile-head>div>*{display:block;overflow-wrap:anywhere}.so-profile-head strong{font-size:17px;color:#dff}.so-profile-head span{font-size:11px;color:#8da8b8}
      #${ROOT_ID} .so-profile-favorite{flex:0 0 auto;border:1px solid #526574;background:#122735;color:#9eb2bd;border-radius:7px;padding:5px 7px;font-size:10px;cursor:pointer}.so-profile-favorite.active{border-color:#9b792e;background:#3b3016;color:#ffd970}.so-self-badge{flex:0 0 auto;padding:4px 6px;border:1px solid #31536a;border-radius:6px;color:#78a0b2!important;text-transform:uppercase;font-size:9px!important}
      #${ROOT_ID} .so-select-label{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;color:#7e9aa9;font-size:11px;margin:10px 0}.so-select-label select{min-width:0;width:210px;background:#10283a;border:1px solid #31536a;color:#dff;border-radius:6px;padding:5px}
      #${ROOT_ID} section{margin-top:12px}#${ROOT_ID} section h3,#${ROOT_ID} .so-about h3{margin:0 0 6px;color:#77dfd6;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
      #${ROOT_ID} .so-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 8px;min-width:0}.so-pair{display:flex;justify-content:space-between;gap:5px;min-width:0;padding:5px 6px;background:#102636;border-radius:5px}.so-pair span{min-width:0;color:#819cab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.so-pair strong{flex:0 0 auto;max-width:48%;overflow:hidden;text-overflow:ellipsis;color:#d6e9f2;font-size:11px}
      #${ROOT_ID} .so-gear{display:flex;flex-direction:column;gap:6px;min-width:0}.so-gear article{min-width:0;background:#102636;border:1px solid #25495c;border-radius:7px;padding:8px}.so-gear-title{display:flex;justify-content:space-between;gap:8px;min-width:0}.so-gear-title>*{min-width:0;overflow-wrap:anywhere}.so-gear-title span{color:#809dab}.so-gear-title strong{color:#e6f8ff}.so-gear-meta{color:#708d9c;font-size:10px;margin-top:2px}
      #${ROOT_ID} .so-xp-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-bottom:9px}.so-xp-controls label{display:flex;flex-direction:column;gap:3px;color:#7897a8;font-size:10px}.so-xp-controls select{min-width:0;width:100%;background:#10283a;border:1px solid #31536a;color:#dff;border-radius:6px;padding:5px}
      #${ROOT_ID} .so-rank-controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px;margin-bottom:6px}.so-rank-controls label{display:flex;align-items:center;gap:8px;color:#7897a8;font-size:10px}.so-rank-controls select{min-width:125px;background:#10283a;border:1px solid #31536a;color:#dff;border-radius:6px;padding:5px}
      #${ROOT_ID} .so-xp-summary{margin-bottom:4px}.so-xp-list{display:flex;flex-direction:column;gap:7px}.so-xp-card{min-width:0;padding:9px;background:#102636;border:1px solid #285066;border-radius:8px}.so-xp-title{display:flex;justify-content:space-between;gap:8px}.so-xp-title strong{color:#dff}.so-xp-title span{color:#89a7b6;font-size:11px}.so-xp-progress{height:6px;margin-top:7px;background:#071721;border-radius:5px;overflow:hidden}.so-xp-progress i{display:block;height:100%;background:linear-gradient(90deg,#37aeb3,#5af1d5);border-radius:5px}.so-xp-progress-text{display:flex;justify-content:space-between;margin-top:3px;color:#7793a2;font-size:9px}.so-xp-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}.so-xp-stats>div{display:flex;flex-direction:column;padding:5px 6px;background:#0b1e2b;border-radius:5px}.so-xp-stats span{color:#748f9d;font-size:9px;text-transform:uppercase}.so-xp-stats strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#c9f7ef;font-size:12px}.so-xp-confidence{margin-top:5px;color:#66d9cb;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.so-xp-confidence.low{color:#f0bd62}.so-xp-confidence.pending{color:#7893a2}
      #${ROOT_ID} .so-xp-leaderboards{margin:2px 0 11px}.so-xp-leaderboard-card{margin-top:8px!important;border:1px solid #2b5265;background:#0c202e;border-radius:8px;overflow:hidden}.so-xp-leaderboard-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px;background:linear-gradient(120deg,#12354a,#102c36);border-bottom:1px solid #284b5d}.so-xp-leaderboard-head strong{color:#d8ffff;font-size:12px}.so-xp-leaderboard-head span{color:#ffd86a;font-size:10px;font-weight:800}.so-xp-leaderboard-list{max-height:230px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2b6175 #0b1926}.so-xp-leaderboard-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:5px;min-width:0;padding:6px 8px;border-bottom:1px solid #173344}.so-xp-leaderboard-row:last-child{border-bottom:0}.so-xp-leaderboard-row>b{color:#6e91a2;font-size:10px}.so-xp-leaderboard-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9d0da;font-size:11px}.so-xp-leaderboard-row>strong{color:#77e8dc;font-size:11px;text-align:right}.so-xp-leaderboard-row>strong small{color:#6f8d9a;font-size:8px;font-weight:500}.so-xp-leaderboard-row.self{background:linear-gradient(90deg,#3f3513aa,#17333a)}.so-xp-leaderboard-row.self>b,.so-xp-leaderboard-row.self>span{color:#ffe48b;font-weight:800}.so-xp-leaderboard-row.self>strong{color:#fff0ab}.so-xp-leaderboard-foot{padding:6px 8px;background:#091b27;color:#6f8c9b;font-size:9px}
      #${ROOT_ID} .so-engine-status{display:flex;flex-direction:column;gap:2px;padding:12px;border:1px solid #31536a;background:linear-gradient(135deg,#102c3d,#132537);border-radius:9px}.so-engine-status>span{color:#75a2b6;font-size:9px;text-transform:uppercase;letter-spacing:.09em}.so-engine-status>strong{color:#dff;font-size:17px}.so-engine-status>small{color:#7f9aa8}.so-engine-status.armed{border-color:#39796f;box-shadow:inset 3px 0 #4edccb}.so-engine-status.notified{border-color:#a98832;background:linear-gradient(135deg,#44350e,#1e291f);box-shadow:inset 3px 0 #ffd65a}.so-engine-status.notified>strong{color:#ffe58b}
      #${ROOT_ID} .so-alert-options{display:flex;flex-direction:column;gap:6px}.so-alert-option{display:grid;grid-template-columns:20px 1fr;align-items:center;gap:7px;padding:7px 8px;background:#102636;border:1px solid #25495c;border-radius:7px;cursor:pointer}.so-alert-option input{width:15px;height:15px;margin:0;accent-color:#4ddfce}.so-alert-option span{display:flex;flex-direction:column;min-width:0}.so-alert-option strong{color:#d9f4fa;font-size:11px}.so-alert-option small{color:#7895a4;font-size:9px}
      #${ROOT_ID} .so-alert-volume{display:flex;flex-direction:column;gap:5px;margin-top:11px;padding:8px;background:#0d2130;border-radius:7px;color:#86a3b2;font-size:10px}.so-alert-volume span{display:flex;justify-content:space-between}.so-alert-volume strong{color:#c8eee9}.so-alert-volume input{width:100%;accent-color:#52ddce}.so-alert-test{width:100%;margin-top:9px;border:1px solid #398d83;background:linear-gradient(135deg,#123e43,#14313f);color:#bffbf3;border-radius:7px;padding:8px 10px;font-weight:800;cursor:pointer}.so-alert-test:hover{border-color:#62d9cc}
      #${ROOT_ID} .so-market-summary{display:flex;flex-direction:column;gap:2px;padding:12px;border:1px solid #31536a;background:linear-gradient(135deg,#102c3d,#132537);border-radius:9px}.so-market-summary>strong{color:#61e8dc;font-size:24px}.so-market-summary>span{color:#c8e9ec;font-size:11px}.so-market-summary>small{color:#7897a7;font-size:9px}.so-market-list{display:flex;flex-direction:column;gap:7px}.so-market-row{display:grid;grid-template-columns:minmax(90px,1fr) 1fr 1fr;align-items:center;gap:7px;padding:9px;background:#102636;border:1px solid #285066;border-radius:8px}.so-market-row>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#dcffff;font-size:11px}.so-market-row>div{display:flex;min-width:0;flex-direction:column}.so-market-row span{color:#718f9d;font-size:8px;text-transform:uppercase}.so-market-row b{overflow:hidden;text-overflow:ellipsis;color:#75e8dc;font-size:12px}.so-market-row small{color:#91a8b2;font-size:8px}
      #${ROOT_ID} .so-tool-controls{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:7px}.so-tool-controls label,.so-market-tools label,.so-build-selectors label,.so-build-mods label{display:flex;min-width:0;flex-direction:column;gap:3px;color:#7897a8;font-size:9px}.so-tool-controls input,.so-tool-controls select,.so-market-tools input,.so-market-tools select,.so-build-selectors select,.so-build-mods input{min-width:0;width:100%;border:1px solid #31536a;border-radius:5px;background:#0b1e2b;color:#dff;padding:5px}.so-route-list,.so-event-list,.so-timeline{display:flex;flex-direction:column;gap:6px}.so-route-row{display:grid;grid-template-columns:23px minmax(0,1fr) auto;gap:7px;align-items:center;padding:7px;border:1px solid #285066;border-radius:7px;background:#102636}.so-route-row>b{display:grid;width:21px;height:21px;place-items:center;border-radius:50%;background:#24655f;color:#dffffa}.so-route-row>div{display:flex;min-width:0;flex-direction:column}.so-route-row strong{color:#dff}.so-route-row span{color:#7897a8;font-size:9px}.so-route-row button,.so-event button,.so-inline-actions button{border:1px solid #355f72;border-radius:5px;background:#123044;color:#a9d7df;padding:4px 6px;font-size:9px;cursor:pointer}.so-inline-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:6px}.so-event-feed{display:flex;flex-direction:column;gap:2px;margin:7px 0;padding:7px 8px;border:1px solid #31536a;border-left:3px solid #4ddcca;border-radius:6px;background:#0d2130}.so-event-feed strong{color:#dff;font-size:10px}.so-event-feed span,.so-event-feed small{color:#7897a8;font-size:9px}.so-event-feed.stale{border-left-color:#efb64f}.so-event-feed.error{border-left-color:#ed6974}.so-event-feed.error strong{color:#ffadb4}.so-event{display:grid;grid-template-columns:47px minmax(0,1fr) auto;align-items:center;gap:7px;padding:8px;border:1px solid #375468;border-left-width:3px;border-radius:7px;background:#102636}.so-event.rune{border-left-color:#c87aff}.so-event.dungeon{border-left-color:#ff6b73}.so-event.solo{border-left-color:#67e59f}.so-event.boss{border-left-color:#efb64f}.so-event-kind{color:#7f9cab;font-size:8px;font-weight:900}.so-event>div{display:flex;min-width:0;flex-direction:column}.so-event strong{color:#e5faff}.so-event small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7897a8;font-size:9px}
      #${ROOT_ID} .so-market-portfolio{display:flex;flex-direction:column;gap:2px;margin-top:8px;padding:9px;border:1px solid #2a5264;border-radius:8px;background:#0e2433}.so-market-portfolio span{color:#7a99a8;font-size:9px;text-transform:uppercase}.so-market-portfolio strong{color:#ffe084;font-size:18px}.so-market-portfolio small{color:#6f8c99;font-size:9px}.so-market-card{padding:9px;border:1px solid #285066;border-radius:8px;background:#102636}.so-market-heading{display:flex;justify-content:space-between;gap:7px}.so-market-heading strong{color:#dcffff}.so-market-heading span{color:#7897a8;font-size:9px}.so-spark{display:block;width:100%;height:36px;margin:5px 0;background:#091b27;border-radius:4px}.so-spark polyline{fill:none;stroke:#63e5d8;stroke-width:2;vector-effect:non-scaling-stroke}.so-market-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.so-market-values>div{display:flex;min-width:0;flex-direction:column}.so-market-values span{color:#718f9d;font-size:8px;text-transform:uppercase}.so-market-values b{overflow:hidden;text-overflow:ellipsis;color:#75e8dc;font-size:11px}.so-market-values small{color:#91a8b2;font-size:8px}.so-market-tools{display:grid;grid-template-columns:1fr 1fr 78px;align-items:end;gap:5px;margin-top:7px}.so-market-tools select{height:27px}
      #${ROOT_ID} .so-build-selectors,.so-build-columns{display:grid;grid-template-columns:1fr 1fr;gap:7px}.so-versus{display:grid;grid-template-columns:1fr 28px 1fr;align-items:center;gap:4px;margin:8px 0;padding:8px;border:1px solid #3b5366;border-radius:8px;background:linear-gradient(90deg,#173846,#362d19,#302041)}.so-versus>div{display:flex;min-width:0;flex-direction:column}.so-versus>div:last-child{text-align:right}.so-versus strong{overflow:hidden;text-overflow:ellipsis;color:#e8ffff}.so-versus span{color:#ffd86a;font-size:9px}.so-versus>b{text-align:center;color:#8ba5b2;font-size:10px}.so-build-columns>div{padding:7px;border-radius:6px;background:#0c202e}.so-build-columns>div>strong{color:#8fc8ca;font-size:9px;text-transform:uppercase}.so-build-mods{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:5px}.so-chips span button{border:0;background:transparent;color:#79c8ec;padding:0;font-size:9px;text-decoration:underline;cursor:pointer}
      #${ROOT_ID} .so-pvm-engine{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;border:1px solid #31536a;border-radius:7px;background:#0b1e2b}.so-pvm-engine span{font-size:10px;font-weight:800;text-transform:uppercase}.so-pvm-engine span.ready{color:#65e6b3}.so-pvm-engine span.loading{color:#ffd36d}.so-pvm-engine span.error{color:#ff7b84}.so-pvm-engine small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7897a8;font-size:8px}.so-pvm-top-actions{margin-bottom:10px}.so-pvm-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}.so-pvm-fields label{display:flex;min-width:0;flex-direction:column;gap:3px;color:#7897a8;font-size:9px}.so-pvm-fields input,.so-pvm-fields select{min-width:0;width:100%;border:1px solid #31536a;border-radius:5px;background:#0b1e2b;color:#dff;padding:6px}.so-pvm-fields input:disabled,.so-pvm-fields select:disabled{opacity:.55}.so-pvm-catalysts input{border-color:#6e5a29;background:#251f12;color:#ffe291}.so-pvm-checks{display:flex;flex-wrap:wrap;gap:12px;margin-top:7px;color:#a9c4d1;font-size:9px}.so-pvm-checks label{display:flex;align-items:center;gap:5px}.so-pvm-weakness{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;padding:6px 8px;border-left:3px solid #e69a45;background:#172534;color:#7897a8;font-size:9px}.so-pvm-weakness strong{color:#ffc978}.so-pvm-primary-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin:8px 0}.so-pvm-primary-actions button{min-height:36px;border:1px solid #3a7181;border-radius:6px;background:linear-gradient(#17465b,#103348);color:#dff;font-size:9px;font-weight:800;cursor:pointer}.so-pvm-primary-actions button:disabled,.so-inline-actions button:disabled{cursor:wait;opacity:.5}.so-pvm-progress{position:relative;height:28px;margin:9px 0;overflow:hidden;border:1px solid #31536a;border-radius:6px;background:#091823}.so-pvm-progress i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#197b83,#7bd9bd);transition:width .2s}.so-pvm-progress span{position:relative;z-index:1;display:grid;height:100%;place-items:center;color:#e8ffff;font-size:9px}.so-pvm-status{margin:8px 0;padding:6px 8px;border-radius:5px;background:#112735;color:#88b9c3;font-size:9px}.so-pvm-status.error{background:#351c22;color:#ff9ca5}.so-pvm-result{margin:7px 0;padding:8px;border:1px solid #31536a;border-radius:7px;background:#0c202e}.so-pvm-result-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.so-pvm-result-head strong{color:#dcffff;font-size:10px}.so-pvm-result-head span{color:#7897a8;font-size:8px}.so-pvm-compare{display:grid;grid-template-columns:minmax(0,1fr) 64px minmax(0,1fr);align-items:center;gap:6px}.so-pvm-compare>div{display:flex;min-width:0;flex-direction:column}.so-pvm-compare>div:last-child{text-align:right}.so-pvm-compare span{color:#7897a8;font-size:8px}.so-pvm-compare strong{color:#f1ffff;font-size:16px}.so-pvm-compare small{color:#88a9b6;font-size:8px}.so-pvm-compare>b{text-align:center;color:#65e6b3;font-size:9px}.so-pvm-compare>b.negative{color:#ff8d96}.so-pvm-warning{display:block;margin-top:6px;color:#ffbd78;font-size:8px}.so-pvm-optimizer-summary{display:flex;flex-direction:column;gap:2px;margin-top:7px;color:#83a6b4;font-size:9px}.so-pvm-optimizer-summary strong{color:#6ee0bd}.so-pvm-optimizer-summary b{color:#ffd875}
      #${ROOT_ID} .so-model-card{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin:7px 0;padding:1px;border:1px solid #31536a;border-radius:7px;overflow:hidden;background:#31536a}.so-model-card>div{display:flex;flex-direction:column;padding:7px;background:#0c202e}.so-model-card span{color:#7897a8;font-size:8px;text-transform:uppercase}.so-model-card strong{color:#dcf8ff;font-size:12px}.so-model-card strong.experimental{color:#ffad7d}.so-model-card strong.low{color:#ffd56d}.so-model-card strong.medium{color:#8dd9d3}.so-model-card strong.high{color:#70e8a9}.so-model-card small{grid-column:1/-1;padding:7px;background:#10293a;color:#88a9b7;font-size:9px;line-height:1.45}.so-research-card{margin:0}
      #${ROOT_ID} .so-build-import{display:grid;grid-template-columns:minmax(0,1fr) 62px;gap:5px;margin-top:6px}.so-build-import input{min-width:0;border:1px solid #31536a;border-radius:5px;background:#0b1e2b;color:#dff;padding:5px;font-size:9px}.so-build-import button{border:1px solid #355f72;border-radius:5px;background:#123044;color:#a9d7df;font-size:9px;cursor:pointer}
      #${ROOT_ID} .so-build-warning{margin:7px 0;padding:8px;border:1px solid #8b7131;border-radius:7px;background:#332b14;color:#e7cf84;font-size:10px}
      #${ROOT_ID} .so-timeline article{display:grid;grid-template-columns:78px minmax(0,1fr) auto;align-items:center;gap:6px;padding:8px;border:1px solid #285066;border-radius:7px;background:#102636}.so-timeline article.due{border-color:#9a7a2b;background:#332d16}.so-timeline span{color:#7897a8;font-size:9px;text-transform:uppercase}.so-timeline strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#ddf7fc}.so-timeline b{color:#68ded3;font-size:9px;text-align:right}.so-timeline .due b{color:#ffe073}.so-session-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.so-session-grid>div{display:flex;min-width:0;flex-direction:column;padding:8px;border:1px solid #274b5e;border-radius:7px;background:#102636}.so-session-grid span{color:#7897a8;font-size:8px;text-transform:uppercase}.so-session-grid strong{color:#dffffb;font-size:15px}.so-session-grid small{color:#73929f;font-size:9px}
      #${ROOT_ID} .so-confidence{display:block!important;margin-top:1px;color:#7c96a2!important;font-size:7px!important;text-transform:uppercase}.so-confidence.high{color:#5ee0c9!important}.so-confidence.medium{color:#8fcbd3!important}.so-confidence.low{color:#f0bd62!important}
      #${ROOT_ID} .so-official-card{display:flex;flex-direction:column;gap:7px;padding:11px;border:1px solid #31536a;border-radius:9px;background:linear-gradient(135deg,#112b3d,#111f31)}.so-official-card.online{border-color:#2f8b7d;box-shadow:inset 3px 0 #4ddcca}.so-official-card.syncing{border-color:#8d742d;box-shadow:inset 3px 0 #f0c84c}.so-official-card.error{border-color:#8b4149;box-shadow:inset 3px 0 #e86773}.so-official-card.warning{border-color:#8d742d;box-shadow:inset 3px 0 #e5ae47}.so-official-button{width:100%;border:1px solid #398d83;background:linear-gradient(135deg,#153d42,#14313f);color:#c3fbf4;border-radius:7px;padding:8px 10px;font-weight:800;cursor:pointer}.so-official-button:disabled,.so-official-actions button:disabled{opacity:.45;cursor:default}.so-official-actions{display:flex;flex-direction:column;align-items:flex-start;gap:6px}.so-key-safety{color:#6f8c99;font-size:9px;line-height:1.4}
      #${ROOT_ID} .so-sync-status{display:flex;flex-direction:column;gap:3px;margin-top:10px;padding:10px;border:1px solid #31536a;background:#102636;border-radius:8px}.so-sync-status span{color:#7ea0b0;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.so-sync-status strong{color:#dff;font-size:12px}.so-sync-status small{color:#7895a4}.so-sync-status.online{border-color:#2d8174;box-shadow:inset 3px 0 #4ddcca}.so-sync-status.error{border-color:#8b4149;box-shadow:inset 3px 0 #e86773}.so-sync-status.syncing{border-color:#8d742d;box-shadow:inset 3px 0 #f0c84c}.so-sync-toggle{display:grid;grid-template-columns:20px 1fr;gap:7px;align-items:start;margin-top:10px;padding:8px;background:#0d2130;border:1px solid #294a5b;border-radius:7px}.so-sync-toggle input{width:15px;height:15px;margin:2px 0 0;accent-color:#4ddfce}.so-sync-toggle span{display:flex;flex-direction:column}.so-sync-toggle strong{color:#d9f4fa;font-size:11px}.so-sync-toggle small{color:#7895a4;font-size:9px}.so-sync-field{display:flex;flex-direction:column;gap:4px;margin-top:10px;color:#85a3b2;font-size:10px}.so-sync-field input{width:100%;min-width:0;border:1px solid #31536a;background:#0b1e2b;color:#dff;border-radius:6px;padding:7px}.so-sync-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}.so-sync-actions button{border:1px solid #355f72;background:#123044;color:#a9d7df;border-radius:6px;padding:7px 5px;font-size:10px;cursor:pointer}.so-sync-actions button.primary{grid-column:1/-1;border-color:#398d83;background:#153d42;color:#c3fbf4;font-weight:800}.so-sync-actions button:disabled{opacity:.45;cursor:default}
      #${ROOT_ID} .so-sync-status.linking{border-color:#4b6792;box-shadow:inset 3px 0 #6aa8ff}.so-account-card{display:flex;flex-direction:column;gap:7px;margin-top:10px;padding:11px;border:1px solid #31536a;border-radius:9px;background:linear-gradient(135deg,#112b3d,#111f31)}.so-account-card.connected{border-color:#2f8b7d;background:linear-gradient(135deg,#113937,#13283a)}.so-account-heading{display:flex;flex-direction:column;gap:2px}.so-account-heading span{color:#7598aa;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.so-account-heading strong{color:#e0fbff;font-size:14px;overflow-wrap:anywhere}.so-account-heading small{color:#7e9ba8;font-size:9px}.so-steam-button{width:100%;border:1px solid #5b87c7;border-radius:7px;padding:9px;background:linear-gradient(135deg,#173f69,#162f4c);color:#e7f3ff;font-weight:800;cursor:pointer}.so-steam-button:hover{border-color:#85b7ff}.so-steam-button:disabled{opacity:.45;cursor:default}.so-link-secondary{align-self:flex-start;border:0;background:transparent;color:#71b7ef;font-size:10px;text-decoration:underline;cursor:pointer;padding:1px}.so-link-secondary.danger{color:#e78c96}.so-link-wait{color:#e0bd64;font-size:9px}.so-sync-advanced{margin-top:10px;border:1px solid #294858;border-radius:7px;background:#0b1d29;padding:7px 8px}.so-sync-advanced summary{color:#87a7b7;font-size:10px;cursor:pointer}.so-sync-advanced[open] summary{color:#b7d9e5}
      #${ROOT_ID} .so-about p{color:#9ab0bc}.so-legend{display:flex;align-items:center;gap:8px;margin:7px 0;color:#a9bdc7}.so-legend span{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-size:9px;font-weight:800}.so-legend .node{border:0;background:radial-gradient(circle,transparent 0%,transparent 28%,rgba(255,215,0,.7) 34%,rgba(255,215,0,.35) 48%,rgba(255,215,0,0) 100%)}.so-legend .squad{background:#2781ff;color:white}.so-legend .friend{background:#d26cff;color:white}.so-legend .event{border:2px solid #ff7078;background:#111;color:#ff9da3;box-shadow:0 0 10px #ff707888}
      #${ROOT_ID} .so-feature-index{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}.so-feature-index>div{display:grid;grid-template-columns:58px 1fr;gap:7px;padding:6px 7px;border-radius:6px;background:#102636}.so-feature-index b{color:#71e1d5;font-size:10px}.so-feature-index span{color:#8ea8b5;font-size:10px}
      #${ROOT_ID} .so-danger{border:1px solid #7d3941;background:#361b23;color:#ffb7bd;border-radius:7px;padding:7px 10px;cursor:pointer}.so-version{margin-top:12px;color:#587280;font-size:10px}
      #${ENGINE_TOAST_ID}{position:fixed;z-index:2147483647;left:50%;top:28px;transform:translateX(-50%);display:flex;align-items:center;gap:11px;max-width:min(520px,calc(100vw - 32px));padding:13px 18px;border:1px solid #f1c94c;border-radius:11px;background:linear-gradient(135deg,rgba(66,50,9,.98),rgba(12,29,34,.98));box-shadow:0 0 32px #ffc92966,0 15px 45px #000c;color:#fff3b2;font:14px/1.3 Rubik,Segoe UI,sans-serif;pointer-events:none;animation:soEngineToast 6.5s ease both}
      #${ENGINE_TOAST_ID} span{padding:3px 6px;border-radius:5px;background:#e9bd32;color:#241b02;font-size:9px;font-weight:900;letter-spacing:.08em}#${ENGINE_TOAST_ID} strong{overflow-wrap:anywhere}
      #${ENGINE_FLASH_ID}{position:fixed;z-index:2147483645;inset:0;pointer-events:none;border:10px solid #ffd23b;box-shadow:inset 0 0 90px 25px #ffd23b88;animation:soEngineFlash 1.35s ease-out both}
      @keyframes soEngineFlash{0%{opacity:0}12%{opacity:.95}35%{opacity:.12}52%{opacity:.7}100%{opacity:0}}
      @keyframes soEngineToast{0%{opacity:0;transform:translate(-50%,-14px)}8%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,-8px)}}
      @keyframes soEngineBadgePulse{0%,100%{box-shadow:0 0 12px #ffc92844,0 7px 24px #0009}50%{box-shadow:0 0 26px #ffc92899,0 7px 24px #0009}}
      #${MAP_LAYER_ID}{position:absolute;inset:0;z-index:30;pointer-events:none;overflow:hidden}
      #${MAP_LAYER_ID} .so-map-marker{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;filter:drop-shadow(0 2px 5px #000);white-space:nowrap}
      #${MAP_LAYER_ID} .so-map-marker.player{height:20px;min-width:20px;border-radius:10px;padding:0 5px;color:#fff;font-size:9px;font-weight:800;transform:translate(-50%,calc(-50% - 18px))}
      #${MAP_LAYER_ID} .so-map-marker.squad{background:#257df0;border:1px solid #87baff}.so-map-marker.friend{background:#b34ee5;border:1px solid #e7a5ff}
      #${MAP_LAYER_ID} .so-map-marker.event{width:24px;height:24px;border:2px solid currentColor;border-radius:50%;background:#111c;box-shadow:0 0 14px currentColor;color:#fff;font-size:9px;font-weight:900}.so-map-marker.event.rune{color:#d78aff}.so-map-marker.event.dungeon{color:#ff7078}.so-map-marker.event.solo{color:#66e99c}.so-map-marker.event.boss{color:#efb64f}
      @media(min-width:1101px){html.${DRAWER_OPEN_CLASS} #${ROOT_ID} .so-engine-ready-badge{right:448px}}
      @media(max-width:900px){#${ROOT_ID} .so-engine-ready-badge{top:34px;right:42px}#${ROOT_ID} .so-panel{width:min(420px,calc(100vw - 40px))}#${ROOT_ID} .so-tabs{flex-basis:60px;min-width:60px}#${ROOT_ID} .so-toggle{width:34px;height:106px}}
    `;
    document.head.appendChild(style);

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = state.open ? "" : "collapsed";
    root.innerHTML = `
      <button class="so-engine-ready-badge" data-action="dismiss-engine-ready">ENGINE READY · dismiss</button>
      <button class="so-toggle" data-action="toggle">SO Intel</button>
      <div class="so-panel">
        <nav class="so-tabs" aria-label="Overlay sections">
          <div class="so-brand"><strong>SO</strong><span>Intel</span></div>
          <button data-action="tab" data-tab="nodes">Nodes</button>
          <button data-action="tab" data-tab="roster">Roster</button>
          <button data-action="tab" data-tab="profiles">Profiles</button>
          <button data-action="tab" data-tab="builds">Builds</button>
          <button data-action="tab" data-tab="pvm">PvM</button>
          <button data-action="tab" data-tab="ops">Ops</button>
          <button data-action="tab" data-tab="xp">XP</button>
          <button data-action="tab" data-tab="ranks">Ranks</button>
          <button data-action="tab" data-tab="alerts">Alerts</button>
          <button data-action="tab" data-tab="market">Market</button>
          <button class="so-tab-bottom" data-action="tab" data-tab="sync">Sync</button>
          <button data-action="tab" data-tab="about">Rules</button>
        </nav>
        <div class="so-workspace">
          <header class="so-title">
            <div class="so-title-copy"><strong>Stellar Odyssey Intel</strong><span>Passive informational companion</span></div>
            <button class="so-drawer-close" data-action="close-drawer" title="Close drawer" aria-label="Close drawer">×</button>
          </header>
          <main class="so-content"></main>
          <footer class="so-footer"><span class="so-footer-status">Local cache</span><b>v${VERSION}</b></footer>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "toggle") {
        state.open = !state.open;
        root.classList.toggle("collapsed", !state.open);
        syncDrawerLayout();
        markDirty();
      } else if (action === "close-drawer") {
        state.open = false;
        root.classList.add("collapsed");
        syncDrawerLayout();
        markDirty();
      } else if (action === "tab") {
        state.tab = button.dataset.tab;
        state.lastPanelSignature = "";
        renderPanel();
        if (state.tab === "xp") requestDetailedHistory(state.selectedProfile || state.selfProfileKey);
        if (state.tab === "pvm") {
          if (!state.pvmLab.baseline || !state.pvmLab.build) loadCurrentPvmBuild(false);
          loadPvmEngine().catch(() => {});
        }
      } else if (action === "favorite") {
        const key = String(button.dataset.name || "").toLowerCase();
        if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
        state.sync.favoritesUpdatedAt = Date.now();
        state.sync.summaryPlayerSet = "";
        scheduleSharedSync(1000);
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (action === "profile") {
        const key = String(button.dataset.name || "").toLowerCase();
        if (state.profiles[key]) {
          state.selectedProfile = key;
          state.tab = "profiles";
          markDirty();
          state.lastPanelSignature = "";
          renderPanel();
        }
      } else if (action === "copy-coordinate") {
        const value = String(button.dataset.coordinate || "");
        (navigator.clipboard?.writeText(value) || Promise.reject()).then(() => showEngineToast(`Coordinates copied: ${value}`, true)).catch(() => showEngineToast(`Copy blocked — ${value}`, true));
      } else if (action === "add-waypoint") {
        const system = state.systems[String(button.dataset.key || "")];
        if (system && !state.waypoints.some((row) => row.x === system.x && row.y === system.y && row.z === system.z)) {
          state.waypoints.push({ name: system.name, x: system.x, y: system.y, z: system.z, addedAt: Date.now() });
          state.waypoints = state.waypoints.slice(-30);
          markDirty();
          state.lastPanelSignature = "";
          renderPanel();
        }
      } else if (action === "remove-waypoint") {
        const index = Number(button.dataset.index);
        if (Number.isInteger(index) && index >= 0) state.waypoints.splice(index, 1);
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (action === "reset-session") {
        const self = state.profiles[state.selfProfileKey];
        state.session = { startAt: Date.now(), lastActiveAt: Date.now(), baselineXp: plain(xpActivitiesFromLevels(self?.levels || {})), latestXp: plain(xpActivitiesFromLevels(self?.levels || {})), baselineResources: finite(self?.stats?.resources), latestResources: finite(self?.stats?.resources), baselineSeen: Object.keys(state.seen).length, baselinePerfect: verifiedPerfectCount() };
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (action === "pvm-load-current") {
        loadCurrentPvmBuild(true);
        loadPvmEngine().catch(() => {});
      } else if (action === "pvm-reset-test") {
        if (state.pvmLab.baseline) {
          state.pvmLab.build = plain(state.pvmLab.baseline);
          pvmInvalidateResults();
          state.pvmLab.message = "Test build reset to the current snapshot";
          markDirty();
          refreshPvmPanel();
        }
      } else if (action === "pvm-run") {
        runPvmComparison();
      } else if (action === "pvm-max-scan") {
        runPvmMaxScan();
      } else if (action === "pvm-optimize") {
        runPvmOptimizer();
      } else if (action === "pvm-apply-optimizer") {
        const optimal = state.pvmLab.optimizer?.optimalStats;
        if (state.pvmLab.build && optimal) {
          for (const stat of PVP_CORE_STATS) state.pvmLab.build[stat] = Math.max(0, finite(optimal[stat]) || 0);
          pvmInvalidateResults();
          state.pvmLab.message = "Optimized stat allocation applied to the test build";
          markDirty();
          refreshPvmPanel();
        }
      } else if (action === "save-build") {
        const profile = state.profiles[state.buildLab.left] || state.buildLab.imports[state.buildLab.left];
        if (profile) {
          state.buildLab.presets.unshift({ name: `${profile.username} ${new Date().toLocaleDateString()}`, profile: state.buildLab.left, mods: plain(state.buildLab.leftMods), savedAt: Date.now() });
          state.buildLab.presets = state.buildLab.presets.slice(0, 20);
          markDirty();
          state.lastPanelSignature = "";
          renderPanel();
        }
      } else if (action === "load-build") {
        const preset = state.buildLab.presets[Number(button.dataset.index)];
        if (preset) {
          if (state.profiles[preset.profile] || state.buildLab.imports[preset.profile]) state.buildLab.left = preset.profile;
          state.buildLab.leftMods = { ...state.buildLab.leftMods, ...(preset.mods || {}) };
          markDirty();
          state.lastPanelSignature = "";
          renderPanel();
        }
      } else if (action === "share-build") {
        const profile = state.profiles[state.buildLab.left] || state.buildLab.imports[state.buildLab.left];
        if (profile) {
          const payload = { v: 1, player: profile.username, stats: Object.fromEntries(PVP_CORE_STATS.map((stat) => [stat, combatStat(profile, stat)])), catalysts: catalystStatsForProfile(profile), gear: (profile.gear || []).map((item) => ({ slot: item.slot, name: item.name, catalysts: item.catalysts })), mods: state.buildLab.leftMods };
          const code = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
          (navigator.clipboard?.writeText(`SOI1.${code}`) || Promise.reject()).then(() => showEngineToast("Build share code copied", true)).catch(() => showEngineToast("Clipboard access was blocked", true));
        }
      } else if (action === "import-build") {
        try {
          const text = String(root.querySelector("[data-build-share-code]")?.value || "").trim();
          if (!text.startsWith("SOI1.")) throw new Error("That is not an SOI1 build code");
          if (text.length > 20000) throw new Error("That build code is too large");
          const payload = JSON.parse(decodeURIComponent(escape(atob(text.slice(5)))));
          if (payload?.v !== 1 || !payload.player || !payload.stats) throw new Error("The build code is incomplete");
          const key = `shared:${String(payload.player).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40)}:${Date.now().toString(36)}`;
          state.buildLab.imports[key] = { username: String(payload.player).slice(0, 64), stats: Object.fromEntries(PVP_CORE_STATS.map((stat) => [stat, finite(payload.stats[stat]) || 0])), catalystStats: Object.fromEntries(PVP_CATALYST_STATS.map((stat) => [stat, finite(payload.catalysts?.[stat])]).filter(([, value]) => value !== null)), gear: Array.isArray(payload.gear) ? payload.gear.slice(0, 12) : [], placeholder: false, source: "imported build code", capturedAt: Date.now() };
          state.buildLab.right = key;
          state.buildLab.rightMods = { ...state.buildLab.rightMods, ...(payload.mods || {}) };
          const importKeys = Object.keys(state.buildLab.imports);
          for (const oldKey of importKeys.slice(0, Math.max(0, importKeys.length - 20))) delete state.buildLab.imports[oldKey];
          markDirty();
          state.lastPanelSignature = "";
          renderPanel();
          showEngineToast(`Imported ${state.buildLab.imports[key].username}`, true);
        } catch (error) {
          showEngineToast(String(error?.message || "The build code could not be imported"), true);
        }
      } else if (action === "test-engine-alert") {
        triggerEngineReady(true);
      } else if (action === "official-api-save") {
        const key = String(root.querySelector("[data-official-api-key]")?.value || "").trim();
        if (key.length < 16) {
          state.officialApi.status = "error";
          state.officialApi.message = "Paste the complete API key from your Stellar Odyssey profile";
          state.lastPanelSignature = "";
          renderPanel();
          return;
        }
        saveOfficialApiKey(key);
      } else if (action === "official-api-refresh") {
        refreshOfficialApi(true);
      } else if (action === "official-api-remove") {
        if (window.confirm("Remove the official API key and its encrypted local cache from this PC? Steam linking and shared history will stay connected.")) removeOfficialApiKey();
      } else if (action === "sync-steam") {
        if (state.sync.authBusy) return;
        const endpointInput = root.querySelector('[data-sync-field="endpoint"]');
        if (endpointInput) state.sync.endpoint = String(endpointInput.value || "").trim();
        const requestId = createSyncToken();
        const authorizeUrl = steamAuthorizeUrl(requestId);
        const opened = openSteamWindow(authorizeUrl);
        beginSteamLink({ requestId, authorizeUrl, opened });
      } else if (action === "sync-steam-open") {
        const authorizeUrl = String(state.sync.linkRequest?.authorizeUrl || "");
        if (authorizeUrl) window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      } else if (action === "sync-steam-revoke") {
        revokeSteamLink();
      } else if (action === "sync-generate") {
        state.sync.token = createSyncToken();
        state.sync.authMode = "code";
        state.sync.linkRequest = null;
        state.sync.enabled = true;
        state.sync.favoritesUpdatedAt = Date.now();
        state.sync.status = "setup";
        state.sync.message = "Recovery code generated — use Steam linking for the easiest setup";
        bootstrapSyncOutbox();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (action === "sync-copy") {
        const token = state.sync.authMode === "code" ? String(state.sync.token || "") : "";
        if (token) {
          const copy = navigator.clipboard?.writeText(token);
          if (copy) copy.then(() => {
            state.sync.message = "Private sync code copied";
            state.lastPanelSignature = "";
            renderPanel();
          }).catch(() => {
            const input = root.querySelector('[data-sync-field="token"]');
            if (input) {
              input.type = "text";
              input.select();
            }
            state.sync.message = "Copy was blocked — the code is selected for manual copying";
          });
          else {
            const input = root.querySelector('[data-sync-field="token"]');
            if (input) {
              input.type = "text";
              input.select();
            }
            state.sync.message = "The code is selected for manual copying";
          }
        }
      } else if (action === "sync-save") {
        state.sync.endpoint = String(root.querySelector('[data-sync-field="endpoint"]')?.value || "").trim();
        const recoveryToken = String(root.querySelector('[data-sync-field="token"]')?.value || "").trim();
        if (recoveryToken.length < 32) {
          state.sync.status = "error";
          state.sync.message = "Enter or generate a valid recovery code first";
          state.lastPanelSignature = "";
          renderPanel();
          return;
        }
        state.sync.token = recoveryToken;
        state.sync.authMode = "code";
        state.sync.linkRequest = null;
        state.sync.enabled = Boolean(root.querySelector('[data-action="sync-enabled"]')?.checked);
        if (state.sync.enabled && !state.sync.outboxXp.length && !state.sync.outboxResources.length && !Object.keys(state.sync.outboxProfiles).length) bootstrapSyncOutbox();
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
        runSharedSync(true);
      } else if (action === "dismiss-engine-ready") {
        state.engineCooldown.dismissed = true;
        renderEngineBadge();
      } else if (action === "clear-cache") {
        state.systems = {};
        state.nodeObservations = {};
        state.seen = {};
        state.profiles = {};
        state.locations = {};
        state.xpHistory = {};
        state.resourceHistory = {};
        state.sharedSummaries = { xp: {}, resources: {} };
        state.resourceRankings = { rows: {}, totalResults: 0, capturedAt: 0, currentRank: 0, currentValue: 0 };
        state.waypoints = [];
        state.operations = {};
        state.session = { startAt: Date.now(), lastActiveAt: Date.now(), baselineXp: {}, baselineResources: null, baselineSeen: 0, baselinePerfect: 0 };
        state.marketTools = { holdings: {}, alerts: {}, notified: {} };
        state.buildLab = { left: "", right: "", leftMods: { power: 0, precision: 0, evasion: 0, hull: 0 }, rightMods: { power: 0, precision: 0, evasion: 0, hull: 0 }, presets: [], imports: {} };
        state.pvmLab = { npc: "brutes", level: 1, runs: 5000, threshold: 98, upperBound: 10000, budget: 4, baseline: null, build: null, result: null, maxResult: null, optimizer: null, loadedAt: 0, engineStatus: "idle", engineSource: "", job: "idle", progress: 0, message: "Open the NPC lab to load the official local combat engine" };
        state.favorites.clear();
        state.sync.favoritesUpdatedAt = Date.now();
        state.sync.favoritesClockVersion = FAVORITES_CLOCK_VERSION;
        state.sync.summaryPulledAt = 0;
        state.sync.summaryPlayerSet = "";
        state.sync.historyCursors = {};
        state.sync.outboxBattles = [];
        state.sync.battleSeen = {};
        state.sync.battleModel = {};
        state.sync.battleCaptured = 0;
        state.sync.lastBattleAt = 0;
        state.sync.lastBattleKind = "";
        state.selectedProfile = "";
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      }
    });

    root.addEventListener("change", (event) => {
      if (event.target.matches('[data-action="select-profile"]')) {
        state.selectedProfile = String(event.target.value || "").toLowerCase();
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
        if (state.tab === "xp") requestDetailedHistory(state.selectedProfile);
      } else if (event.target.matches('[data-action="select-xp-window"]')) {
        const nextWindow = String(event.target.value || "24h");
        state.xpWindow = XP_WINDOWS[nextWindow] ? nextWindow : "24h";
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="select-xp-rate-mode"]')) {
        state.xpRateMode = event.target.value === "wall" ? "wall" : "active";
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="node-query"]')) {
        state.nodeFinder.query = String(event.target.value || "").slice(0, 80);
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="node-stops"]')) {
        state.nodeFinder.maxStops = Math.min(8, Math.max(1, Number(event.target.value || 4)));
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="market-holding"]')) {
        const currency = String(event.target.dataset.currency || "");
        const value = Math.max(0, finite(event.target.value) || 0);
        if (value) state.marketTools.holdings[currency] = value; else delete state.marketTools.holdings[currency];
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="market-alert-target"], [data-action="market-alert-direction"]')) {
        const currency = String(event.target.dataset.currency || "");
        const card = event.target.closest(".so-market-card");
        const target = Math.max(0, finite(card?.querySelector('[data-action="market-alert-target"]')?.value) || 0);
        const direction = String(card?.querySelector('[data-action="market-alert-direction"]')?.value || "above");
        if (target) state.marketTools.alerts[currency] = { target, direction }; else delete state.marketTools.alerts[currency];
        delete state.marketTools.notified[currency];
        markDirty();
      } else if (event.target.matches('[data-action="build-player"]')) {
        const side = event.target.dataset.side === "right" ? "right" : "left";
        state.buildLab[side] = String(event.target.value || "").toLowerCase();
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="build-mod"]')) {
        const side = event.target.dataset.side === "right" ? "rightMods" : "leftMods";
        const stat = String(event.target.dataset.stat || "");
        if (PVP_BUILD_STATS.includes(stat)) state.buildLab[side][stat] = Math.min(500, Math.max(-90, finite(event.target.value) || 0));
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches("[data-pvm-setting]")) {
        const setting = String(event.target.dataset.pvmSetting || "");
        if (setting === "npc") {
          const npc = String(event.target.value || "");
          if (PVM_NPCS.some((row) => row.name === npc)) state.pvmLab.npc = npc;
        } else if (setting === "runs") {
          const runs = Number(event.target.value);
          if ([1000, 2500, 5000, 10000].includes(runs)) state.pvmLab.runs = runs;
        }
        pvmInvalidateResults();
        markDirty();
        refreshPvmPanel();
      } else if (event.target.matches("[data-pvm-field]")) {
        const field = String(event.target.dataset.pvmField || "");
        if (field.startsWith("@")) {
          const setting = field.slice(1);
          if (setting === "level") state.pvmLab.level = Math.floor(pvmClamp(event.target.value, 1, 10000000, state.pvmLab.level));
          else if (setting === "threshold") state.pvmLab.threshold = pvmClamp(event.target.value, 50, 99.9, state.pvmLab.threshold);
          else if (setting === "upperBound") state.pvmLab.upperBound = Math.floor(pvmClamp(event.target.value, 10, 10000000, state.pvmLab.upperBound));
          else if (setting === "budget") state.pvmLab.budget = Math.floor(pvmClamp(event.target.value, 4, 1e15, state.pvmLab.budget));
        } else if (state.pvmLab.build) {
          if (["weaponAnomaly", "shieldAnomaly"].includes(field)) {
            state.pvmLab.build[field] = Boolean(event.target.checked);
          } else if (["weaponType1", "weaponType2", "shieldType1", "shieldType2"].includes(field)) {
            state.pvmLab.build[field] = PVM_DAMAGE_TYPES.includes(event.target.value) ? event.target.value : "";
          } else if (field.startsWith("catalysts.")) {
            const stat = field.slice("catalysts.".length);
            if (PVP_CATALYST_STATS.includes(stat)) state.pvmLab.build.catalysts[stat] = pvmClamp(event.target.value, 0, 100000, 0);
          } else if (["cloneCritOverride", "cloneCritDamageOverride", "cloneDualShotOverride"].includes(field)) {
            state.pvmLab.build[field] = String(event.target.value).trim() === "" ? null : pvmClamp(event.target.value, 0, 100000, 0);
          } else if (field === "cloneCount") {
            state.pvmLab.build.cloneCount = Math.floor(pvmClamp(event.target.value, 1, 100, 1));
          } else if (["power", "precision", "evasion", "hull", "weaponValue", "shieldValue", "weaponBoost", "hullBoost", "precisionBoost", "evasionBoost", "ssBoost"].includes(field)) {
            state.pvmLab.build[field] = pvmClamp(event.target.value, 0, 1e15, 0);
          }
        }
        pvmInvalidateResults();
        markDirty();
        refreshPvmPanel();
      } else if (event.target.matches('[data-action="engine-setting"]')) {
        const key = String(event.target.dataset.setting || "");
        if (["sound", "toast", "flash", "badge", "desktop", "events", "operations"].includes(key)) {
          state.engineAlerts[key] = Boolean(event.target.checked);
          markDirty();
          renderEngineBadge();
          if (key === "desktop" && state.engineAlerts.desktop) requestDesktopNotifications();
          else {
            state.lastPanelSignature = "";
            renderPanel();
          }
        }
      } else if (event.target.matches('[data-action="engine-volume"]')) {
        state.engineAlerts.volume = Math.min(1, Math.max(0, Number(event.target.value || 0) / 100));
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="sync-enabled"]')) {
        state.sync.enabled = Boolean(event.target.checked);
        state.sync.status = state.sync.enabled ? "setup" : "idle";
        state.sync.message = state.sync.enabled
          ? state.sync.authMode === "steam" ? "Steam-linked sync is enabled" : "Connect with Steam or use a recovery code"
          : "Shared sync is off";
        if (state.sync.enabled) bootstrapSyncOutbox();
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
        if (state.sync.enabled) captureBattleObservations();
      } else if (event.target.matches('[data-action="battle-sharing"]')) {
        state.sync.battleSharing = Boolean(event.target.checked);
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
        if (state.sync.battleSharing) captureBattleObservations();
      }
    });

    return root;
  };

  const renderPanel = () => {
    const root = ensureUi();
    syncDrawerLayout();
    const signature = JSON.stringify({
      tab: state.tab,
      open: state.open,
      systems: Object.keys(state.systems).length,
      nodeObservations: Object.keys(state.nodeObservations).length,
      seen: Object.keys(state.seen).length,
      profiles: Object.values(state.profiles).map((profile) => [profile.username, profile.capturedAt]),
      xp: Object.entries(state.xpHistory).map(([key, history]) => [key, history.length, history.at(-1)?.at]),
      xpWindow: state.xpWindow,
      xpRateMode: state.xpRateMode,
      resourceRankings: [
        Object.keys(state.resourceRankings.rows).length,
        state.resourceRankings.capturedAt,
        state.resourceRankings.currentRank,
      ],
      resourceHistory: Object.entries(state.resourceHistory).map(([key, history]) => [key, history.length, history.at(-1)?.at]),
      sharedSummaries: [
        Object.values(state.sharedSummaries.xp).map((row) => [row.key, row.updatedAt]),
        Object.values(state.sharedSummaries.resources).map((row) => [row.key, row.updatedAt]),
      ],
      favorites: [...state.favorites].sort(),
      squad: state.squadMembers.map((member) => member.username),
      locations: Object.values(state.locations).map((location) => [location.username, location.seenAt]),
      galaxyTools: [state.nodeFinder, state.waypoints, state.officialApi.dungeons, state.officialApi.soloDungeons, state.officialApi.activeRunes, state.officialApi.passiveEvents],
      operations: [state.operations, state.session],
      marketTools: state.marketTools,
      buildLab: state.buildLab,
      pvmLab: state.tab === "pvm" ? state.pvmLab : [state.pvmLab.loadedAt, state.pvmLab.engineStatus],
      selected: state.selectedProfile,
      engineAlerts: state.engineAlerts,
      sync: [
        state.sync.enabled,
        state.sync.endpoint,
        state.sync.authMode,
        state.sync.linkRequest?.requestId,
        state.sync.authBusy,
        state.sync.status,
        state.sync.message,
        state.sync.lastPullAt,
        state.sync.summaryPulledAt,
        JSON.stringify(state.sync.historyCursors),
        state.sync.nextAttemptAt,
        state.sync.failureCount,
        state.sync.outboxXp.length,
        state.sync.outboxResources.length,
        Object.keys(state.sync.outboxProfiles).length,
        state.sync.outboxSystems.length,
        state.sync.battleSharing,
        state.sync.outboxBattles.length,
        state.sync.battleCaptured,
        state.sync.lastBattleAt,
        JSON.stringify(state.sync.battleModel),
        state.sync.systemsPulledAt,
      ],
      officialApi: [
        state.officialApi.available,
        state.officialApi.configured,
        state.officialApi.status,
        state.officialApi.message,
        state.officialApi.busy,
        state.officialApi.lastRefreshAt,
        state.officialApi.jumps,
        state.officialApi.journalSystems,
        state.officialApi.market.length,
        state.officialApi.stations.length,
        state.officialApi.dungeons.length,
        state.officialApi.soloDungeons.length,
        state.officialApi.activeRunes.length,
        JSON.stringify(state.officialApi.caches),
      ],
      engineCooldown: state.tab === "alerts"
        ? [state.engineCooldown.phase, Math.ceil(Math.max(0, state.engineCooldown.readyAt - Date.now()) / 1000)]
        : null,
      countdown: ["nodes", "ops"].includes(state.tab) ? Math.floor(Date.now() / 1000) : null,
    });
    if (signature === state.lastPanelSignature) return;
    state.lastPanelSignature = signature;
    root.classList.toggle("collapsed", !state.open);
    root.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.tab));
    const [title, subtitle] = TAB_META[state.tab] || TAB_META.about;
    const titleCopy = root.querySelector(".so-title-copy");
    if (titleCopy) titleCopy.innerHTML = `<strong>${esc(title)}</strong><span>${esc(subtitle)}</span>`;
    const footerStatus = root.querySelector(".so-footer-status");
    if (footerStatus) footerStatus.textContent = state.sync.enabled
      ? state.sync.status === "online" ? "Shared sync online" : state.sync.status === "syncing" ? "Shared sync updating" : "Shared sync enabled"
      : state.officialApi.configured ? "Official API connected" : "Local cache only";
    root.querySelector(".so-content").innerHTML = panelContent();
    renderEngineBadge();
  };

  const rosterKeys = () => {
    const squad = new Set(state.squadMembers.map((member) => member.username.toLowerCase()));
    return { squad, friends: state.favorites };
  };

  const nativeNodeGlows = new Set();
  let nativeGlowContext = null;
  let nativeGlowLastGroup = null;
  let nativeGlowLastScale = null;
  let nativeGlowLastZ = null;

  const clearNativeNodeGlows = () => {
    const layers = new Set();
    for (const glow of nativeNodeGlows) {
      const layer = glow.getLayer?.();
      if (layer) layers.add(layer);
      glow.destroy?.();
    }
    nativeNodeGlows.clear();
    nativeGlowLastGroup = null;
    nativeGlowLastScale = null;
    nativeGlowLastZ = null;
    layers.forEach((layer) => layer.batchDraw?.());
  };

  const renderNativeNodeGlows = ({ groupNode, currentZ, stepX, stepY, scale, compact, loadedSystems }) => {
    const Circle = window.Konva?.Circle;
    if (!Circle) return;
    const loadedCoordinates = new Set();
    const loadedValues = Array.isArray(loadedSystems)
      ? loadedSystems
      : loadedSystems && typeof loadedSystems === "object"
        ? Object.values(loadedSystems)
        : [];
    for (const system of loadedValues) {
      const x = finite(system?.coordinate_x);
      const y = finite(system?.coordinate_y);
      if (x !== null && y !== null) loadedCoordinates.add(`${x},${y}`);
    }
    const desired = new Map();
    for (const [key, system] of Object.entries(state.systems)) {
      if (!(Number(state.nodeObservations[key] || system?.verifiedAt || 0) > 0)) continue;
      if (!Array.isArray(system?.nodes) || !system.nodes.some((node) => Number(node?.quality) === 100)) continue;
      if (Number(system.z) !== Number(currentZ)) continue;
      if (!loadedCoordinates.has(`${system.x},${system.y}`)) continue;
      desired.set(`${system.z}:${system.x},${system.y}`, system);
    }

    const existing = new Map();
    let changed = false;
    for (const glow of [...nativeNodeGlows]) {
      if (glow.getParent?.() !== groupNode || !desired.has(glow.getAttr?.("soIntelKey"))) {
        glow.destroy?.();
        nativeNodeGlows.delete(glow);
        changed = true;
      } else {
        existing.set(glow.getAttr("soIntelKey"), glow);
      }
    }

    const radius = ((compact ? 30 : 46) / Math.max(scale, 0.001)) * 1.6;
    for (const [key, system] of desired) {
      let glow = existing.get(key);
      if (!glow) {
        glow = new Circle({
          name: "so-intel-perfect-node-glow",
          soIntelKey: key,
          x: system.x * stepX,
          y: -system.y * stepY,
          radius,
          fillRadialGradientStartPoint: { x: 0, y: 0 },
          fillRadialGradientStartRadius: 0,
          fillRadialGradientEndPoint: { x: 0, y: 0 },
          fillRadialGradientEndRadius: radius,
          fillRadialGradientColorStops: [0, "rgba(255,215,0,0.75)", 0.45, "rgba(255,215,0,0.35)", 1, "rgba(255,215,0,0)"],
          listening: false,
        });
        groupNode.add(glow);
        glow.moveToBottom();
        nativeNodeGlows.add(glow);
        changed = true;
      } else if (glow.x() !== system.x * stepX || glow.y() !== -system.y * stepY || Math.abs(glow.radius() - radius) > 0.001) {
        glow.setAttrs({ x: system.x * stepX, y: -system.y * stepY, radius, fillRadialGradientEndRadius: radius });
        changed = true;
      }
    }
    if (changed) groupNode.getLayer?.()?.batchDraw?.();
  };

  const syncNativeNodeGlows = () => {
    const context = nativeGlowContext;
    const map = context?.map;
    const groupNode = context?.groupNode;
    if (!map || !groupNode || groupNode.isDestroyed?.()) return;
    const q = getApp()?.config?.globalProperties?.$q;
    const compact = Boolean(q?.screen?.lt?.md);
    const scale = finite(groupNode.scaleX?.()) ?? finite(groupNode.scale?.()?.x) ?? 1;
    const currentZ = finite(map.props?.currentZ) ?? 1;
    renderNativeNodeGlows({
      groupNode,
      currentZ,
      stepX: compact ? 32 : 50,
      stepY: compact ? 19 : 30,
      scale,
      compact,
      loadedSystems: map.props?.systems,
    });
    nativeGlowLastGroup = groupNode;
    nativeGlowLastScale = scale;
    nativeGlowLastZ = currentZ;
  };

  const nativeGlowsNeedSync = () => {
    const map = nativeGlowContext?.map;
    const groupNode = nativeGlowContext?.groupNode;
    if (!map || !groupNode || groupNode.isDestroyed?.()) return false;
    const scale = finite(groupNode.scaleX?.()) ?? finite(groupNode.scale?.()?.x) ?? 1;
    const currentZ = finite(map.props?.currentZ) ?? 1;
    if (groupNode !== nativeGlowLastGroup || currentZ !== nativeGlowLastZ || Math.abs(scale - (nativeGlowLastScale ?? scale)) > 0.001) return true;
    for (const glow of nativeNodeGlows) {
      if (glow.getParent?.() !== groupNode) return true;
    }
    return false;
  };

  const renderMapMarkers = () => {
    const map = findComponent("GalaxyMapCanvas");
    const content = document.querySelector(".konvajs-content");
    if (!map || !content) {
      nativeGlowContext = null;
      clearNativeNodeGlows();
      document.getElementById(MAP_LAYER_ID)?.remove();
      return;
    }
    const mapLayer = findChildComponent(map, "Layer");
    const group = findChildComponent(map, "Group");
    const mapLayerNode = mapLayer?.exposed?.getNode?.();
    const groupNode = group?.exposed?.getNode?.();
    if (!mapLayerNode || !groupNode) return;
    nativeGlowContext = { map, groupNode };
    let layer = content.querySelector(`#${MAP_LAYER_ID}`);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = MAP_LAYER_ID;
      content.appendChild(layer);
    }
    const q = getApp()?.config?.globalProperties?.$q;
    const stepX = q?.screen?.lt?.md ? 32 : 50;
    const stepY = q?.screen?.lt?.md ? 19 : 30;
    const scale = finite(groupNode.scaleX?.()) ?? finite(groupNode.scale?.()?.x) ?? 1;
    const offsetX = finite(mapLayerNode.x?.()) ?? 0;
    const offsetY = finite(mapLayerNode.y?.()) ?? 0;
    const width = content.clientWidth;
    const height = content.clientHeight;
    const currentZ = finite(map.props?.currentZ) ?? 1;
    const toScreen = (x, y) => ({ x: offsetX + x * stepX * scale, y: offsetY - y * stepY * scale });
    const visible = (point) => point.x >= -30 && point.x <= width + 30 && point.y >= -30 && point.y <= height + 30;
    syncNativeNodeGlows();
    const markers = [];

    for (const event of allGalaxyEvents()) {
      if (finite(event.x) === null || finite(event.y) === null) continue;
      if (Number(event.z) !== Number(currentZ)) continue;
      const point = toScreen(event.x, event.y);
      if (!visible(point)) continue;
      markers.push({
        type: `event ${event.kind}`,
        label: event.kind === "rune" ? "R" : event.kind === "solo" ? "S" : event.kind === "boss" ? "B" : "D",
        title: `${cleanLabel(event.kind)}: ${event.name} • ${event.systemName} [${event.x},${event.y},${event.z}] • ${countdownLabel(event.endsAt)}`,
        ...point,
      });
    }

    const { squad, friends } = rosterKeys();
    for (const [key, location] of Object.entries(state.locations)) {
      if (Date.now() - location.seenAt > LOCATION_TTL_MS || Number(location.z) !== Number(currentZ)) continue;
      const isSquad = squad.has(key);
      const isFriend = friends.has(key);
      if (!isSquad && !isFriend) continue;
      const point = toScreen(location.x, location.y);
      if (visible(point)) markers.push({
        type: `player ${isSquad ? "squad" : "friend"}`,
        label: location.username,
        title: `${isSquad ? "Squad" : "Friend"}: ${location.username} [${location.x},${location.y},${location.z}] • ${ageLabel(location.seenAt)}`,
        ...point,
      });
    }

    layer.replaceChildren(...markers.map((marker) => {
      const element = document.createElement("div");
      element.className = `so-map-marker ${marker.type}`;
      element.style.left = `${marker.x}px`;
      element.style.top = `${marker.y}px`;
      element.textContent = marker.label;
      element.title = marker.title;
      return element;
    }));
  };

  const onKeyDown = (event) => {
    if (event.altKey && event.key.toLowerCase() === "i") {
      state.open = !state.open;
      markDirty();
      state.lastPanelSignature = "";
      renderPanel();
    } else if (event.key === "Escape" && state.open) {
      state.open = false;
      markDirty();
      state.lastPanelSignature = "";
      renderPanel();
    }
  };

  const onDocumentPointerDown = (event) => {
    const root = document.getElementById(ROOT_ID);
    if (!event.target.closest?.(".so-intel-boost-cluster")) closeHeaderBoostPopover();
    if (event.target.closest?.(".so-intel-boost-cluster")) return;
    if (!state.open || !root || root.contains(event.target)) return;
    state.open = false;
    markDirty();
    state.lastPanelSignature = "";
    renderPanel();
  };

  installNetworkObservers();
  ensureUi();
  ingestLiveClientState();
  captureBattleObservations();
  seedResourceHistoryFromCache();
  if (state.sync.enabled && !state.sync.outboxXp.length && !state.sync.outboxResources.length && !Object.keys(state.sync.outboxProfiles).length && !state.sync.outboxSystems.length) bootstrapSyncOutbox(false);
  updateEngineCooldown();
  checkOperationAlerts();
  renderPanel();
  renderHeaderBoosts();
  renderMapMarkers();
  window.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);

  const liveTimer = setInterval(() => {
    ingestLiveClientState();
    captureBattleObservations();
    updateEngineCooldown();
    checkOperationAlerts();
    renderPanel();
    renderHeaderBoosts();
    renderMapMarkers();
  }, 500);
  const saveTimer = setInterval(persist, 2000);
  const syncTimer = setInterval(() => runSharedSync(false), 60 * 1000);
  const firstSyncTimer = setTimeout(() => runSharedSync(false), 1800);
  const officialTimer = setInterval(() => refreshOfficialApi(false), 15 * 60 * 1000);
  const firstOfficialTimer = setTimeout(() => refreshOfficialApi(false), 2500);
  const steamLinkTimer = setInterval(pollSteamLink, 2500);
  const firstSteamLinkPoll = setTimeout(pollSteamLink, 900);
  let glowAnimationFrame = 0;
  const keepNativeGlowsAttached = () => {
    if (nativeGlowsNeedSync()) syncNativeNodeGlows();
    glowAnimationFrame = requestAnimationFrame(keepNativeGlowsAttached);
  };
  glowAnimationFrame = requestAnimationFrame(keepNativeGlowsAttached);

  window.__stellarOdysseyIntelOverlay = {
    version: VERSION,
    show() {
      state.open = true;
      state.lastPanelSignature = "";
      renderPanel();
    },
    hide() {
      state.open = false;
      state.lastPanelSignature = "";
      renderPanel();
    },
    testEngineAlert() {
      triggerEngineReady(true);
    },
    engineStatus() {
      return plain({ ...state.engineCooldown, settings: state.engineAlerts });
    },
    syncNow() {
      return runSharedSync(true);
    },
    destroy() {
      clearInterval(liveTimer);
      clearInterval(saveTimer);
      clearInterval(syncTimer);
      clearInterval(officialTimer);
      clearInterval(steamLinkTimer);
      clearTimeout(firstSyncTimer);
      clearTimeout(firstOfficialTimer);
      clearTimeout(firstSteamLinkPoll);
      clearTimeout(syncDrainTimer);
      clearTimeout(syncWakeTimer);
      cancelAnimationFrame(glowAnimationFrame);
      clearTimeout(engineTestBadgeTimer);
      clearTimeout(drawerResizeTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      uninstallNetworkObservers();
      nativeGlowContext = null;
      clearNativeNodeGlows();
      document.getElementById(ROOT_ID)?.remove();
      document.getElementById(`${ROOT_ID}-style`)?.remove();
      document.getElementById(MAP_LAYER_ID)?.remove();
      document.getElementById(ENGINE_TOAST_ID)?.remove();
      document.getElementById(ENGINE_FLASH_ID)?.remove();
      document.querySelector("#q-app .so-intel-boost-cluster")?.remove();
      document.querySelectorAll("#q-app .so-intel-native-boosts").forEach((element) => element.classList.remove("so-intel-native-boosts"));
      document.documentElement.classList.remove(DRAWER_OPEN_CLASS, DRAWER_LAYOUT_CLASS);
      engineAudioContext?.close?.().catch?.(() => {});
      delete window.__stellarOdysseyIntelOverlay;
    },
  };

  return { ok: true, version: VERSION, reused: false };
})()
