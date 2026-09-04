const SERVICE_VERSION = "1.3.1";
const MAX_BODY_BYTES = 900_000;
const MAX_PLAYERS = 100;
const MAX_XP = 250;
const MAX_RESOURCES = 250;
const MAX_PROFILES = 40;
const MAX_FAVORITES = 250;
const MAX_SYSTEMS = 500;
const MAX_SYSTEMS_RETURN = 2000;
const MAX_BATTLES = 4;
const MAX_BATTLE_LOGS = 5000;
const MAX_BATTLE_PARTICIPANTS = 80;
const MAX_BATTLE_BYTES = 400_000;
const PVP_CATALYST_STATS = ["defense", "armor_penetration", "lifesteal", "stun", "block", "dot", "precision", "evasion"];
const MAX_REQUESTS_PER_MINUTE = 30;
const MIN_HISTORY_DAYS = 1;
const MAX_HISTORY_DAYS = 30;
const DEVICE_LINK_TTL_MS = 10 * 60 * 1000;
const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const RAW_HISTORY_RETENTION_MS = 7 * 86400000;
const HISTORY_SAMPLE_MS = 5 * 60 * 1000;

let databasePausedUntil = 0;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const nextUtcReset = (now = Date.now()) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 1, 0);
};

const databaseLimitResponse = () => json({
  ok: false,
  error: "Shared database daily free-tier limit reached; automatic sync resumes after 00:00 UTC.",
  retryAt: databasePausedUntil,
}, 503);

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const page = (title, message, ok = false, status = 200) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07131d;color:#daf7ff;font:16px/1.5 system-ui,sans-serif}.card{width:min(520px,calc(100% - 40px));padding:28px;border:1px solid ${ok ? "#3ea899" : "#8b4a54"};border-radius:14px;background:#0d2231;box-shadow:0 24px 80px #0008}h1{margin:0 0 10px;font-size:23px}p{margin:0;color:#a8c3ce}.mark{display:inline-grid;place-items:center;width:34px;height:34px;margin-bottom:15px;border-radius:50%;background:${ok ? "#174e49" : "#512d34"};font-weight:900}</style></head>
<body><main class="card"><div class="mark">${ok ? "✓" : "!"}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  },
});

const waitingPage = (url, attempt) => {
  const retryUrl = new URL(url);
  retryUrl.searchParams.set("wait", String(attempt + 1));
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${escapeHtml(retryUrl.toString())}"><title>Preparing Steam sign-in</title><style>
html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07131d;color:#daf7ff;font:16px/1.5 system-ui,sans-serif}.card{width:min(520px,calc(100% - 40px));padding:28px;border:1px solid #315f7f;border-radius:14px;background:#0d2231;box-shadow:0 24px 80px #0008}h1{margin:0 0 10px;font-size:23px}p{margin:0;color:#a8c3ce}</style></head>
<body><main class="card"><h1>Preparing Steam sign-in…</h1><p>The overlay is creating this device's secure connection. This page will continue automatically.</p></main></body></html>`, {
    status: 202,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
};

const cleanName = (value) => String(value || "").trim().slice(0, 64);
const playerKey = (value) => cleanName(value).toLocaleLowerCase("en-US");
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clampTimestamp = (value, now) => {
  const number = finite(value);
  if (number === null) return now;
  return Math.max(now - 45 * 86400000, Math.min(now + 300000, Math.floor(number)));
};

const normalizeResourceSource = (value) => {
  const label = String(value || "").trim().toLowerCase();
  if (["live", "live-profile", "live client stores"].includes(label)) return "live-profile";
  if (["profile", "public-profile", "official-profile", "shared-profile"].includes(label)) return label;
  if (label.includes("publicprofile")) return "public-profile";
  if (label.includes("official read-only api")) return "official-profile";
  if (label.includes("profile")) return "profile";
  return "";
};

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
};

const randomHex = (byteLength = 24) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((entry) => entry.toString(16).padStart(2, "0")).join("");
};

const validSecret = (value) => {
  const secret = String(value || "");
  return secret.length >= 32 && secret.length <= 128 && /^[A-Za-z0-9_-]+$/.test(secret);
};

const readBody = async (request, maxBytes = 30_000) => {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request is too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request is too large");
  return JSON.parse(text);
};

const chunks = (items, size = 80) => {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
};

const batchAll = async (database, statements) => {
  const results = [];
  for (const group of chunks(statements)) results.push(...await database.batch(group));
  return results;
};

const safeArray = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const dedupeRows = (rows, keyFor) => {
  const unique = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const previous = unique.get(key);
    if (!previous || Number(row?.observedAt || row?.profile?.capturedAt || 0) >= Number(previous?.observedAt || previous?.profile?.capturedAt || 0)) unique.set(key, row);
  }
  return [...unique.values()];
};
const playerEdges = (rows, keyFor, timeFor) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const at = Number(timeFor(row) || 0);
    const current = groups.get(key);
    if (!current) groups.set(key, { key, first: row, latest: row });
    else {
      if (at < Number(timeFor(current.first) || 0)) current.first = row;
      if (at >= Number(timeFor(current.latest) || 0)) current.latest = row;
    }
  }
  return [...groups.values()];
};

const monotonicResourceRows = async (database, rows) => {
  if (!rows.length) return rows;
  const states = new Map();
  const keys = [...new Set(rows.map((row) => row.key))];
  for (const group of chunks(keys, 75)) {
    const result = await database.prepare(`
      SELECT player_key, latest_at, latest_value FROM resource_player_state
      WHERE player_key IN (${inQuery(group.length)})
    `).bind(...group).all();
    for (const row of result.results || []) states.set(row.player_key, {
      at: Number(row.latest_at),
      value: Number(row.latest_value),
    });
  }
  const accepted = [];
  for (const row of [...rows].sort((a, b) => a.observedAt - b.observedAt)) {
    const current = states.get(row.key);
    if (current) {
      if (row.observedAt >= current.at && row.value < current.value) continue;
      if (row.observedAt < current.at && row.value > current.value) continue;
    }
    accepted.push(row);
    if (!current || row.observedAt >= current.at) states.set(row.key, { at: row.observedAt, value: row.value });
  }
  return accepted;
};
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const normalizeActivities = (value) => {
  const output = {};
  if (!value || typeof value !== "object") return output;
  for (const activity of ["battling", "gathering", "crafting", "exploring"]) {
    const row = value[activity];
    if (!Array.isArray(row) || row.length < 2) continue;
    const level = finite(row[0]);
    const current = finite(row[1]);
    const target = finite(row[2]) ?? 0;
    if (level === null || current === null) continue;
    output[activity] = [level, current, target];
  }
  const context = value._context;
  if (context && typeof context === "object") {
    const clean = { v: 1 };
    const boost = finite(context.b);
    const tier = finite(context.t);
    const gear = String(context.g || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 32);
    if (boost !== null && boost >= 0 && boost <= 10000) clean.b = boost;
    if (tier !== null && tier >= 0 && tier <= 1000) clean.t = tier;
    if (gear) clean.g = gear;
    if (Object.keys(clean).length > 1) output._context = clean;
  }
  return output;
};

const profileForStorage = (value, now) => {
  if (!value || typeof value !== "object") return null;
  const username = cleanName(value.username);
  if (!username) return null;
  const profile = {
    username,
    squadron: String(value.squadron || "").slice(0, 100),
    clones: value.clones ?? "",
    droids: value.droids ?? "",
    lastSeen: value.lastSeen ?? "",
    levels: value.levels && typeof value.levels === "object" ? value.levels : {},
    stats: value.stats && typeof value.stats === "object"
      ? Object.fromEntries(Object.entries(value.stats).filter(([key]) => !/^npcMat_/i.test(key)).slice(0, 80))
      : {},
    technology: value.technology && typeof value.technology === "object" ? Object.fromEntries(Object.entries(value.technology).slice(0, 40)) : {},
    pets: safeArray(value.pets, 30),
    gear: safeArray(value.gear, 12),
    capturedAt: clampTimestamp(value.capturedAt, now),
  };
  const encoded = JSON.stringify(profile);
  return encoded.length <= 90_000 ? { profile, encoded } : null;
};

const boundedNumber = (value, minimum, maximum) => {
  const number = finite(value);
  return number === null ? null : Math.max(minimum, Math.min(maximum, number));
};

