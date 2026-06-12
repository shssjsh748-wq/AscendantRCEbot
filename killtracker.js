// trackers/killtracker.js
// Tracks player kills from RCEEvent.PlayerKill with:
// - Console log like: :LOG: 6298906 was killed by Jovan654321
// - No counting if killer + victim are in same Rust team (findplayerteam "killer")
// - Anti-farm: if killer kills same victim >10 times in 30min => block that pair for 2h
// - Tracks BOTH kills (killer) and deaths (victim) in kills.json
// - killbans.json = permanent blacklist by name (if killer OR victim is listed, ignore event)

const fs = require("fs");
const path = require("path");
const { RCEEvent } = require("rce.js");

const { readKills, writeKills } = require("./kills");
const KILLBANS_PATH = path.join(__dirname, "killbans.json"); // names-only blacklist
const KILLPAIRBANS_PATH = path.join(__dirname, "killpairbans.json"); // auto farm blocks (persist)

const WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const THRESHOLD = 10; // more than 10
const BAN_MS = 2 * 60 * 60 * 1000; // 2 hours

const teamCache = new Map(); // key -> { ts, membersLower:Set<string>|null }
const recentPairKills = new Map(); // key -> number[] timestamps
const blacklistCache = new Map(); // serverId -> { ts, set:Set<string> }

