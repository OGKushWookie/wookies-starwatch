(() => {
  "use strict";

  const VERSION = "1.0.0";
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
  const XP_ACTIVITIES = ["battling", "gathering", "crafting", "exploring"];
  const XP_WINDOWS = { "1h": 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, all: Infinity };
  const SYNC_INTERVAL_MS = 60 * 1000;
  const SYNC_HISTORY_DAYS = 30;
  const SYNC_OUTBOX_LIMIT = 1200;
  const DEFAULT_SYNC_ENDPOINT = "https://stellar-odyssey-intel-sync.sthess28.workers.dev";

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

  const saved = safeParse(localStorage.getItem(STORE_KEY), {}) || {};
  const hasSavedDrawerPreference = saved.drawerLayoutVersion === 1;
  const state = {
    tab: "nodes",
    open: hasSavedDrawerPreference ? saved.open === true : false,
    systems: saved.systems || {},
    seen: saved.seen || {},
    profiles: saved.profiles || {},
    favorites: new Set(saved.favorites || []),
    locations: saved.locations || {},
    xpHistory: saved.xpHistory || {},
    resourceHistory: saved.resourceHistory || {},
    resourceRankings: {
      rows: saved.resourceRankings?.rows || {},
      totalResults: Number.isFinite(Number(saved.resourceRankings?.totalResults)) ? Number(saved.resourceRankings.totalResults) : 0,
      capturedAt: Number.isFinite(Number(saved.resourceRankings?.capturedAt)) ? Number(saved.resourceRankings.capturedAt) : 0,
      currentRank: Number.isFinite(Number(saved.resourceRankings?.currentRank)) ? Number(saved.resourceRankings.currentRank) : 0,
      currentValue: Number.isFinite(Number(saved.resourceRankings?.currentValue)) ? Number(saved.resourceRankings.currentValue) : 0,
    },
    xpWindow: XP_WINDOWS[saved.xpWindow] ? saved.xpWindow : "24h",
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
    },
    sync: {
      enabled: saved.sync?.enabled === true,
      endpoint: String(saved.sync?.endpoint || DEFAULT_SYNC_ENDPOINT),
      token: String(saved.sync?.token || ""),
      authMode: saved.sync?.authMode === "steam" ? "steam" : "code",
      linkRequest: saved.sync?.linkRequest && typeof saved.sync.linkRequest === "object" ? saved.sync.linkRequest : null,
      favoritesUpdatedAt: Number(saved.sync?.favoritesUpdatedAt || 0),
      lastPushAt: Number(saved.sync?.lastPushAt || 0),
      lastPullAt: Number(saved.sync?.lastPullAt || 0),
      outboxXp: Array.isArray(saved.sync?.outboxXp) ? saved.sync.outboxXp.slice(-SYNC_OUTBOX_LIMIT) : [],
      outboxResources: Array.isArray(saved.sync?.outboxResources) ? saved.sync.outboxResources.slice(-SYNC_OUTBOX_LIMIT) : [],
      outboxProfiles: saved.sync?.outboxProfiles && typeof saved.sync.outboxProfiles === "object" ? saved.sync.outboxProfiles : {},
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

  let drawerResizeTimer = 0;
  const syncDrawerLayout = () => {
    const html = document.documentElement;
    const changed = html.classList.contains(DRAWER_OPEN_CLASS) !== state.open;
    html.classList.add(DRAWER_LAYOUT_CLASS);
    html.classList.toggle(DRAWER_OPEN_CLASS, state.open);
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
        seen: state.seen,
        profiles: state.profiles,
        favorites: [...state.favorites],
        locations: state.locations,
        xpHistory: state.xpHistory,
        resourceHistory: state.resourceHistory,
        resourceRankings: state.resourceRankings,
        xpWindow: state.xpWindow,
        selectedProfile: state.selectedProfile,
        engineAlerts: state.engineAlerts,
        sync: {
          enabled: state.sync.enabled,
          endpoint: state.sync.endpoint,
          token: state.sync.token,
          authMode: state.sync.authMode,
          linkRequest: state.sync.linkRequest,
          favoritesUpdatedAt: state.sync.favoritesUpdatedAt,
          lastPushAt: state.sync.lastPushAt,
          lastPullAt: state.sync.lastPullAt,
          outboxXp: state.sync.outboxXp.slice(-SYNC_OUTBOX_LIMIT),
          outboxResources: state.sync.outboxResources.slice(-SYNC_OUTBOX_LIMIT),
          outboxProfiles: state.sync.outboxProfiles,
        },
      }));
      state.dirty = false;
    } catch (error) {
      console.warn("[SO Intel] Could not persist local cache", error);
    }
  };

  const getApp = () => document.querySelector("#q-app")?.__vue_app__;
  const getPinia = () => getApp()?.config?.globalProperties?.$pinia;

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

  const prepareSteamWindow = () => {
    try {
      const popup = window.open("about:blank", "_blank");
      if (popup) {
        popup.document.title = "Connecting Stellar Odyssey Intel";
        popup.document.body.style.cssText = "margin:0;min-height:100vh;display:grid;place-items:center;background:#07131d;color:#daf7ff;font:16px system-ui";
        popup.document.body.textContent = "Preparing secure Steam sign-in…";
      }
      return popup;
    } catch {
      return null;
    }
  };

  const beginSteamLink = async (popup = null) => {
    if (state.sync.authBusy) return;
    const owner = syncOwner();
    if (!owner) {
      popup?.close?.();
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
        legacyToken: state.sync.authMode === "code" ? state.sync.token : "",
        previousDeviceToken: state.sync.authMode === "steam" ? state.sync.token : "",
      });
      state.sync.linkRequest = {
        requestId: String(result.requestId || ""),
        deviceToken,
        authorizeUrl: String(result.authorizeUrl || ""),
        expiresAt: Number(result.expiresAt || 0),
      };
      state.sync.message = "Finish the Steam confirmation in the browser window";
      markDirty();
      persist();
      let opened = false;
      if (popup && !popup.closed) {
        try {
          popup.location.replace(state.sync.linkRequest.authorizeUrl);
          popup.opener = null;
          opened = true;
        } catch {
          popup.close?.();
        }
      }
      if (!opened) state.sync.message = "Steam sign-in is ready — select Open the Steam sign-in again";
    } catch (error) {
      popup?.close?.();
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
    state.sync.outboxXp.push({ username: syncUsername(username), ...plain(sample) });
    state.sync.outboxXp = state.sync.outboxXp.slice(-SYNC_OUTBOX_LIMIT);
  };

  const queueSyncResource = (username, sample) => {
    if (!state.sync.enabled || !sample) return;
    state.sync.outboxResources.push({ username: syncUsername(username), ...plain(sample) });
    state.sync.outboxResources = state.sync.outboxResources.slice(-SYNC_OUTBOX_LIMIT);
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
    if (!key || total === null) return false;
    const history = Array.isArray(state.resourceHistory[key]) ? state.resourceHistory[key] : [];
    const sample = { at, value: total, source: source === "live client stores" ? "live" : "public" };
    const last = history.at(-1);
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
    const tracked = new Set([
      ...state.squadMembers.map((member) => String(member.username || "").toLowerCase()),
      ...state.favorites,
      state.selfProfileKey,
    ].filter(Boolean));
    for (const [key, profile] of Object.entries(state.profiles)) {
      const value = finite(profile?.stats?.resources);
      if (value !== null) recordResourceSnapshot(profile.username || key, value, profile.source || "cached profile", profile.capturedAt);
    }
    for (const [key, row] of Object.entries(state.resourceRankings.rows || {})) {
      if (!tracked.has(key)) continue;
      recordResourceSnapshot(row.username || key, row.value, row.source || "cached ranking", row.capturedAt);
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
      recordResourceSnapshot(normalized.username, resourceValue, "public profile", normalized.capturedAt);
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
      recordResourceSnapshot(username, selfResources, "live client stores", observedAt);
    }
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
        changed = true;
      }
      const perfect = system.bodies.filter((body) => Number(body?.nodeQuality) === 100).map((body) => ({
        id: String(body._id || ""),
        type: String(body.nodeType || body.type || "resource"),
        body: String(body.type || "Planet"),
        quality: 100,
      }));
      if (perfect.length) {
        state.systems[key] = {
          id: String(system._id || ""),
          name: String(system.name || "Unknown system"),
          x,
          y,
          z,
          nodes: perfect,
          seenAt: Date.now(),
        };
        changed = true;
      }
    }
    if (Object.keys(state.seen).length > 25000) {
      const newest = Object.entries(state.seen).sort((a, b) => b[1] - a[1]).slice(0, 20000);
      state.seen = Object.fromEntries(newest);
      changed = true;
    }
    if (changed) markDirty();
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
      const tracked = key === state.selfProfileKey
        || state.favorites.has(key)
        || state.squadMembers.some((member) => String(member.username || "").toLowerCase() === key);
      if (tracked) recordResourceSnapshot(username, value, "public leaderboard", now);
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

  const bootstrapSyncOutbox = () => {
    for (const [key, history] of Object.entries(state.xpHistory)) {
      const username = state.profiles[key]?.username || key;
      for (const sample of Array.isArray(history) ? history : []) queueSyncXp(username, sample);
    }
    for (const [key, history] of Object.entries(state.resourceHistory)) {
      const username = state.profiles[key]?.username || state.resourceRankings.rows[key]?.username || key;
      for (const sample of Array.isArray(history) ? history : []) queueSyncResource(username, sample);
    }
    Object.values(state.profiles).forEach(queueSyncProfile);
    markDirty();
  };

  const syncPlayerKeys = () => {
    const keys = new Set([state.selfProfileKey]);
    state.squadMembers.forEach((member) => keys.add(String(member.username || "").toLowerCase()));
    state.favorites.forEach((key) => keys.add(key));
    return [...keys].filter(Boolean).slice(0, 100);
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
      if (!key || value === null || at === null) continue;
      ensureProfileShell(username, "shared companion database");
      const local = Array.isArray(state.resourceHistory[key]) ? state.resourceHistory[key] : [];
      const unique = new Map([...local, { at, value, source: "shared" }].map((sample) => [`${sample.at}:${sample.value}`, sample]));
      state.resourceHistory[key] = pruneXpHistory([...unique.values()]);
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

  const applySharedSync = (payload) => {
    const serverFavoriteTime = Number(payload?.favoritesUpdatedAt || 0);
    if (serverFavoriteTime > state.sync.favoritesUpdatedAt && Array.isArray(payload?.favorites)) {
      state.favorites = new Set(payload.favorites.map((value) => String(value || "").toLowerCase()).filter(Boolean));
      if (state.selfProfileKey) state.favorites.delete(state.selfProfileKey);
      state.sync.favoritesUpdatedAt = serverFavoriteTime;
    }
    mergeSharedProfiles(payload?.profiles);
    mergeSharedXp(payload?.xp);
    mergeSharedResources(payload?.resources);
    state.sync.lastPullAt = Date.now();
    state.lastPanelSignature = "";
    markDirty();
  };

  const runSharedSync = async (force = false) => {
    if (!state.sync.enabled || state.sync.busy) return;
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
    if (!force && Date.now() - state.sync.lastPushAt < SYNC_INTERVAL_MS - 1000) return;

    const xpBatch = state.sync.outboxXp.slice(0, 250);
    const resourceBatch = state.sync.outboxResources.slice(0, 250);
    const profileBatch = Object.values(state.sync.outboxProfiles).slice(0, 40);
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
          players: syncPlayerKeys(),
          xp: xpBatch,
          resources: resourceBatch,
          profiles: profileBatch,
          historyDays: SYNC_HISTORY_DAYS,
        }),
        signal: controller.signal,
      });
      const result = safeParse(await response.text(), null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || `HTTP ${response.status}`);
      state.sync.outboxXp.splice(0, xpBatch.length);
      state.sync.outboxResources.splice(0, resourceBatch.length);
      for (const profile of profileBatch) {
        const key = String(profile?.username || "").toLowerCase();
        if (Number(state.sync.outboxProfiles[key]?.capturedAt) === Number(profile?.capturedAt)) delete state.sync.outboxProfiles[key];
      }
      state.sync.lastPushAt = Date.now();
      applySharedSync(result);
      state.sync.status = "online";
      state.sync.message = `Connected • ${Number(result.accepted || 0)} queued items processed`;
    } catch (error) {
      state.sync.status = "error";
      state.sync.message = error?.name === "AbortError" ? "Sync timed out" : `Sync failed: ${String(error?.message || error).slice(0, 120)}`;
    } finally {
      clearTimeout(timeout);
      state.sync.busy = false;
      state.lastPanelSignature = "";
      markDirty();
      renderPanel();
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

  const nodeRows = () => {
    const pinia = getPinia();
    const current = pinia?._s?.get("ExploreStore")?.currentSystem;
    const currentX = finite(current?.coordinate_x);
    const currentY = finite(current?.coordinate_y);
    return Object.values(state.systems).sort((a, b) => {
      if (currentX === null || currentY === null) return b.seenAt - a.seenAt;
      const da = Math.hypot(a.x - currentX, a.y - currentY);
      const db = Math.hypot(b.x - currentX, b.y - currentY);
      return da - db;
    });
  };

  const renderNodes = () => {
    const rows = nodeRows();
    const seenCount = Object.keys(state.seen).length;
    return `
      <div class="so-metrics">
        <div><strong>${seenCount}</strong><span>systems seen</span></div>
        <div><strong>${rows.length}</strong><span>perfect systems</span></div>
      </div>
      <p class="so-note">Passive scanner: only systems loaded by the game are indexed. Pan the native map normally to expand the index.</p>
      <div class="so-list">
        ${rows.length ? rows.slice(0, 150).map((system) => `
          <article class="so-row">
            <div class="so-row-main">
              <strong>${esc(system.name)}</strong>
              <span>[${system.x}, ${system.y}, ${system.z}]</span>
            </div>
            <div class="so-chips">${system.nodes.map((node) => `<span title="${esc(node.body)}">${esc(node.type)} 100%</span>`).join("")}</div>
          </article>
        `).join("") : `<div class="so-empty">No 100% resource nodes have appeared in loaded map data yet.</div>`}
      </div>`;
  };

  const renderRoster = () => {
    const squadNames = new Set(state.squadMembers.map((member) => member.username.toLowerCase()));
    const names = new Map();
    state.squadMembers.forEach((member) => names.set(member.username.toLowerCase(), member.username));
    state.favorites.forEach((key) => names.set(key, state.profiles[key]?.username || state.locations[key]?.username || key));
    const rows = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return `
      <p class="so-note">Squad members come from the loaded squad roster. “Friends” are favorites you mark after viewing a profile; optional Sync makes them follow your private code across PCs.</p>
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
              <span>${squadNames.has(key) ? "Squad" : "Friend"}${hasProfileData ? " • profile data loaded" : " • basic profile"}</span>
            </button>
            <span class="so-location ${fresh ? "fresh" : ""}">${fresh ? `[${location.x},${location.y},${location.z}] ${ageLabel(location.seenAt)}` : "location unavailable"}</span>
          </article>`;
        }).join("") : `<div class="so-empty">No squad roster or local favorites are available yet.</div>`}
      </div>`;
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
    return {
      latest,
      baseline,
      elapsed,
      delta,
      rate: delta && elapsed >= XP_MIN_RATE_WINDOW_MS ? delta.gained / (elapsed / 3600000) : null,
      sampleCount: samples.length,
    };
  };

  const xpLeaderboard = (keys, activity, windowName) => {
    const rows = keys.map((key) => ({
      key,
      username: state.profiles[key]?.username || key,
      trend: xpTrend(state.xpHistory[key] || [], activity, windowName),
    }));
    const ranked = rows
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
    return { ranked, calibrating: rows.filter((row) => row.trend.rate === null) };
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
          ${board.ranked.length ? board.ranked.map((row) => `
            <div class="so-xp-leaderboard-row ${row.key === state.selfProfileKey ? "self" : ""}">
              <b>${row.tied ? "T" : ""}#${row.rank}</b>
              <span>${esc(row.username)}${row.key === state.selfProfileKey ? " (You)" : ""}</span>
              <strong>${row.trend.delta?.estimated ? "≈" : ""}${esc(xpRateNumber(row.trend.rate))}<small> XP/h</small></strong>
            </div>`).join("") : `<div class="so-empty">No players have completed calibration for ${esc(activity)}.</div>`}
        </div>
        <div class="so-xp-leaderboard-foot">${board.ranked.length} ranked • ${board.calibrating.length} calibrating • minimum 10 minutes observed</div>
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
    return {
      latest,
      baseline,
      elapsed,
      gained: gained >= 0 ? gained : null,
      rate: gained >= 0 && elapsed >= XP_MIN_RATE_WINDOW_MS ? gained / (elapsed / 3600000) : null,
      sampleCount: samples.length,
    };
  };

  const renderResourceLeaderboard = (keys) => {
    const candidates = keys.map((key) => ({
      key,
      username: state.profiles[key]?.username || state.resourceRankings.rows[key]?.username || key,
      trend: resourceTrend(state.resourceHistory[key], state.xpWindow),
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
          ${ranked.length ? ranked.map((row) => `
            <div class="so-xp-leaderboard-row ${row.key === state.selfProfileKey ? "self" : ""}">
              <b>${row.tied ? "T" : ""}#${row.rank}</b>
              <span>${esc(row.username)}${row.key === state.selfProfileKey ? " (You)" : ""}</span>
              <strong title="${esc(xpRateNumber(row.trend.rate))} RSS/hour • ${esc(xpRateNumber(row.trend.gained))} gained over ${esc(durationLabel(row.trend.elapsed))}">${esc(compactNumber(row.trend.rate))}<small> RSS/h</small></strong>
            </div>`).join("") : `<div class="so-empty">No tracked player has completed RSS-rate calibration for this window.</div>`}
        </div>
        <div class="so-xp-leaderboard-foot">${ranked.length} ranked • ${calibrating.length} calibrating • minimum 10 minutes observed</div>
      </section>`;
  };

  const renderXpRankings = () => {
    const keys = listedPlayerKeys(false);
    return `
      <div class="so-rank-controls">
        <label>Ranking window
          <select data-action="select-xp-window">${Object.keys(XP_WINDOWS).map((windowName) => `<option value="${windowName}" ${windowName === state.xpWindow ? "selected" : ""}>${windowName === "all" ? "All observed" : windowName}</option>`).join("")}</select>
        </label>
      </div>
      <div class="so-xp-leaderboards">
        <p class="so-note">Rankings include you, squad members, and favorited profiles. The selected window applies to XP/hour and RSS/hour.</p>
        ${keys.length ? `${renderXpLeaderboard(keys, "battling")}${renderXpLeaderboard(keys, "gathering")}` : `<div class="so-empty">No squad members or favorited profiles are available yet.</div>`}
        ${renderResourceLeaderboard(keys)}
      </div>
      <p class="so-note">Rates need two comparable snapshots spanning 10 minutes. RSS totals are captured whenever you normally open a player profile or view the game’s resource ranking; reopen profiles to refresh them. Ties share the same place.</p>`;
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
    const playerName = state.profiles[selected]?.username || selected;
    const controls = `<div class="so-xp-controls">
      <label>Player<select data-action="select-profile">${keys.map((key) => `<option value="${esc(key)}" ${key === selected ? "selected" : ""}>${esc(state.profiles[key]?.username || key)}${key === state.selfProfileKey ? " (You)" : ""}${key !== state.selfProfileKey && state.favorites.has(key) ? " ★" : ""}</option>`).join("")}</select></label>
      <label>Window<select data-action="select-xp-window">${Object.keys(XP_WINDOWS).map((windowName) => `<option value="${windowName}" ${windowName === state.xpWindow ? "selected" : ""}>${windowName === "all" ? "All observed" : windowName}</option>`).join("")}</select></label>
    </div>`;
    if (!history.length) return `${controls}<div class="so-empty">No XP baseline has been observed for ${esc(playerName)}. Open their public profile normally on separate occasions to build a history.</div>`;
    const firstAt = history[0]?.at || Date.now();
    const lastAt = history.at(-1)?.at || firstAt;
    return `
      ${controls}
      <div class="so-metrics so-xp-summary">
        <div><strong>${history.length}</strong><span>snapshots</span></div>
        <div><strong>${durationLabel(lastAt - firstAt)}</strong><span>observed span</span></div>
      </div>
      <p class="so-note">${esc(playerName)} • wall-clock estimates from data the game already loaded. Open another player’s public profile normally on separate occasions to build their history.</p>
      <div class="so-xp-list">
        ${XP_ACTIVITIES.map((activity) => {
          const trend = xpTrend(history, activity, state.xpWindow);
          const current = trend.latest?.activities?.[activity];
          if (!current) return `<article class="so-xp-card"><div class="so-xp-title"><strong>${cleanLabel(activity)}</strong><span>Not exposed</span></div></article>`;
          const [level, currentXp, targetXp] = current;
          const progress = targetXp > 0 ? Math.max(0, Math.min(100, (currentXp / targetXp) * 100)) : 0;
          const ready = trend.rate !== null;
          const calibrationRemaining = Math.max(0, XP_MIN_RATE_WINDOW_MS - (trend.elapsed || 0));
          const confidence = !trend.delta
            ? "collecting comparable snapshots"
            : !ready
              ? `calibrating • ${durationLabel(calibrationRemaining)} remaining`
              : `${trend.delta.confidence} confidence`;
          return `<article class="so-xp-card">
            <div class="so-xp-title"><strong>${cleanLabel(activity)}</strong><span>Level ${esc(level)}</span></div>
            <div class="so-xp-progress"><i style="width:${progress.toFixed(2)}%"></i></div>
            <div class="so-xp-progress-text"><span>${esc(compactNumber(currentXp))} / ${esc(compactNumber(targetXp))}</span><span>${progress.toFixed(1)}%</span></div>
            <div class="so-xp-stats">
              <div><span>Observed average</span><strong>${ready ? `${trend.delta.estimated ? "≈" : ""}${esc(xpRateNumber(trend.rate))} XP/hour` : "—"}</strong></div>
              <div><span>Gained</span><strong>${trend.delta ? `${trend.delta.estimated ? "≈" : ""}${esc(compactNumber(trend.delta.gained))}` : "—"}</strong></div>
            </div>
            <div class="so-xp-confidence ${ready ? trend.delta?.confidence || "pending" : "pending"}">${esc(confidence)}${trend.elapsed ? ` • ${durationLabel(trend.elapsed)} measured` : ""}</div>
          </article>`;
        }).join("")}
      </div>
      <p class="so-note">Rates appear after at least 10 minutes to avoid misleading short-interval extrapolation. A one-level crossing is calculated from the prior remaining XP plus the new level’s progress. Multiple skipped levels use an interpolation estimate and are marked low confidence.</p>`;
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
    const queued = state.sync.outboxXp.length + state.sync.outboxResources.length + Object.keys(state.sync.outboxProfiles).length;
    return `
      <div class="so-sync">
        <div class="so-sync-status ${esc(state.sync.status)}">
          <span>${connected ? "Shared database online" : state.sync.enabled ? "Shared database" : "Shared database off"}</span>
          <strong>${esc(state.sync.message)}</strong>
          <small>Last successful pull: ${esc(lastSync)} • ${queued} queued item${queued === 1 ? "" : "s"}</small>
        </div>
        <div class="so-account-card ${steamConnected ? "connected" : ""}">
          <div class="so-account-heading">
            <span>Stellar Odyssey account</span>
            <strong>${esc(owner || "Open your own profile to detect the account")}</strong>
            <small>${steamConnected ? "This device follows the account through Steam" : "Connect once on each new device — no code copying"}</small>
          </div>
          <button class="so-steam-button" data-action="sync-steam" ${state.sync.authBusy || !owner ? "disabled" : ""}>${steamConnected ? "Reconnect Steam" : pendingSteam ? "Restart Steam sign-in" : "Connect with Steam"}</button>
          ${pendingSteam ? `<button class="so-link-secondary" data-action="sync-steam-open">Open the Steam sign-in again</button><small class="so-link-wait">Waiting for Steam confirmation…</small>` : ""}
          ${steamConnected ? `<button class="so-link-secondary danger" data-action="sync-steam-revoke">Disconnect this device</button>` : ""}
        </div>
        <label class="so-sync-toggle">
          <input type="checkbox" data-action="sync-enabled" ${state.sync.enabled ? "checked" : ""}>
          <span><strong>Enable shared profile and XP history</strong><small>Connects only to the informational companion service, never to the game server.</small></span>
        </label>
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
        <p class="so-note">Favorites follow the Steam-linked account. Public profile, XP, and RSS observations are pooled across participating users only after they enable shared history, and only when the game has already loaded that information normally.</p>
        <p class="so-note">Steam authentication happens in Steam’s browser page. The overlay never receives a Steam password and never uploads game cookies or session credentials.</p>
      </div>`;
  };

  const renderAbout = () => `
    <div class="so-about">
      <h3>Display-only compliance</h3>
      <p>This companion does not call game APIs, send WebSocket messages, click controls, navigate profiles, or automate travel. It only reads client state and responses caused by your normal actions.</p>
      <p>Engine alerts only observe the countdown already rendered by the map. They never activate the engine or initiate travel.</p>
      <p>XP rates are wall-clock estimates from repeated snapshots. No profile is polled automatically. Optional shared sync talks only to the separately configured companion service, never to the game server.</p>
      <h3>Map legend</h3>
      <div class="so-legend"><span class="node" aria-hidden="true"></span> golden halo: system with a 100% resource node</div>
      <div class="so-legend"><span class="squad">S</span> squad member with a recently exposed location</div>
      <div class="so-legend"><span class="friend">F</span> local friend with a recently exposed location</div>
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
        : state.tab === "xp"
          ? renderXpTrends()
          : state.tab === "ranks"
            ? renderXpRankings()
            : state.tab === "alerts"
              ? renderEngineAlerts()
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
      }
      #${ROOT_ID}{position:fixed;inset:0;z-index:2147483646;font:13px/1.4 Rubik,Segoe UI,sans-serif;color:#e8f5ff;pointer-events:none}
      #${ROOT_ID} *{box-sizing:border-box}
      #${ROOT_ID} button,#${ROOT_ID} select{font:inherit}
      #${ROOT_ID} .so-engine-ready-badge{display:none;pointer-events:auto;position:fixed;right:44px;top:52px;border:1px solid #ffd95a;background:linear-gradient(135deg,#503d0b,#231d0a);color:#fff0a4;border-radius:9px;padding:8px 11px;font-weight:900;letter-spacing:.05em;box-shadow:0 0 22px #ffc92877,0 7px 24px #0009;cursor:pointer;animation:soEngineBadgePulse 1.8s ease-in-out infinite}
      #${ROOT_ID} .so-engine-ready-badge.visible{display:block}
      #${ROOT_ID} .so-toggle{pointer-events:auto;position:fixed;right:0;top:50%;width:36px;height:118px;transform:translateY(-50%);border:1px solid #34d6cb;border-right:0;background:linear-gradient(180deg,#0d2635,#102f44);color:#bffbf5;border-radius:10px 0 0 10px;padding:10px 7px;font-weight:900;box-shadow:-7px 7px 24px #0009;cursor:pointer;letter-spacing:.08em;writing-mode:vertical-rl;text-orientation:mixed;transition:background .18s,color .18s,box-shadow .18s}
      #${ROOT_ID}:not(.collapsed) .so-toggle{background:linear-gradient(180deg,#13525a,#123b4d);color:#e3fffb;box-shadow:-8px 0 26px #2be2d655}
      #${ROOT_ID} .so-panel{pointer-events:auto;position:fixed;right:42px;top:92px;bottom:20px;display:flex;flex-direction:column;width:min(390px,calc(100vw - 54px));max-height:none;margin:0;background:rgba(8,20,31,.97);border:1px solid #2e566c;border-radius:12px;box-shadow:0 16px 48px #000c;overflow:hidden;backdrop-filter:blur(10px);transform:translateX(calc(100% + 52px));opacity:0;visibility:hidden;transition:transform .22s ease,opacity .18s ease,visibility 0s linear .22s;will-change:transform}
      #${ROOT_ID}:not(.collapsed) .so-panel{transform:translateX(0);opacity:1;visibility:visible;transition:transform .22s ease,opacity .18s ease,visibility 0s linear 0s}
      #${ROOT_ID} .so-title{display:flex;justify-content:space-between;align-items:center;padding:12px 14px 9px;background:linear-gradient(120deg,#12364a,#102637);border-bottom:1px solid #274b60}
      #${ROOT_ID} .so-title>div{display:flex;flex-direction:column}.so-title strong{font-size:15px;letter-spacing:.03em;color:#d6ffff}.so-title span{font-size:9px;color:#63e6d9;text-transform:uppercase;letter-spacing:.09em}.so-drawer-close{display:grid;place-items:center;width:28px;height:28px;border:1px solid #31576a;background:#0c2230;color:#9cc5d1;border-radius:7px;cursor:pointer;font-size:18px!important;line-height:1}.so-drawer-close:hover{border-color:#58cbbf;color:#dffffb}
      #${ROOT_ID} .so-tabs{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));background:#0b1926;border-bottom:1px solid #203d50}
      #${ROOT_ID} .so-tabs button{min-width:0;border:0;border-right:1px solid #203d50;background:transparent;color:#87a7b8;padding:9px 3px;cursor:pointer;font-size:11px}
      #${ROOT_ID} .so-tabs button.active{color:#69efe0;background:#123044;box-shadow:inset 0 -2px #44d8cb}
      #${ROOT_ID} .so-content{flex:1;min-height:0;max-height:none;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:12px 12px 28px;scrollbar-width:thin;scrollbar-color:#2b6175 #0b1926}
      #${ROOT_ID} .so-content::-webkit-scrollbar{width:10px}#${ROOT_ID} .so-content::-webkit-scrollbar-track{background:#0b1926}#${ROOT_ID} .so-content::-webkit-scrollbar-thumb{background:#2b6175;border:2px solid #0b1926;border-radius:8px}
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
      #${ROOT_ID} .so-rank-controls{display:flex;justify-content:flex-end;margin-bottom:6px}.so-rank-controls label{display:flex;align-items:center;gap:8px;color:#7897a8;font-size:10px}.so-rank-controls select{min-width:125px;background:#10283a;border:1px solid #31536a;color:#dff;border-radius:6px;padding:5px}
      #${ROOT_ID} .so-xp-summary{margin-bottom:4px}.so-xp-list{display:flex;flex-direction:column;gap:7px}.so-xp-card{min-width:0;padding:9px;background:#102636;border:1px solid #285066;border-radius:8px}.so-xp-title{display:flex;justify-content:space-between;gap:8px}.so-xp-title strong{color:#dff}.so-xp-title span{color:#89a7b6;font-size:11px}.so-xp-progress{height:6px;margin-top:7px;background:#071721;border-radius:5px;overflow:hidden}.so-xp-progress i{display:block;height:100%;background:linear-gradient(90deg,#37aeb3,#5af1d5);border-radius:5px}.so-xp-progress-text{display:flex;justify-content:space-between;margin-top:3px;color:#7793a2;font-size:9px}.so-xp-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}.so-xp-stats>div{display:flex;flex-direction:column;padding:5px 6px;background:#0b1e2b;border-radius:5px}.so-xp-stats span{color:#748f9d;font-size:9px;text-transform:uppercase}.so-xp-stats strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#c9f7ef;font-size:12px}.so-xp-confidence{margin-top:5px;color:#66d9cb;font-size:9px;text-transform:uppercase;letter-spacing:.04em}.so-xp-confidence.low{color:#f0bd62}.so-xp-confidence.pending{color:#7893a2}
      #${ROOT_ID} .so-xp-leaderboards{margin:2px 0 11px}.so-xp-leaderboard-card{margin-top:8px!important;border:1px solid #2b5265;background:#0c202e;border-radius:8px;overflow:hidden}.so-xp-leaderboard-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px;background:linear-gradient(120deg,#12354a,#102c36);border-bottom:1px solid #284b5d}.so-xp-leaderboard-head strong{color:#d8ffff;font-size:12px}.so-xp-leaderboard-head span{color:#ffd86a;font-size:10px;font-weight:800}.so-xp-leaderboard-list{max-height:230px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2b6175 #0b1926}.so-xp-leaderboard-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:5px;min-width:0;padding:6px 8px;border-bottom:1px solid #173344}.so-xp-leaderboard-row:last-child{border-bottom:0}.so-xp-leaderboard-row>b{color:#6e91a2;font-size:10px}.so-xp-leaderboard-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9d0da;font-size:11px}.so-xp-leaderboard-row>strong{color:#77e8dc;font-size:11px;text-align:right}.so-xp-leaderboard-row>strong small{color:#6f8d9a;font-size:8px;font-weight:500}.so-xp-leaderboard-row.self{background:linear-gradient(90deg,#3f3513aa,#17333a)}.so-xp-leaderboard-row.self>b,.so-xp-leaderboard-row.self>span{color:#ffe48b;font-weight:800}.so-xp-leaderboard-row.self>strong{color:#fff0ab}.so-xp-leaderboard-foot{padding:6px 8px;background:#091b27;color:#6f8c9b;font-size:9px}
      #${ROOT_ID} .so-engine-status{display:flex;flex-direction:column;gap:2px;padding:12px;border:1px solid #31536a;background:linear-gradient(135deg,#102c3d,#132537);border-radius:9px}.so-engine-status>span{color:#75a2b6;font-size:9px;text-transform:uppercase;letter-spacing:.09em}.so-engine-status>strong{color:#dff;font-size:17px}.so-engine-status>small{color:#7f9aa8}.so-engine-status.armed{border-color:#39796f;box-shadow:inset 3px 0 #4edccb}.so-engine-status.notified{border-color:#a98832;background:linear-gradient(135deg,#44350e,#1e291f);box-shadow:inset 3px 0 #ffd65a}.so-engine-status.notified>strong{color:#ffe58b}
      #${ROOT_ID} .so-alert-options{display:flex;flex-direction:column;gap:6px}.so-alert-option{display:grid;grid-template-columns:20px 1fr;align-items:center;gap:7px;padding:7px 8px;background:#102636;border:1px solid #25495c;border-radius:7px;cursor:pointer}.so-alert-option input{width:15px;height:15px;margin:0;accent-color:#4ddfce}.so-alert-option span{display:flex;flex-direction:column;min-width:0}.so-alert-option strong{color:#d9f4fa;font-size:11px}.so-alert-option small{color:#7895a4;font-size:9px}
      #${ROOT_ID} .so-alert-volume{display:flex;flex-direction:column;gap:5px;margin-top:11px;padding:8px;background:#0d2130;border-radius:7px;color:#86a3b2;font-size:10px}.so-alert-volume span{display:flex;justify-content:space-between}.so-alert-volume strong{color:#c8eee9}.so-alert-volume input{width:100%;accent-color:#52ddce}.so-alert-test{width:100%;margin-top:9px;border:1px solid #398d83;background:linear-gradient(135deg,#123e43,#14313f);color:#bffbf3;border-radius:7px;padding:8px 10px;font-weight:800;cursor:pointer}.so-alert-test:hover{border-color:#62d9cc}
      #${ROOT_ID} .so-sync-status{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid #31536a;background:#102636;border-radius:8px}.so-sync-status span{color:#7ea0b0;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.so-sync-status strong{color:#dff;font-size:12px}.so-sync-status small{color:#7895a4}.so-sync-status.online{border-color:#2d8174;box-shadow:inset 3px 0 #4ddcca}.so-sync-status.error{border-color:#8b4149;box-shadow:inset 3px 0 #e86773}.so-sync-status.syncing{border-color:#8d742d;box-shadow:inset 3px 0 #f0c84c}.so-sync-toggle{display:grid;grid-template-columns:20px 1fr;gap:7px;align-items:start;margin-top:10px;padding:8px;background:#0d2130;border:1px solid #294a5b;border-radius:7px}.so-sync-toggle input{width:15px;height:15px;margin:2px 0 0;accent-color:#4ddfce}.so-sync-toggle span{display:flex;flex-direction:column}.so-sync-toggle strong{color:#d9f4fa;font-size:11px}.so-sync-toggle small{color:#7895a4;font-size:9px}.so-sync-field{display:flex;flex-direction:column;gap:4px;margin-top:10px;color:#85a3b2;font-size:10px}.so-sync-field input{width:100%;min-width:0;border:1px solid #31536a;background:#0b1e2b;color:#dff;border-radius:6px;padding:7px}.so-sync-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}.so-sync-actions button{border:1px solid #355f72;background:#123044;color:#a9d7df;border-radius:6px;padding:7px 5px;font-size:10px;cursor:pointer}.so-sync-actions button.primary{grid-column:1/-1;border-color:#398d83;background:#153d42;color:#c3fbf4;font-weight:800}.so-sync-actions button:disabled{opacity:.45;cursor:default}
      #${ROOT_ID} .so-sync-status.linking{border-color:#4b6792;box-shadow:inset 3px 0 #6aa8ff}.so-account-card{display:flex;flex-direction:column;gap:7px;margin-top:10px;padding:11px;border:1px solid #31536a;border-radius:9px;background:linear-gradient(135deg,#112b3d,#111f31)}.so-account-card.connected{border-color:#2f8b7d;background:linear-gradient(135deg,#113937,#13283a)}.so-account-heading{display:flex;flex-direction:column;gap:2px}.so-account-heading span{color:#7598aa;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.so-account-heading strong{color:#e0fbff;font-size:14px;overflow-wrap:anywhere}.so-account-heading small{color:#7e9ba8;font-size:9px}.so-steam-button{width:100%;border:1px solid #5b87c7;border-radius:7px;padding:9px;background:linear-gradient(135deg,#173f69,#162f4c);color:#e7f3ff;font-weight:800;cursor:pointer}.so-steam-button:hover{border-color:#85b7ff}.so-steam-button:disabled{opacity:.45;cursor:default}.so-link-secondary{align-self:flex-start;border:0;background:transparent;color:#71b7ef;font-size:10px;text-decoration:underline;cursor:pointer;padding:1px}.so-link-secondary.danger{color:#e78c96}.so-link-wait{color:#e0bd64;font-size:9px}.so-sync-advanced{margin-top:10px;border:1px solid #294858;border-radius:7px;background:#0b1d29;padding:7px 8px}.so-sync-advanced summary{color:#87a7b7;font-size:10px;cursor:pointer}.so-sync-advanced[open] summary{color:#b7d9e5}
      #${ROOT_ID} .so-about p{color:#9ab0bc}.so-legend{display:flex;align-items:center;gap:8px;margin:7px 0;color:#a9bdc7}.so-legend span{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-size:9px;font-weight:800}.so-legend .node{border:0;background:radial-gradient(circle,transparent 0%,transparent 28%,rgba(255,215,0,.7) 34%,rgba(255,215,0,.35) 48%,rgba(255,215,0,0) 100%)}.so-legend .squad{background:#2781ff;color:white}.so-legend .friend{background:#d26cff;color:white}
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
      @media(max-width:900px){#${ROOT_ID} .so-engine-ready-badge{top:34px;right:42px}#${ROOT_ID} .so-panel{top:72px;right:40px;bottom:12px;width:min(360px,calc(100vw - 50px))}#${ROOT_ID} .so-toggle{width:34px;height:106px}}
    `;
    document.head.appendChild(style);

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = state.open ? "" : "collapsed";
    root.innerHTML = `
      <button class="so-engine-ready-badge" data-action="dismiss-engine-ready">ENGINE READY · dismiss</button>
      <button class="so-toggle" data-action="toggle">SO Intel</button>
      <div class="so-panel">
        <div class="so-title">
          <div><strong>Stellar Odyssey Intel</strong><span>passive • ${state.sync.enabled ? "shared sync opt-in" : "local"}</span></div>
          <button class="so-drawer-close" data-action="close-drawer" title="Close drawer" aria-label="Close drawer">×</button>
        </div>
        <nav class="so-tabs">
          <button data-action="tab" data-tab="nodes">Nodes</button>
          <button data-action="tab" data-tab="roster">Roster</button>
          <button data-action="tab" data-tab="profiles">Profiles</button>
          <button data-action="tab" data-tab="xp">XP</button>
          <button data-action="tab" data-tab="ranks">Ranks</button>
          <button data-action="tab" data-tab="alerts">Alerts</button>
          <button data-action="tab" data-tab="sync">Sync</button>
          <button data-action="tab" data-tab="about">Rules</button>
        </nav>
        <main class="so-content"></main>
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
      } else if (action === "favorite") {
        const key = String(button.dataset.name || "").toLowerCase();
        if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
        state.sync.favoritesUpdatedAt = Date.now();
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
      } else if (action === "test-engine-alert") {
        triggerEngineReady(true);
      } else if (action === "sync-steam") {
        const endpointInput = root.querySelector('[data-sync-field="endpoint"]');
        if (endpointInput) state.sync.endpoint = String(endpointInput.value || "").trim();
        const popup = prepareSteamWindow();
        beginSteamLink(popup);
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
        state.seen = {};
        state.profiles = {};
        state.locations = {};
        state.xpHistory = {};
        state.resourceHistory = {};
        state.resourceRankings = { rows: {}, totalResults: 0, capturedAt: 0, currentRank: 0, currentValue: 0 };
        state.favorites.clear();
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
      } else if (event.target.matches('[data-action="select-xp-window"]')) {
        const nextWindow = String(event.target.value || "24h");
        state.xpWindow = XP_WINDOWS[nextWindow] ? nextWindow : "24h";
        markDirty();
        state.lastPanelSignature = "";
        renderPanel();
      } else if (event.target.matches('[data-action="engine-setting"]')) {
        const key = String(event.target.dataset.setting || "");
        if (["sound", "toast", "flash", "badge", "desktop"].includes(key)) {
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
      seen: Object.keys(state.seen).length,
      profiles: Object.values(state.profiles).map((profile) => [profile.username, profile.capturedAt]),
      xp: Object.entries(state.xpHistory).map(([key, history]) => [key, history.length, history.at(-1)?.at]),
      xpWindow: state.xpWindow,
      resourceRankings: [
        Object.keys(state.resourceRankings.rows).length,
        state.resourceRankings.capturedAt,
        state.resourceRankings.currentRank,
      ],
      resourceHistory: Object.entries(state.resourceHistory).map(([key, history]) => [key, history.length, history.at(-1)?.at]),
      favorites: [...state.favorites].sort(),
      squad: state.squadMembers.map((member) => member.username),
      locations: Object.values(state.locations).map((location) => [location.username, location.seenAt]),
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
        state.sync.outboxXp.length,
        state.sync.outboxResources.length,
        Object.keys(state.sync.outboxProfiles).length,
      ],
      engineCooldown: state.tab === "alerts"
        ? [state.engineCooldown.phase, Math.ceil(Math.max(0, state.engineCooldown.readyAt - Date.now()) / 1000)]
        : null,
    });
    if (signature === state.lastPanelSignature) return;
    state.lastPanelSignature = signature;
    root.classList.toggle("collapsed", !state.open);
    root.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.tab));
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
    for (const system of Object.values(state.systems)) {
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

    const { squad, friends } = rosterKeys();
    for (const [key, location] of Object.entries(state.locations)) {
      if (Date.now() - location.seenAt > LOCATION_TTL_MS || Number(location.z) !== Number(currentZ)) continue;
      const isSquad = squad.has(key);
      const isFriend = friends.has(key);
      if (!isSquad && !isFriend) continue;
      const point = toScreen(location.x, location.y);
      if (visible(point)) markers.push({
        type: isSquad ? "squad" : "friend",
        label: location.username,
        title: `${isSquad ? "Squad" : "Friend"}: ${location.username} [${location.x},${location.y},${location.z}] • ${ageLabel(location.seenAt)}`,
        ...point,
      });
    }

    layer.replaceChildren(...markers.map((marker) => {
      const element = document.createElement("div");
      element.className = `so-map-marker player ${marker.type}`;
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
    if (!state.open || !root || root.contains(event.target)) return;
    state.open = false;
    markDirty();
    state.lastPanelSignature = "";
    renderPanel();
  };

  installNetworkObservers();
  ensureUi();
  ingestLiveClientState();
  seedResourceHistoryFromCache();
  if (state.sync.enabled && !state.sync.outboxXp.length && !state.sync.outboxResources.length && !Object.keys(state.sync.outboxProfiles).length) bootstrapSyncOutbox();
  updateEngineCooldown();
  renderPanel();
  renderMapMarkers();
  window.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);

  const liveTimer = setInterval(() => {
    ingestLiveClientState();
    updateEngineCooldown();
    renderPanel();
    renderMapMarkers();
  }, 500);
  const saveTimer = setInterval(persist, 2000);
  const syncTimer = setInterval(() => runSharedSync(false), 15000);
  const firstSyncTimer = setTimeout(() => runSharedSync(false), 1800);
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
    destroy() {
      clearInterval(liveTimer);
      clearInterval(saveTimer);
      clearInterval(syncTimer);
      clearInterval(steamLinkTimer);
      clearTimeout(firstSyncTimer);
      clearTimeout(firstSteamLinkPoll);
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
      document.documentElement.classList.remove(DRAWER_OPEN_CLASS, DRAWER_LAYOUT_CLASS);
      engineAudioContext?.close?.().catch?.(() => {});
      delete window.__stellarOdysseyIntelOverlay;
    },
  };

  return { ok: true, version: VERSION, reused: false };
})()