const battleBuildForStorage = (value, now) => {
  if (!value || typeof value !== "object") return null;
  const stats = {
    power: boundedNumber(value.p, 0, 1e15),
    precision: boundedNumber(value.r, 0, 1e15),
    evasion: boundedNumber(value.e, 0, 1e15),
    hull: boundedNumber(value.h, 0, 1e15),
  };
  if (Object.values(stats).filter((entry) => entry !== null && entry > 0).length < 2) return null;
  const catalysts = {};
  for (const [key, raw] of Object.entries(value.c && typeof value.c === "object" ? value.c : {}).slice(0, 24)) {
    const name = String(key || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
    const amount = boundedNumber(raw, -1000, 1000);
    if (name && amount !== null) catalysts[name] = amount;
  }
  return {
    t: clampTimestamp(value.t, now),
    q: ["official", "live", "profile", "shared"].includes(value.q) ? value.q : "profile",
    p: stats.power,
    r: stats.precision,
    e: stats.evasion,
    h: stats.hull,
    c: catalysts,
  };
};

const battleParticipantForStorage = (value, now) => {
  if (!value || typeof value !== "object" || !["a", "d"].includes(value.s)) return null;
  const slot = Math.floor(boundedNumber(value.i, 0, MAX_BATTLE_PARTICIPANTS - 1) ?? 0);
  const clones = safeArray(value.c, 20).map((clone) => ({
    d: String(clone?.d || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 16),
    cc: boundedNumber(clone?.cc, 0, 1000),
    cd: boundedNumber(clone?.cd, 0, 1000),
    ds: boundedNumber(clone?.ds, 0, 1000),
  }));
  return {
    s: value.s,
    i: slot,
    l: boundedNumber(value.l, 0, 10000),
    d: boundedNumber(value.d, 0, 1e15),
    h: boundedNumber(value.h, 0, 1e15),
    m: boundedNumber(value.m, 0, 1e15),
    c: clones,
    b: battleBuildForStorage(value.b, now),
  };
};

const BATTLE_ACTIONS = new Set(["r", "h", "m", "b", "s", "z", "d", "a", "t", "f", "w", "u"]);
const normalizeBattle = async (value, now) => {
  if (!value || typeof value !== "object") return null;
  const kind = value.k === "arena" ? "arena" : value.k === "squadron" ? "squadron" : "";
  const sourceKey = String(value.x || "").toLowerCase();
  if (!kind || !/^[a-f0-9]{64}$/.test(sourceKey)) return null;
  const participants = safeArray(value.p, MAX_BATTLE_PARTICIPANTS)
    .map((row) => battleParticipantForStorage(row, now))
    .filter(Boolean);
  if (!participants.some((row) => row.s === "a") || !participants.some((row) => row.s === "d")) return null;
  const logs = safeArray(value.g, MAX_BATTLE_LOGS).map((row) => {
    if (!Array.isArray(row) || row.length < 2) return null;
    const round = Math.floor(boundedNumber(row[0], 0, 10000) ?? 0);
    const action = BATTLE_ACTIONS.has(row[1]) ? row[1] : "u";
    const actor = /^[ad](?:t|\d+(?:c\d+)?)?$/.test(String(row[2] || "")) ? String(row[2]) : "";
    const target = /^[ad](?:t|\d+(?:c\d+)?)?$/.test(String(row[3] || "")) ? String(row[3]) : "";
    return [
      round,
      action,
      actor,
      target,
      boundedNumber(row[4], -1e15, 1e15),
      boundedNumber(row[5], 0, 1e15),
      boundedNumber(row[6], 0, 1e15),
    ];
  }).filter(Boolean);
  if (!logs.length || !logs.some((row) => row[1] === "w")) return null;
  const teams = {};
  for (const side of ["a", "d"]) {
    const values = value.tb?.[side] && typeof value.tb[side] === "object" ? value.tb[side] : {};
    teams[side] = Object.fromEntries(Object.entries(values).slice(0, 20).map(([key, raw]) => [
      String(key || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32),
      boundedNumber(raw, -1e9, 1e9),
    ]).filter(([key, raw]) => key && raw !== null));
  }
  const battle = {
    v: 1,
    k: kind,
    o: clampTimestamp(value.o, now),
    r: Math.floor(boundedNumber(value.r, 0, 10000) ?? Math.max(...logs.map((row) => row[0]))),
    w: ["a", "d", "tie"].includes(value.w) ? value.w : "tie",
    p: participants,
    tb: teams,
    g: logs,
  };
  const encoded = JSON.stringify(battle);
  if (encoded.length > MAX_BATTLE_BYTES) return null;
  return { key: await sha256(`battle:v1:${kind}:${sourceKey}`), battle, encoded };
};

const battleTraining = (row) => {
  const actions = { hit: 0, miss: 0, block: 0, stun: 0, dot: 0 };
  const sides = {
    a: { hits: 0, attempts: 0, damage: [], hull: 0 },
    d: { hits: 0, attempts: 0, damage: [], hull: 0 },
  };
  for (const log of row.battle.g) {
    const actorSide = String(log[2] || "").slice(0, 1);
    const targetSide = String(log[3] || "").slice(0, 1);
    if (log[1] === "h") {
      actions.hit += 1;
      if (sides[actorSide]) {
        sides[actorSide].hits += 1;
        sides[actorSide].attempts += 1;
        if (Number(log[4]) > 0) sides[actorSide].damage.push(Number(log[4]));
      }
    } else if (log[1] === "m") {
      actions.miss += 1;
      if (sides[actorSide]) sides[actorSide].attempts += 1;
    } else if (log[1] === "b") {
      actions.block += 1;
      if (sides[actorSide]) sides[actorSide].attempts += 1;
    }
    if (sides[targetSide] && Number(log[6]) > sides[targetSide].hull) sides[targetSide].hull = Number(log[6]);
    if (log[1] === "s" || log[1] === "z") actions.stun += 1;
    else if (log[1] === "a" || log[1] === "t") actions.dot += 1;
  }
  let feature = null;
  let featureSource = null;
  let features = {};
  if (row.battle.k === "arena") {
    const attacker = row.battle.p.find((participant) => participant.s === "a")?.b;
    const defender = row.battle.p.find((participant) => participant.s === "d")?.b;
    if (attacker && defender && [attacker.p, attacker.r, attacker.e, attacker.h, defender.p, defender.r, defender.e, defender.h].every((entry) => entry > 0)) {
      const attackerHit = attacker.r / Math.max(1, attacker.r + defender.e);
      const defenderHit = defender.r / Math.max(1, defender.r + attacker.e);
      const attackerScore = attacker.p * attackerHit * attacker.h;
      const defenderScore = defender.p * defenderHit * defender.h;
      feature = Math.max(-8, Math.min(8, Math.log(Math.max(1e-9, attackerScore / Math.max(1e-9, defenderScore)))));
      featureSource = "profile";
      features = { base: feature };
      for (const stat of PVP_CATALYST_STATS) {
        if (!Object.hasOwn(attacker.c || {}, stat) || !Object.hasOwn(defender.c || {}, stat)) continue;
        features[stat] = Math.max(-5, Math.min(5, (Number(attacker.c[stat]) - Number(defender.c[stat])) / 100));
      }
    } else if ([sides.a, sides.d].every((side) => side.attempts >= 4 && side.damage.length >= 2 && side.hull > 0)) {
      const proxyScore = (side) => {
        const values = [...side.damage].sort((a, b) => a - b);
        const typicalDamage = values[Math.floor((values.length - 1) * 0.35)];
        return typicalDamage * (side.hits / side.attempts) * side.hull;
      };
      feature = Math.max(-8, Math.min(8, Math.log(Math.max(1e-9, proxyScore(sides.a) / Math.max(1e-9, proxyScore(sides.d))))));
      featureSource = "logs";
      features = { base: feature };
    }
  }
  return {
    ...actions,
    feature,
    featureSource,
    features,
    outcome: row.battle.w === "a" ? 1 : row.battle.w === "d" ? 0 : 0.5,
    rounds: row.battle.r,
    logs: row.battle.g.length,
    participants: row.battle.p.length,
  };
};

const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const updateBattleModel = async (database, kind, training, now) => {
  const current = await database.prepare("SELECT * FROM battle_model_state WHERE kind = ?").bind(kind).first();
  const battles = Number(current?.battle_count || 0) + 1;
  const matched = Number(current?.matched_count || 0);
  const inferred = Number(current?.inferred_count || 0);
  let intercept = finite(current?.intercept) ?? 0;
  let slope = finite(current?.slope) ?? 1;
  const coefficients = parseJson(current?.coefficients_json || "{}", {});
  if (finite(coefficients.base) === null) coefficients.base = slope;
  for (const stat of PVP_CATALYST_STATS) if (finite(coefficients[stat]) === null) coefficients[stat] = 0;
  let brierSum = Number(current?.brier_sum || 0);
  let nextMatched = matched;
  let nextInferred = inferred;
  if (training.feature !== null) {
    const featureEntries = Object.entries(training.features || {}).filter(([, value]) => finite(value) !== null);
    const predicted = sigmoid(intercept + featureEntries.reduce((total, [key, value]) => total + (finite(coefficients[key]) || 0) * Number(value), 0));
    const trainingCount = matched + inferred;
    const baseRate = training.featureSource === "profile" ? 0.2 : 0.05;
    const learningRate = Math.max(training.featureSource === "profile" ? 0.01 : 0.0025, baseRate / Math.sqrt(trainingCount + 1));
    const error = training.outcome - predicted;
    intercept = Math.max(-4, Math.min(4, intercept + learningRate * error));
    for (const [key, value] of featureEntries) {
      const updated = (finite(coefficients[key]) || 0) * (1 - learningRate * 0.001) + learningRate * error * Number(value);
      coefficients[key] = key === "base" ? Math.max(0.1, Math.min(5, updated)) : Math.max(-5, Math.min(5, updated));
    }
    slope = coefficients.base;
    brierSum += (predicted - training.outcome) ** 2;
    if (training.featureSource === "profile") nextMatched += 1;
    else nextInferred += 1;
  }
  await database.prepare(`
    INSERT INTO battle_model_state
      (kind, battle_count, matched_count, inferred_count, attacker_wins, defender_wins, ties, total_rounds,
       total_logs, hits, misses, blocks, stuns, dots, intercept, slope, coefficients_json, brier_sum, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET
      battle_count = excluded.battle_count,
      matched_count = excluded.matched_count,
      inferred_count = excluded.inferred_count,
      attacker_wins = excluded.attacker_wins,
      defender_wins = excluded.defender_wins,
      ties = excluded.ties,
      total_rounds = excluded.total_rounds,
      total_logs = excluded.total_logs,
      hits = excluded.hits,
      misses = excluded.misses,
      blocks = excluded.blocks,
      stuns = excluded.stuns,
      dots = excluded.dots,
      intercept = excluded.intercept,
      slope = excluded.slope,
      coefficients_json = excluded.coefficients_json,
      brier_sum = excluded.brier_sum,
      updated_at = excluded.updated_at
  `).bind(
    kind,
    battles,
    nextMatched,
    nextInferred,
    Number(current?.attacker_wins || 0) + (training.outcome === 1 ? 1 : 0),
    Number(current?.defender_wins || 0) + (training.outcome === 0 ? 1 : 0),
    Number(current?.ties || 0) + (training.outcome === 0.5 ? 1 : 0),
    Number(current?.total_rounds || 0) + training.rounds,
    Number(current?.total_logs || 0) + training.logs,
    Number(current?.hits || 0) + training.hit,
    Number(current?.misses || 0) + training.miss,
    Number(current?.blocks || 0) + training.block,
    Number(current?.stuns || 0) + training.stun,
    Number(current?.dots || 0) + training.dot,
    intercept,
    slope,
    JSON.stringify(coefficients),
    brierSum,
    now,
  ).run();
};

const readBattleModels = async (database) => {
  const rows = await database.prepare("SELECT * FROM battle_model_state WHERE kind IN ('arena', 'squadron')").all();
  return Object.fromEntries((rows.results || []).map((row) => {
    const attempts = Number(row.hits || 0) + Number(row.misses || 0) + Number(row.blocks || 0);
    const matched = Number(row.matched_count || 0);
    const inferred = Number(row.inferred_count || 0);
    return [row.kind, {
      battles: Number(row.battle_count || 0),
      matched,
      inferred,
      attackerWins: Number(row.attacker_wins || 0),
      defenderWins: Number(row.defender_wins || 0),
      ties: Number(row.ties || 0),
      averageRounds: Number(row.battle_count || 0) ? Number(row.total_rounds || 0) / Number(row.battle_count) : 0,
      hitRate: attempts ? Number(row.hits || 0) / attempts : null,
      blockRate: attempts ? Number(row.blocks || 0) / attempts : null,
      stuns: Number(row.stuns || 0),
      dots: Number(row.dots || 0),
      intercept: finite(row.intercept) ?? 0,
      slope: finite(row.slope) ?? 1,
      coefficients: parseJson(row.coefficients_json || "{}", {}),
      brier: matched + inferred ? Number(row.brier_sum || 0) / (matched + inferred) : null,
      updatedAt: Number(row.updated_at || 0),
    }];
  }));
};

const systemForStorage = (value, now) => {
  if (!value || typeof value !== "object") return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  if (x === null || y === null || z === null || Math.abs(x) > 1e9 || Math.abs(y) > 1e9 || Math.abs(z) > 1e6) return null;
  const nodeObservedAt = finite(value.nodeObservedAt) > 0 ? clampTimestamp(value.nodeObservedAt, now) : 0;
  const nodes = nodeObservedAt ? safeArray(value.nodes, 24).filter((node) => Number(node?.quality) === 100).map((node) => ({
    id: String(node?.id || "").slice(0, 100),
    type: String(node?.type || "resource").slice(0, 80),
    body: String(node?.body || "Planet").slice(0, 80),
    quality: 100,
  })) : [];
  const firstSeenAt = clampTimestamp(value.firstSeenAt, now);
  const system = nodes.length ? {
    id: String(value.id || "").slice(0, 100),
    name: cleanName(value.name) || "Unknown system",
    x,
    y,
    z,
    nodes,
    firstSeenAt,
  } : null;
  const encoded = system ? JSON.stringify(system) : null;
  if (encoded && encoded.length > 16_000) return null;
  return { key: `${z}:${x},${y}`, x, y, z, firstSeenAt, perfect: system ? 1 : 0, encoded, nodeObservedAt };
};

const enforceRateLimit = async (database, accountId, now) => {
  const minute = Math.floor(now / 60000);
  await database.prepare(`
    INSERT INTO request_limits (account_id, minute_bucket, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(account_id, minute_bucket)
    DO UPDATE SET request_count = request_count + 1
  `).bind(accountId, minute).run();
  const row = await database.prepare("SELECT request_count FROM request_limits WHERE account_id = ? AND minute_bucket = ?")
    .bind(accountId, minute).first();
  return Number(row?.request_count || 0) <= MAX_REQUESTS_PER_MINUTE;
};

const inQuery = (count) => Array.from({ length: count }, () => "?").join(",");

const changeCeiling = async (database) => {
  const row = await database.prepare("SELECT COALESCE(MAX(change_id), 0) AS value FROM sync_change_clock").first();
  return Number(row?.value || 0);
};

const allocateChange = async (database, now) => {
  const row = await database.prepare("INSERT INTO sync_change_clock (changed_at) VALUES (?) RETURNING change_id")
    .bind(now).first();
  return Number(row?.change_id || 0);
};

const xpBaselineSql = (milliseconds) => `COALESCE(
  (SELECT json_object('at', sample.observed_at, 'activities', json(sample.activities_json))
   FROM xp_observations sample
   WHERE sample.player_key = state.player_key AND sample.observed_at <= state.latest_at - ${milliseconds}
   ORDER BY sample.observed_at DESC LIMIT 1),
  (SELECT json_object('at', rollup.last_at, 'activities', json(rollup.last_activities_json))
   FROM xp_hourly_rollups rollup
   WHERE rollup.player_key = state.player_key AND rollup.last_at <= state.latest_at - ${milliseconds}
   ORDER BY rollup.last_at DESC LIMIT 1),
  json_object('at', state.first_at, 'activities', json(state.first_activities_json))
)`;

const resourceBaselineSql = (milliseconds) => `COALESCE(
  (SELECT json_object('at', sample.observed_at, 'value', sample.value)
   FROM resource_observations sample
   WHERE sample.player_key = state.player_key AND sample.observed_at <= state.latest_at - ${milliseconds}
   ORDER BY sample.observed_at DESC LIMIT 1),
  (SELECT json_object('at', rollup.last_at, 'value', rollup.last_value)
   FROM resource_hourly_rollups rollup
   WHERE rollup.player_key = state.player_key AND rollup.last_at <= state.latest_at - ${milliseconds}
   ORDER BY rollup.last_at DESC LIMIT 1),
  json_object('at', state.first_at, 'value', state.first_value)
)`;

const readSummaryData = async (database, requestedPlayers, summarySince, ceiling) => {
  const output = { xp: [], resources: [], profiles: [], cursor: ceiling };
  for (const playerGroup of chunks(requestedPlayers, 75)) {
    if (!playerGroup.length) continue;
    const placeholders = inQuery(playerGroup.length);
    const [xpRows, resourceRows, profileRows] = await database.batch([
      database.prepare(`
        SELECT state.player_key, state.username, state.latest_at, state.latest_activities_json,
               state.first_at, state.first_activities_json, state.updated_at, state.change_id,
               ${xpBaselineSql(21600000)} AS baseline_6h,
               ${xpBaselineSql(3600000)} AS baseline_1h,
               ${xpBaselineSql(86400000)} AS baseline_24h,
               ${xpBaselineSql(7 * 86400000)} AS baseline_7d
        FROM xp_player_state state
        WHERE state.player_key IN (${placeholders}) AND state.change_id > ? AND state.change_id <= ?
      `).bind(...playerGroup, summarySince, ceiling),
      database.prepare(`
        SELECT state.player_key, state.username, state.latest_at, state.latest_value,
               state.first_at, state.first_value, state.updated_at, state.change_id,
               ${resourceBaselineSql(21600000)} AS baseline_6h,
               ${resourceBaselineSql(3600000)} AS baseline_1h,
               ${resourceBaselineSql(86400000)} AS baseline_24h,
               ${resourceBaselineSql(7 * 86400000)} AS baseline_7d
        FROM resource_player_state state
        WHERE state.player_key IN (${placeholders}) AND state.change_id > ? AND state.change_id <= ?
      `).bind(...playerGroup, summarySince, ceiling),
      database.prepare(`
        SELECT player_key, profile_json, updated_at, change_id
        FROM latest_profiles
        WHERE player_key IN (${placeholders}) AND change_id > ? AND change_id <= ?
      `).bind(...playerGroup, summarySince, ceiling),
    ]);
    for (const row of xpRows.results || []) output.xp.push({
      key: row.player_key,
      username: row.username,
      updatedAt: Number(row.updated_at),
      latest: { at: Number(row.latest_at), activities: parseJson(row.latest_activities_json, {}) },
      baselines: {
        "6h": parseJson(row.baseline_6h, null),
        "1h": parseJson(row.baseline_1h, null),
        "24h": parseJson(row.baseline_24h, null),
        "7d": parseJson(row.baseline_7d, null),
        all: { at: Number(row.first_at), activities: parseJson(row.first_activities_json, {}) },
      },
    });
    for (const row of resourceRows.results || []) output.resources.push({
      key: row.player_key,
      username: row.username,
      updatedAt: Number(row.updated_at),
      latest: { at: Number(row.latest_at), value: Number(row.latest_value) },
      baselines: {
        "6h": parseJson(row.baseline_6h, null),
        "1h": parseJson(row.baseline_1h, null),
        "24h": parseJson(row.baseline_24h, null),
        "7d": parseJson(row.baseline_7d, null),
        all: { at: Number(row.first_at), value: Number(row.first_value) },
      },
    });
    for (const row of profileRows.results || []) {
      const profile = parseJson(row.profile_json, null);
      if (profile) output.profiles.push(profile);
    }
  }
  return output;
};

const readDetailedHistory = async (database, historyPlayers, cutoff, historySince, ceiling) => {
  if (!historyPlayers.length) return { xp: [], resources: [], historyIncluded: false, historyCursor: historySince };
  const placeholders = inQuery(historyPlayers.length);
  let xpRows;
  let resourceRows;
  if (historySince > 0) {
    [xpRows, resourceRows] = await database.batch([
      database.prepare(`
        SELECT username, observed_at AS at, source, activities_json, change_id
        FROM xp_observations
        WHERE player_key IN (${placeholders}) AND change_id > ? AND change_id <= ?
        ORDER BY change_id ASC, player_key ASC, observed_bucket ASC
        LIMIT 2500
      `).bind(...historyPlayers, historySince, ceiling),
      database.prepare(`
        SELECT username, observed_at AS at, value, source, change_id
        FROM resource_observations
        WHERE player_key IN (${placeholders}) AND change_id > ? AND change_id <= ?
        ORDER BY change_id ASC, player_key ASC, observed_bucket ASC
        LIMIT 2500
      `).bind(...historyPlayers, historySince, ceiling),
    ]);
  } else {
    const recentCutoff = Math.max(cutoff, Date.now() - RAW_HISTORY_RETENTION_MS);
    [xpRows, resourceRows] = await database.batch([
      database.prepare(`
        SELECT username, observed_at AS at, source, activities_json
        FROM (
          SELECT username, observed_at, source, activities_json,
                 ROW_NUMBER() OVER (
                   PARTITION BY player_key, CAST(observed_at / ${HISTORY_SAMPLE_MS} AS INTEGER)
                   ORDER BY observed_at DESC
                 ) AS sample_rank
          FROM xp_observations
          WHERE player_key IN (${placeholders}) AND observed_at >= ?
        ) sampled
        WHERE sample_rank = 1
        ORDER BY observed_at ASC
        LIMIT 2500
      `).bind(...historyPlayers, recentCutoff),
      database.prepare(`
        SELECT username, observed_at AS at, value, source
        FROM (
          SELECT username, observed_at, value, source,
                 ROW_NUMBER() OVER (
                   PARTITION BY player_key, CAST(observed_at / ${HISTORY_SAMPLE_MS} AS INTEGER)
                   ORDER BY observed_at DESC
                 ) AS sample_rank
          FROM resource_observations
          WHERE player_key IN (${placeholders}) AND observed_at >= ?
        ) sampled
        WHERE sample_rank = 1
        ORDER BY observed_at ASC
        LIMIT 2500
      `).bind(...historyPlayers, recentCutoff),
    ]);
  }
  return {
    xp: (xpRows.results || []).map((row) => ({
      username: row.username,
      at: Number(row.at),
      source: row.source,
      activities: parseJson(row.activities_json, {}),
    })),
    resources: (resourceRows.results || []).map((row) => ({
      username: row.username,
      at: Number(row.at),
      value: Number(row.value),
      source: row.source,
    })),
    historyIncluded: true,
    historyCursor: ceiling,
  };
};

const compactHistory = async (database, now = Date.now()) => {
  const cutoff = now - RAW_HISTORY_RETENTION_MS;
  await database.batch([
    database.prepare(`
      INSERT INTO xp_hourly_rollups
        (player_key, hour_bucket, username, first_at, first_activities_json, last_at, last_activities_json, updated_at)
      SELECT player_key, hour_bucket,
             MAX(CASE WHEN newest_rank = 1 THEN username END),
             MIN(observed_at),
             MAX(CASE WHEN oldest_rank = 1 THEN activities_json END),
             MAX(observed_at),
             MAX(CASE WHEN newest_rank = 1 THEN activities_json END),
             MAX(created_at)
      FROM (
        SELECT player_key, CAST(observed_at / 3600000 AS INTEGER) AS hour_bucket,
               username, observed_at, activities_json, created_at,
               ROW_NUMBER() OVER (PARTITION BY player_key, CAST(observed_at / 3600000 AS INTEGER) ORDER BY observed_at ASC) AS oldest_rank,
               ROW_NUMBER() OVER (PARTITION BY player_key, CAST(observed_at / 3600000 AS INTEGER) ORDER BY observed_at DESC) AS newest_rank
        FROM xp_observations WHERE observed_at < ?
      ) old_rows
      GROUP BY player_key, hour_bucket
      ON CONFLICT(player_key, hour_bucket) DO UPDATE SET
        username = excluded.username,
        first_at = MIN(xp_hourly_rollups.first_at, excluded.first_at),
        first_activities_json = CASE WHEN excluded.first_at < xp_hourly_rollups.first_at THEN excluded.first_activities_json ELSE xp_hourly_rollups.first_activities_json END,
        last_at = MAX(xp_hourly_rollups.last_at, excluded.last_at),
        last_activities_json = CASE WHEN excluded.last_at > xp_hourly_rollups.last_at THEN excluded.last_activities_json ELSE xp_hourly_rollups.last_activities_json END,
        updated_at = MAX(xp_hourly_rollups.updated_at, excluded.updated_at)
    `).bind(cutoff),
    database.prepare(`
      INSERT INTO resource_hourly_rollups
        (player_key, hour_bucket, username, first_at, first_value, last_at, last_value, updated_at)
      SELECT player_key, hour_bucket,
             MAX(CASE WHEN newest_rank = 1 THEN username END),
             MIN(observed_at),
             MAX(CASE WHEN oldest_rank = 1 THEN value END),
             MAX(observed_at),
             MAX(CASE WHEN newest_rank = 1 THEN value END),
             MAX(created_at)
      FROM (
        SELECT player_key, CAST(observed_at / 3600000 AS INTEGER) AS hour_bucket,
               username, observed_at, value, created_at,
               ROW_NUMBER() OVER (PARTITION BY player_key, CAST(observed_at / 3600000 AS INTEGER) ORDER BY observed_at ASC) AS oldest_rank,
               ROW_NUMBER() OVER (PARTITION BY player_key, CAST(observed_at / 3600000 AS INTEGER) ORDER BY observed_at DESC) AS newest_rank
        FROM resource_observations WHERE observed_at < ?
      ) old_rows
      GROUP BY player_key, hour_bucket
      ON CONFLICT(player_key, hour_bucket) DO UPDATE SET
        username = excluded.username,
        first_at = MIN(resource_hourly_rollups.first_at, excluded.first_at),
        first_value = CASE WHEN excluded.first_at < resource_hourly_rollups.first_at THEN excluded.first_value ELSE resource_hourly_rollups.first_value END,
        last_at = MAX(resource_hourly_rollups.last_at, excluded.last_at),
        last_value = CASE WHEN excluded.last_at > resource_hourly_rollups.last_at THEN excluded.last_value ELSE resource_hourly_rollups.last_value END,
        updated_at = MAX(resource_hourly_rollups.updated_at, excluded.updated_at)
    `).bind(cutoff),
    database.prepare("DELETE FROM xp_observations WHERE observed_at < ?").bind(cutoff),
    database.prepare("DELETE FROM resource_observations WHERE observed_at < ?").bind(cutoff),
    database.prepare("DELETE FROM profile_snapshots WHERE observed_at < ?").bind(cutoff),
    database.prepare("DELETE FROM request_limits WHERE minute_bucket < ?").bind(Math.floor((now - 2 * 86400000) / 60000)),
    database.prepare("DELETE FROM steam_device_links WHERE expires_at < ?").bind(now - 7 * 86400000),
  ]);
};

const failSteamLink = async (database, requestId, message) => {
  if (requestId) {
    await database.prepare(`
      UPDATE steam_device_links
      SET status = 'failed', error_message = ?, completed_at = ?
      WHERE request_id = ? AND status = 'pending'
    `).bind(String(message || "Steam sign-in failed").slice(0, 180), Date.now(), requestId).run();
  }
  return page("Steam link unsuccessful", message || "Steam sign-in could not be verified.", false, 400);
};

const startSteamDeviceLink = async (request, env) => {
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json({ ok: false, error: error?.message === "Request is too large" ? error.message : "Invalid JSON" }, 400);
  }
  const owner = cleanName(body?.owner);
  const ownerKey = playerKey(owner);
  const deviceToken = String(body?.deviceToken || "");
  if (!owner || !validSecret(deviceToken)) return json({ ok: false, error: "A loaded game account and valid device credential are required" }, 400);

  const now = Date.now();
  const deviceHash = await sha256(deviceToken);
  const remoteAddress = String(request.headers.get("cf-connecting-ip") || "unknown").slice(0, 80);
  const limiterId = `auth:${await sha256(remoteAddress)}`;
  if (!await enforceRateLimit(env.DB, limiterId, now)) return json({ ok: false, error: "Too many device-link requests" }, 429);

  const legacyToken = String(body?.legacyToken || "");
  const legacyAccountId = validSecret(legacyToken) ? await sha256(legacyToken) : null;
  const previousDeviceToken = String(body?.previousDeviceToken || "");
  const previousDeviceHash = validSecret(previousDeviceToken) ? await sha256(previousDeviceToken) : null;
  const requestedId = String(body?.requestId || "");
  if (requestedId && !/^[a-f0-9]{48}$/i.test(requestedId)) return json({ ok: false, error: "Invalid device-link request" }, 400);
  const requestId = requestedId || randomHex(24);
  const expiresAt = now + DEVICE_LINK_TTL_MS;
  await env.DB.prepare(`
    INSERT INTO steam_device_links
      (request_id, device_hash, owner_key, owner_name, legacy_account_id, previous_device_hash, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(requestId, deviceHash, ownerKey, owner, legacyAccountId, previousDeviceHash, now, expiresAt).run();

  const authorizeUrl = new URL("/auth/steam/start", request.url);
  authorizeUrl.searchParams.set("request", requestId);
  return json({ ok: true, requestId, authorizeUrl: authorizeUrl.toString(), expiresAt });
};

const steamOpenIdStart = async (request, env) => {
  const url = new URL(request.url);
  const requestId = String(url.searchParams.get("request") || "");
  const waitAttempt = Math.max(0, Math.min(15, Number.parseInt(url.searchParams.get("wait") || "0", 10) || 0));
  const link = requestId
    ? await env.DB.prepare("SELECT status, expires_at FROM steam_device_links WHERE request_id = ?").bind(requestId).first()
    : null;
  if (!link && /^[a-f0-9]{48}$/i.test(requestId) && waitAttempt < 15) return waitingPage(url, waitAttempt);
  if (!link || link.status !== "pending" || Number(link.expires_at || 0) < Date.now()) {
    return page("Link expired", "Return to Stellar Odyssey and select Connect with Steam again.", false, 410);
  }

  const origin = url.origin;
  const returnTo = new URL("/auth/steam/callback", origin);
  returnTo.searchParams.set("request", requestId);
  const steamUrl = new URL(STEAM_OPENID_ENDPOINT);
  steamUrl.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  steamUrl.searchParams.set("openid.mode", "checkid_setup");
  steamUrl.searchParams.set("openid.return_to", returnTo.toString());
  steamUrl.searchParams.set("openid.realm", origin);
  steamUrl.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
  steamUrl.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
  return Response.redirect(steamUrl.toString(), 302);
};

const steamOpenIdCallback = async (request, env) => {
  const url = new URL(request.url);
  const requestId = String(url.searchParams.get("request") || "");
  const link = requestId
    ? await env.DB.prepare("SELECT * FROM steam_device_links WHERE request_id = ?").bind(requestId).first()
    : null;
  if (!link) return page("Unknown device request", "Return to Stellar Odyssey and start the connection again.", false, 404);
  if (link.status === "approved") return page("Steam account connected", `Return to Stellar Odyssey. ${link.owner_name} is ready to sync on this device.`, true);
  if (link.status !== "pending" || Number(link.expires_at || 0) < Date.now()) {
    return failSteamLink(env.DB, requestId, "This device-link request expired. Start it again from the overlay.");
  }
  if (url.searchParams.get("openid.mode") !== "id_res") return failSteamLink(env.DB, requestId, "Steam sign-in was cancelled or did not complete.");

  const expectedReturn = new URL("/auth/steam/callback", url.origin);
  expectedReturn.searchParams.set("request", requestId);
  if (url.searchParams.get("openid.return_to") !== expectedReturn.toString()) {
    return failSteamLink(env.DB, requestId, "Steam returned an unexpected callback address.");
  }

  const claimedId = String(url.searchParams.get("openid.claimed_id") || "");
  const identity = String(url.searchParams.get("openid.identity") || "");
  const steamMatch = claimedId.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{15,22})$/);
  if (!steamMatch || identity !== claimedId) return failSteamLink(env.DB, requestId, "Steam did not return a valid account identity.");

  try {
    const verification = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith("openid.")) verification.append(key, value);
    }
    verification.set("openid.mode", "check_authentication");
    const verifyResponse = await fetch(STEAM_OPENID_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: verification.toString(),
    });
    const verificationText = await verifyResponse.text();
    if (!verifyResponse.ok || !/(?:^|\n)is_valid\s*:\s*true(?:\r?$|\n)/im.test(verificationText)) {
      return failSteamLink(env.DB, requestId, "Steam could not verify this sign-in.");
    }

    const now = Date.now();
    const steamId = steamMatch[1];
    const accountId = await sha256(`steam:${steamId}`);
    let account = await env.DB.prepare("SELECT * FROM accounts WHERE account_id = ?").bind(accountId).first();
    const legacy = link.legacy_account_id
      ? await env.DB.prepare("SELECT * FROM accounts WHERE account_id = ?").bind(link.legacy_account_id).first()
      : null;
    const usableLegacy = legacy?.owner_key === link.owner_key ? legacy : null;

    if (account && account.owner_key !== link.owner_key) {
      return failSteamLink(env.DB, requestId, "This Steam account is already linked to a different Stellar Odyssey account.");
    }
    if (!account) {
      const favorites = usableLegacy?.favorites_json || "[]";
      const favoritesUpdatedAt = Number(usableLegacy?.favorites_updated_at || 0);
      await env.DB.prepare(`
        INSERT INTO accounts (account_id, owner_key, favorites_json, favorites_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(accountId, link.owner_key, favorites, favoritesUpdatedAt, now, now).run();
      account = { account_id: accountId, owner_key: link.owner_key, favorites_json: favorites, favorites_updated_at: favoritesUpdatedAt };
    } else if (usableLegacy && Number(usableLegacy.favorites_updated_at || 0) > Number(account.favorites_updated_at || 0)) {
      await env.DB.prepare(`
        UPDATE accounts SET favorites_json = ?, favorites_updated_at = ?, updated_at = ? WHERE account_id = ?
      `).bind(usableLegacy.favorites_json || "[]", Number(usableLegacy.favorites_updated_at || 0), now, accountId).run();
    }

    const deviceStatements = [
      env.DB.prepare(`
        INSERT INTO account_devices (device_hash, account_id, owner_key, steam_id, created_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(device_hash) DO UPDATE SET
          account_id = excluded.account_id,
          owner_key = excluded.owner_key,
          steam_id = excluded.steam_id,
          last_seen_at = excluded.last_seen_at,
          revoked_at = NULL
      `).bind(link.device_hash, accountId, link.owner_key, steamId, now, now),
      env.DB.prepare(`
        UPDATE steam_device_links
        SET status = 'approved', steam_id = ?, error_message = NULL, completed_at = ?
        WHERE request_id = ?
      `).bind(steamId, now, requestId),
    ];
    if (link.previous_device_hash && link.previous_device_hash !== link.device_hash) {
      deviceStatements.push(env.DB.prepare(`
        UPDATE account_devices SET revoked_at = ?, last_seen_at = ?
        WHERE device_hash = ? AND account_id = ?
      `).bind(now, now, link.previous_device_hash, accountId));
    }
    await env.DB.batch(deviceStatements);
    return page("Steam account connected", `Return to Stellar Odyssey. ${link.owner_name} is ready to sync on this device.`, true);
  } catch {
    return failSteamLink(env.DB, requestId, "Steam verification is temporarily unavailable. Please try again.");
  }
};