let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error("[killtracker] write error:", e));
  return writeChain;
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonSafe(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function safeName(s) {
  return String(s ?? "").trim();
}
function keyLower(s) {
  return safeName(s).toLowerCase();
}
function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

// ---- killbans.json (permanent name blacklist) ----
// killbans.json shape:
// { "EU 5X": ["Name1","Name2"], "default": ["Name3"], "test": ["TestPlayer"] }
function getBlacklistSet(serverId) {
  const cached = blacklistCache.get(serverId);
  if (cached && Date.now() - cached.ts < 10_000) return cached.set; // 10s cache

  const bans = readJsonSafe(KILLBANS_PATH, {});
  const list =
    (Array.isArray(bans?.[serverId]) && bans[serverId]) ||
    (Array.isArray(bans?.default) && bans.default) ||
    [];

  const set = new Set(list.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  blacklistCache.set(serverId, { ts: Date.now(), set });
  return set;
}

// ---- killpairbans.json (auto farm blocks) ----
// killpairbans.json shape:
// { "EU 5X": { "killer|victim": { killer, victim, hitsInWindow, createdAt, banUntil, reason } } }
function cleanupExpiredPairBans(pairBansAll) {
  const now = Date.now();
  for (const serverId of Object.keys(pairBansAll || {})) {
    const pairs = pairBansAll[serverId] || {};
    for (const pairKey of Object.keys(pairs)) {
      const b = pairs[pairKey];
      if (!b || Number(b.banUntil || 0) <= now) delete pairs[pairKey];
    }
    if (Object.keys(pairs).length === 0) delete pairBansAll[serverId];
    else pairBansAll[serverId] = pairs;
  }
}
function isPairBlocked(pairBansAll, serverId, pairKey) {
  const b = pairBansAll?.[serverId]?.[pairKey];
  return Boolean(b && Number(b.banUntil || 0) > Date.now());
}
function setPairBlock(pairBansAll, serverId, pairKey, killerName, victimName, hitsInWindow) {
  const s = ensure(pairBansAll, serverId);
  s[pairKey] = {
    killer: killerName,
    victim: victimName,
    hitsInWindow,
    createdAt: Date.now(),
    banUntil: Date.now() + BAN_MS,
    reason: "kill-farm",
  };
}

// ---- findplayerteam parsing ----
function parseFindPlayerTeamOutput(out) {
  // can contain real newlines OR literal "\n"
  const text = String(out ?? "").replace(/\\n/g, "\n");
  const m = text.match(/Team\s+(\d+)\s+member list:/i);
  if (!m) return null;

  const members = new Set();
  for (const line of text.split("\n")) {
    const mm = line.match(/^(.+?)\s+\[\d+\]/);
    if (mm && mm[1]) members.add(mm[1].trim().toLowerCase());
  }
  return { teamId: m[1], membersLower: members };
}

async function getTeamMembersLower(rce, serverId, playerName) {
  const pn = safeName(playerName);
  if (!pn) return null;

  const cacheKey = `${serverId}::${keyLower(pn)}`;
  const cached = teamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10_000) return cached.membersLower; // 10s cache

  if (!rce || typeof rce.sendCommand !== "function") return null;

  const resp = await rce.sendCommand(serverId, `findplayerteam "${pn}"`).catch(() => null);
  const parsed = parseFindPlayerTeamOutput(resp);
  const membersLower = parsed?.membersLower || null;

  teamCache.set(cacheKey, { ts: Date.now(), membersLower });
  return membersLower;
}

// ---- kills.json (kills + deaths) ----
function recordKillDeath(killsAll, serverId, killerName, victimName) {
  const s = ensure(killsAll, serverId);

  if (!s.players) s.players = {};
  if (!s.totalKills) s.totalKills = 0;
  if (!s.totalDeaths) s.totalDeaths = 0;
  if (!s.recent) s.recent = [];

  const kKey = keyLower(killerName);
  const vKey = keyLower(victimName);

  if (!s.players[kKey]) s.players[kKey] = { name: killerName, kills: 0, deaths: 0, lastKillAt: 0, lastDeathAt: 0 };
  if (!s.players[vKey]) s.players[vKey] = { name: victimName, kills: 0, deaths: 0, lastKillAt: 0, lastDeathAt: 0 };

  s.players[kKey].kills += 1;
  s.players[kKey].lastKillAt = Date.now();
  s.totalKills += 1;

  s.players[vKey].deaths += 1;
  s.players[vKey].lastDeathAt = Date.now();
  s.totalDeaths += 1;

  s.recent.push({ t: Date.now(), killer: killerName, victim: victimName });
  if (s.recent.length > 500) s.recent.splice(0, s.recent.length - 500);
}

module.exports = {
  name: "killtracker",

  init(client, rce) {
    console.log("[killtracker] init");
    if (!rce || typeof rce.on !== "function") {
      console.log("[killtracker] ERROR: rce manager not passed into init()");
      return;
    }

    // ensure files exist
   readKills();
    readJsonSafe(KILLBANS_PATH, { test: ["TestPlayer"] });
    readJsonSafe(KILLPAIRBANS_PATH, {});

    // cleanup pair bans on boot
    queueWrite(async () => {
      const pb = readJsonSafe(KILLPAIRBANS_PATH, {});
      cleanupExpiredPairBans(pb);
      writeJsonSafe(KILLPAIRBANS_PATH, pb);
    });

    console.log("[killtracker] listening for RCEEvent.PlayerKill");

    rce.on(RCEEvent.PlayerKill, async (payload) => {
      try {
        const serverId = safeName(payload?.server?.identifier || "unknown");

        const killer = payload?.killer;
        const victim = payload?.victim;

        const killerName = safeName(killer?.name);
        const victimName = safeName(victim?.name);
        const victimId = safeName(victim?.id);

        // ✅ always log (server-style)
        console.log(`:LOG: ${victimId || victimName || "UNKNOWN"} was killed by ${killerName || "UNKNOWN"}`);

      const isPlayer = (p) => String(p?.type || "").toLowerCase() === "player" || !!p?.player;

if (!isPlayer(killer) || !isPlayer(victim)) return;

if (!killerName || !victimName) return;
if (keyLower(killerName) === keyLower(victimName)) return;

        // permanent blacklist by name
        const blacklist = getBlacklistSet(serverId);
        if (blacklist.has(keyLower(killerName)) || blacklist.has(keyLower(victimName))) {
          console.log(`[killtracker] ignored (blacklist): ${killerName} -> ${victimName} (${serverId})`);
          return;
        }

        // same-team check (findplayerteam "killer")
        const membersLower = await getTeamMembersLower(rce, serverId, killerName);
        if (membersLower && membersLower.has(keyLower(victimName))) {
          console.log(`[killtracker] ignored (same team): ${killerName} -> ${victimName} (${serverId})`);
          return;
        }

        const pairKey = `${keyLower(killerName)}|${keyLower(victimName)}`;

        // pair block check (persisted)
        const pairBansAll = readJsonSafe(KILLPAIRBANS_PATH, {});
        if (isPairBlocked(pairBansAll, serverId, pairKey)) {
          console.log(`[killtracker] ignored (pair blocked): ${killerName} -> ${victimName} (${serverId})`);
          return;
        }

        // rolling window count (in-memory)
        const rkKey = `${serverId}::${pairKey}`;
        const now = Date.now();
        const arr = recentPairKills.get(rkKey) || [];
        const kept = arr.filter((t) => now - t <= WINDOW_MS);
        kept.push(now);
        recentPairKills.set(rkKey, kept);

        // 11th kill in 30 mins => ban pair for 2h, do NOT count this kill
        if (kept.length > THRESHOLD) {
          await queueWrite(async () => {
            const pb = readJsonSafe(KILLPAIRBANS_PATH, {});
            cleanupExpiredPairBans(pb);
            setPairBlock(pb, serverId, pairKey, killerName, victimName, kept.length);
            writeJsonSafe(KILLPAIRBANS_PATH, pb);
          });
          console.log(`[killtracker] farm block applied (2h): ${killerName} -> ${victimName} (${serverId})`);
          return;
        }

        // count kill + death
        await queueWrite(async () => {
          const kills = readKills();
recordKillDeath(kills, serverId, killerName, victimName);
writeKills(kills);
        });

        console.log(`[killtracker] counted: ${killerName} killed ${victimName} (${serverId})`);
      } catch (e) {
        console.error("[killtracker] error:", e?.message || e);
      }
    });
  },
};