const steamDeviceStatus = async (request, env) => {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const requestId = String(body?.requestId || "");
  const deviceToken = String(body?.deviceToken || "");
  if (!/^[a-f0-9]{48}$/i.test(requestId) || !validSecret(deviceToken)) return json({ ok: false, error: "Invalid device-link request" }, 400);
  const link = await env.DB.prepare("SELECT * FROM steam_device_links WHERE request_id = ?").bind(requestId).first();
  if (!link || link.device_hash !== await sha256(deviceToken)) return json({ ok: false, error: "Device-link request not found" }, 404);
  if (link.status === "pending" && Number(link.expires_at || 0) < Date.now()) {
    await env.DB.prepare("UPDATE steam_device_links SET status = 'expired', completed_at = ? WHERE request_id = ? AND status = 'pending'")
      .bind(Date.now(), requestId).run();
    link.status = "expired";
  }
  return json({
    ok: true,
    status: link.status,
    owner: link.owner_name,
    error: link.error_message || "",
    expiresAt: Number(link.expires_at || 0),
  });
};

const revokeSteamDevice = async (request, env) => {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const ownerKey = playerKey(body?.owner);
  const token = String(body?.token || "");
  if (!ownerKey || !validSecret(token)) return json({ ok: false, error: "Invalid device credential" }, 400);
  const deviceHash = await sha256(token);
  const device = await env.DB.prepare("SELECT owner_key FROM account_devices WHERE device_hash = ? AND revoked_at IS NULL")
    .bind(deviceHash).first();
  if (!device || device.owner_key !== ownerKey) return json({ ok: false, error: "This device is not linked to the loaded account" }, 403);
  await env.DB.prepare("UPDATE account_devices SET revoked_at = ?, last_seen_at = ? WHERE device_hash = ?")
    .bind(Date.now(), Date.now(), deviceHash).run();
  return json({ ok: true });
};

const deleteSteamAccountData = async (request, env) => {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const ownerKey = playerKey(body?.owner);
  const token = String(body?.token || "");
  if (body?.confirmation !== "DELETE") return json({ ok: false, error: "Type DELETE in the overlay to confirm cloud-account deletion" }, 400);
  if (!ownerKey || !validSecret(token)) return json({ ok: false, error: "Invalid device credential" }, 400);

  const deviceHash = await sha256(token);
  const device = await env.DB.prepare("SELECT account_id, owner_key FROM account_devices WHERE device_hash = ? AND revoked_at IS NULL")
    .bind(deviceHash).first();
  if (!device || device.owner_key !== ownerKey) return json({ ok: false, error: "This device is not linked to the loaded account" }, 403);
  const accountId = String(device.account_id || "");
  if (!accountId) return json({ ok: false, error: "The linked cloud account could not be found" }, 404);
  if (!await enforceRateLimit(env.DB, accountId, Date.now())) return json({ ok: false, error: "Too many account requests" }, 429);

  // Remove data that is still directly attributable to this linked account.
  // Compact pooled summaries and already-distributed client copies contain no
  // account/Steam identifier and intentionally cannot be recalled here.
  await batchAll(env.DB, [
    env.DB.prepare("DELETE FROM steam_device_links WHERE owner_key = ? OR legacy_account_id = ?").bind(ownerKey, accountId),
    env.DB.prepare("DELETE FROM account_systems WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM xp_observations WHERE reporter_account = ?").bind(accountId),
    env.DB.prepare("DELETE FROM resource_observations WHERE reporter_account = ?").bind(accountId),
    env.DB.prepare("DELETE FROM resource_observations_quarantine WHERE reporter_account = ?").bind(accountId),
    env.DB.prepare("DELETE FROM profile_snapshots WHERE reporter_account = ?").bind(accountId),
    env.DB.prepare("DELETE FROM battle_observations WHERE reporter_account = ?").bind(accountId),
    env.DB.prepare("DELETE FROM request_limits WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM account_devices WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM accounts WHERE account_id = ?").bind(accountId),
  ]);

  return json({ ok: true, deleted: true, aggregateRetention: true });
};

const sync = async (request, env) => {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json({ ok: false, error: "Request is too large" }, 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: "Request is too large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const now = Date.now();
  const owner = cleanName(body?.owner);
  const ownerKey = playerKey(owner);
  const token = String(body?.token || "");
  const authMode = body?.authMode === "steam" ? "steam" : "code";
  if (!owner || !validSecret(token)) return json({ ok: false, error: "A valid loaded account and device credential are required" }, 400);

  const incomingFavorites = [...new Set(safeArray(body?.favorites, MAX_FAVORITES).map(playerKey).filter(Boolean))];
  const suppliedFavoriteTime = finite(body?.favoritesUpdatedAt);
  const incomingFavoriteTime = suppliedFavoriteTime !== null && suppliedFavoriteTime > 0
    ? clampTimestamp(suppliedFavoriteTime, now)
    : 0;
  let accountId;
  let account;
  if (authMode === "steam") {
    const deviceHash = await sha256(token);
    const device = await env.DB.prepare("SELECT * FROM account_devices WHERE device_hash = ? AND revoked_at IS NULL")
      .bind(deviceHash).first();
    if (!device) return json({ ok: false, error: "This device is not connected with Steam" }, 401);
    if (device.owner_key !== ownerKey) return json({ ok: false, error: "Reconnect Steam for the currently loaded Stellar Odyssey account" }, 403);
    accountId = device.account_id;
    if (!await enforceRateLimit(env.DB, accountId, now)) return json({ ok: false, error: "Too many sync requests" }, 429);
    account = await env.DB.prepare("SELECT * FROM accounts WHERE account_id = ?").bind(accountId).first();
    if (!account || account.owner_key !== ownerKey) return json({ ok: false, error: "The linked account could not be found" }, 403);
    await env.DB.prepare("UPDATE account_devices SET last_seen_at = ? WHERE device_hash = ?").bind(now, deviceHash).run();
  } else {
    accountId = await sha256(token);
    if (!await enforceRateLimit(env.DB, accountId, now)) return json({ ok: false, error: "Too many sync requests" }, 429);
    account = await env.DB.prepare("SELECT * FROM accounts WHERE account_id = ?").bind(accountId).first();
    if (!account) {
      const initialTime = incomingFavoriteTime;
      const initialFavorites = initialTime > 0 ? incomingFavorites : [];
      await env.DB.prepare(`
        INSERT INTO accounts (account_id, owner_key, favorites_json, favorites_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(accountId, ownerKey, JSON.stringify(initialFavorites), initialTime, now, now).run();
      account = {
        account_id: accountId,
        owner_key: ownerKey,
        favorites_json: JSON.stringify(initialFavorites),
        favorites_updated_at: initialTime,
      };
    } else if (account.owner_key !== ownerKey) {
      return json({ ok: false, error: "This recovery code belongs to a different game account" }, 403);
    }
  }

  if (incomingFavoriteTime > 0 && incomingFavoriteTime > Number(account.favorites_updated_at || 0)) {
    await env.DB.prepare(`
      UPDATE accounts SET favorites_json = ?, favorites_updated_at = ?, updated_at = ? WHERE account_id = ?
    `).bind(JSON.stringify(incomingFavorites), incomingFavoriteTime, now, accountId).run();
    account.favorites_json = JSON.stringify(incomingFavorites);
    account.favorites_updated_at = incomingFavoriteTime;
  }

  const xp = dedupeRows(safeArray(body?.xp, MAX_XP).map((row) => {
    const username = cleanName(row?.username);
    const activities = normalizeActivities(row?.activities);
    const observedAt = clampTimestamp(row?.at, now);
    if (!username || !Object.keys(activities).length) return null;
    return { username, key: playerKey(username), activities, observedAt, source: String(row?.source || "public").slice(0, 40) };
  }).filter(Boolean), (row) => `${row.key}:${Math.floor(row.observedAt / 60000)}`);
  const profiles = dedupeRows(safeArray(body?.profiles, MAX_PROFILES).map((row) => profileForStorage(row, now)).filter(Boolean),
    (row) => `${playerKey(row.profile.username)}:${Math.floor(row.profile.capturedAt / 60000)}`);
  const legacyProfileEvidence = new Map(profiles.map((row) => [playerKey(row.profile.username), {
    at: Number(row.profile.capturedAt),
    value: finite(row.profile.stats?.resources),
  }]));
  let resources = dedupeRows(safeArray(body?.resources, MAX_RESOURCES).map((row) => {
    const username = cleanName(row?.username);
    const value = finite(row?.value);
    const observedAt = clampTimestamp(row?.at, now);
    const key = playerKey(username);
    let source = normalizeResourceSource(row?.source);
    if (!source && String(row?.source || "").trim().toLowerCase() === "public") {
      const evidence = legacyProfileEvidence.get(key);
      if (evidence?.value === value && Math.abs(Number(evidence.at || 0) - observedAt) <= 5000) source = "public-profile";
    }
    if (!username || value === null || value < 0 || !source) return null;
    return { username, key, value, observedAt, source };
  }).filter(Boolean), (row) => `${row.key}:${Math.floor(row.observedAt / 60000)}`);
  resources = await monotonicResourceRows(env.DB, resources);
  const systems = safeArray(body?.systems, MAX_SYSTEMS).map((row) => systemForStorage(row, now)).filter(Boolean);
  const battles = (await Promise.all(safeArray(body?.battles, MAX_BATTLES).map((row) => normalizeBattle(row, now)))).filter(Boolean);
  const changeId = xp.length || resources.length || profiles.length ? await allocateChange(env.DB, now) : 0;

  const statements = [];
  for (const row of xp) statements.push(env.DB.prepare(`
    INSERT INTO xp_observations (player_key, observed_bucket, username, observed_at, source, activities_json, reporter_account, created_at, change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_key, observed_bucket) DO UPDATE SET
      username = excluded.username,
      observed_at = excluded.observed_at,
      source = excluded.source,
      activities_json = excluded.activities_json,
      reporter_account = excluded.reporter_account,
      created_at = excluded.created_at,
      change_id = excluded.change_id
    WHERE excluded.observed_at > xp_observations.observed_at
  `).bind(row.key, Math.floor(row.observedAt / 60000), row.username, row.observedAt, row.source, JSON.stringify(row.activities), accountId, now, changeId));
  for (const row of resources) statements.push(env.DB.prepare(`
    INSERT INTO resource_observations (player_key, observed_bucket, username, observed_at, value, source, reporter_account, created_at, change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_key, observed_bucket) DO UPDATE SET
      username = excluded.username,
      observed_at = excluded.observed_at,
      value = excluded.value,
      source = excluded.source,
      reporter_account = excluded.reporter_account,
      created_at = excluded.created_at,
      change_id = excluded.change_id
    WHERE excluded.observed_at > resource_observations.observed_at
  `).bind(row.key, Math.floor(row.observedAt / 60000), row.username, row.observedAt, row.value, row.source, accountId, now, changeId));
  for (const row of profiles) statements.push(env.DB.prepare(`
    INSERT INTO profile_snapshots (player_key, observed_bucket, username, observed_at, profile_json, reporter_account, created_at, change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_key, observed_bucket) DO UPDATE SET
      username = excluded.username,
      observed_at = excluded.observed_at,
      profile_json = excluded.profile_json,
      reporter_account = excluded.reporter_account,
      created_at = excluded.created_at,
      change_id = excluded.change_id
    WHERE excluded.observed_at > profile_snapshots.observed_at
  `).bind(playerKey(row.profile.username), Math.floor(row.profile.capturedAt / 60000), row.profile.username, row.profile.capturedAt, row.encoded, accountId, now, changeId));
  for (const group of playerEdges(xp, (row) => row.key, (row) => row.observedAt)) statements.push(env.DB.prepare(`
    INSERT INTO xp_player_state
      (player_key, username, first_at, first_activities_json, latest_at, latest_activities_json, updated_at, change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_key) DO UPDATE SET
      username = CASE WHEN excluded.latest_at >= xp_player_state.latest_at THEN excluded.username ELSE xp_player_state.username END,
      first_activities_json = CASE WHEN excluded.first_at < xp_player_state.first_at THEN excluded.first_activities_json ELSE xp_player_state.first_activities_json END,
      first_at = MIN(xp_player_state.first_at, excluded.first_at),
      latest_activities_json = CASE WHEN excluded.latest_at >= xp_player_state.latest_at THEN excluded.latest_activities_json ELSE xp_player_state.latest_activities_json END,
      latest_at = MAX(xp_player_state.latest_at, excluded.latest_at),
      updated_at = excluded.updated_at,
      change_id = excluded.change_id
  `).bind(group.key, group.latest.username, group.first.observedAt, JSON.stringify(group.first.activities), group.latest.observedAt, JSON.stringify(group.latest.activities), now, changeId));
  for (const group of playerEdges(resources, (row) => row.key, (row) => row.observedAt)) statements.push(env.DB.prepare(`
    INSERT INTO resource_player_state
      (player_key, username, first_at, first_value, latest_at, latest_value, updated_at, change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_key) DO UPDATE SET
      username = CASE WHEN excluded.latest_at >= resource_player_state.latest_at THEN excluded.username ELSE resource_player_state.username END,
      first_value = CASE WHEN excluded.first_at < resource_player_state.first_at THEN excluded.first_value ELSE resource_player_state.first_value END,
      first_at = MIN(resource_player_state.first_at, excluded.first_at),
      latest_value = CASE WHEN excluded.latest_at >= resource_player_state.latest_at THEN excluded.latest_value ELSE resource_player_state.latest_value END,
      latest_at = MAX(resource_player_state.latest_at, excluded.latest_at),
      updated_at = excluded.updated_at,
      change_id = excluded.change_id
  `).bind(group.key, group.latest.username, group.first.observedAt, group.first.value, group.latest.observedAt, group.latest.value, now, changeId));
  for (const group of playerEdges(profiles, (row) => playerKey(row.profile.username), (row) => row.profile.capturedAt)) statements.push(env.DB.prepare(`
    INSERT INTO latest_profiles (player_key, username, observed_at, profile_json, updated_at, change_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_key) DO UPDATE SET
      username = excluded.username,
      observed_at = excluded.observed_at,
      profile_json = excluded.profile_json,
      updated_at = excluded.updated_at,
      change_id = excluded.change_id
    WHERE excluded.observed_at > latest_profiles.observed_at
  `).bind(group.key, group.latest.profile.username, group.latest.profile.capturedAt, group.latest.encoded, now, changeId));
  for (const row of systems) statements.push(env.DB.prepare(`
    INSERT INTO account_systems
      (account_id, system_key, x, y, z, first_seen_at, perfect, system_json, node_observed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, system_key) DO UPDATE SET
      x = excluded.x,
      y = excluded.y,
      z = excluded.z,
      first_seen_at = MIN(account_systems.first_seen_at, excluded.first_seen_at),
      perfect = CASE WHEN excluded.node_observed_at > account_systems.node_observed_at THEN excluded.perfect ELSE account_systems.perfect END,
      system_json = CASE WHEN excluded.node_observed_at > account_systems.node_observed_at THEN excluded.system_json ELSE account_systems.system_json END,
      node_observed_at = MAX(account_systems.node_observed_at, excluded.node_observed_at),
      updated_at = excluded.updated_at
    WHERE excluded.first_seen_at < account_systems.first_seen_at
       OR excluded.node_observed_at > account_systems.node_observed_at
  `).bind(accountId, row.key, row.x, row.y, row.z, row.firstSeenAt, row.perfect, row.encoded, row.nodeObservedAt, now));
  if (statements.length) await batchAll(env.DB, statements);

  let acceptedBattles = 0;
  for (const row of battles) {
    const inserted = await env.DB.prepare(`
      INSERT OR IGNORE INTO battle_observations
        (battle_key, kind, observed_at, rounds, participant_count, winner_side, battle_json, reporter_account, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.key,
      row.battle.k,
      row.battle.o,
      row.battle.r,
      row.battle.p.length,
      row.battle.w,
      row.encoded,
      accountId,
      now,
    ).run();
    if (Number(inserted?.meta?.changes || 0) > 0) {
      acceptedBattles += 1;
      await updateBattleModel(env.DB, row.battle.k, battleTraining(row), now);
    }
  }

  const favorites = parseJson(account.favorites_json || "[]", []);
  const requested = new Set([ownerKey, ...favorites, ...safeArray(body?.players, MAX_PLAYERS).map(playerKey)]);
  const players = [...requested].filter(Boolean).slice(0, MAX_PLAYERS);
  const historyDays = Math.max(MIN_HISTORY_DAYS, Math.min(MAX_HISTORY_DAYS, Math.floor(finite(body?.historyDays) || MAX_HISTORY_DAYS)));
  const summarySince = Math.max(0, Math.floor(finite(body?.summarySince) || 0));
  const historySince = Math.max(0, Math.floor(finite(body?.historySince) || 0));
  const historyRequested = new Set(safeArray(body?.historyPlayers, 5).map(playerKey).filter(Boolean));
  const historyPlayers = players.filter((key) => historyRequested.has(key)).slice(0, 5);
  const ceiling = await changeCeiling(env.DB);
  const summaries = await readSummaryData(env.DB, players, summarySince, ceiling);
  const history = await readDetailedHistory(env.DB, historyPlayers, now - historyDays * 86400000, historySince, ceiling);
  const systemsSince = Math.max(0, Math.floor(finite(body?.systemsSince) || 0));
  const systemRows = await env.DB.prepare(`
    SELECT system_key, x, y, z, first_seen_at, perfect, system_json, node_observed_at, updated_at
    FROM account_systems
    WHERE account_id = ? AND updated_at > ?
    ORDER BY updated_at ASC, system_key ASC
    LIMIT ?
  `).bind(accountId, systemsSince, MAX_SYSTEMS_RETURN + 1).all();
  const rawSystems = systemRows.results || [];
  const systemsMore = rawSystems.length > MAX_SYSTEMS_RETURN;
  const returnedSystems = rawSystems.slice(0, MAX_SYSTEMS_RETURN);
  const systemsCursor = returnedSystems.length
    ? Math.max(...returnedSystems.map((row) => Number(row.updated_at || 0)))
    : systemsSince;
  const battleModel = await readBattleModels(env.DB);

  return json({
    ok: true,
    accepted: xp.length + resources.length + profiles.length + systems.length + acceptedBattles,
    acceptedBattles,
    favorites,
    favoritesUpdatedAt: Number(account.favorites_updated_at || 0),
    profiles: summaries.profiles,
    summaries: { xp: summaries.xp, resources: summaries.resources },
    summaryCursor: summaries.cursor,
    systems: returnedSystems.map((row) => {
      const perfect = Number(row.perfect || 0) === 1 ? parseJson(row.system_json, {}) : {};
      return {
        key: row.system_key,
        x: Number(row.x),
        y: Number(row.y),
        z: Number(row.z),
        firstSeenAt: Number(row.first_seen_at),
        id: String(perfect?.id || ""),
        name: String(perfect?.name || ""),
        nodes: Array.isArray(perfect?.nodes) ? perfect.nodes : [],
        nodeObservedAt: Number(row.node_observed_at || 0),
        updatedAt: Number(row.updated_at),
      };
    }),
    systemsCursor,
    systemsMore,
    battleModel,
    serverTime: now,
    ...history,
  });
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "stellar-odyssey-intel-sync", version: SERVICE_VERSION, steamLinking: true, databasePausedUntil });
    if (request.method === "POST" && url.pathname === "/v1/auth/steam/start") return startSteamDeviceLink(request, env);
    if (request.method === "POST" && url.pathname === "/v1/auth/steam/status") return steamDeviceStatus(request, env);
    if (request.method === "POST" && url.pathname === "/v1/auth/steam/revoke") return revokeSteamDevice(request, env);
    if (request.method === "POST" && url.pathname === "/v1/account/delete") {
      if (databasePausedUntil > Date.now()) return databaseLimitResponse();
      try {
        return await deleteSteamAccountData(request, env);
      } catch (error) {
        const message = String(error?.message || error);
        if (/D1_ERROR:.*(?:free tier daily|daily row read limit|daily row write limit)/i.test(message)) {
          databasePausedUntil = nextUtcReset();
          return databaseLimitResponse();
        }
        console.error("Cloud-account deletion failed", error);
        return json({ ok: false, error: "The shared database could not delete this cloud account." }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/auth/steam/start") return steamOpenIdStart(request, env);
    if (request.method === "GET" && url.pathname === "/auth/steam/callback") return steamOpenIdCallback(request, env);
    if (request.method === "POST" && url.pathname === "/v1/sync") {
      if (databasePausedUntil > Date.now()) return databaseLimitResponse();
      try {
        return await sync(request, env);
      } catch (error) {
        const message = String(error?.message || error);
        if (/D1_ERROR:.*(?:free tier daily|daily row read limit|daily row write limit)/i.test(message)) {
          databasePausedUntil = nextUtcReset();
          return databaseLimitResponse();
        }
        console.error("Sync request failed", error);
        return json({ ok: false, error: "The shared database could not complete this sync." }, 500);
      }
    }
    return json({ ok: false, error: "Not found" }, 404);
  },
  async scheduled(controller, env, context) {
    context.waitUntil(compactHistory(env.DB, controller.scheduledTime || Date.now()));
  },
};
