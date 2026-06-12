// trackers/combatlock.js
// Adds players to a 60s combat lock when they get a PLAYER kill.
// Stores in combatlock.json (root) so other modules can read it.
//
// Data shape:
// {
//   "EU 5X": {
//     "jovan654321": { "name": "Jovan654321", "until": 1777777777777, "lastKillAt": 1777777777000 }
//   }
// }

const fs = require("fs");
const path = require("path");
const { RCEEvent } = require("rce.js");

const COMBATLOCK_PATH = path.join(__dirname, "..", "data", "combatlock.json");
const DURATION_MS = 60 * 1000;

let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error("[combatlock] write error:", e));
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
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[combatlock] writeJsonSafe failed:", file, e?.message || e);
  }
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

const isPlayer = (p) => String(p?.type || "").toLowerCase() === "player" || !!p?.player;

function cleanupExpired(all) {
  const now = Date.now();
  for (const serverId of Object.keys(all || {})) {
    const map = all[serverId] || {};
    for (const playerKey of Object.keys(map)) {
      const row = map[playerKey];
      if (!row || Number(row.until || 0) <= now) delete map[playerKey];
    }
    if (Object.keys(map).length === 0) delete all[serverId];
    else all[serverId] = map;
  }
}

module.exports = {
  name: "combatlock",

  init(client, rce) {
    console.log("[combatlock] init");

    // ensure file exists
    readJsonSafe(COMBATLOCK_PATH, {});

    // periodic cleanup
    setInterval(() => {
      queueWrite(async () => {
        const all = readJsonSafe(COMBATLOCK_PATH, {});
        cleanupExpired(all);
        writeJsonSafe(COMBATLOCK_PATH, all);
      });
    }, 10_000);

    rce.on(RCEEvent.PlayerKill, async (payload) => {
      try {
        const serverId = safeName(payload?.server?.identifier || "unknown");
        const killer = payload?.killer;
        const victim = payload?.victim;

        // only player vs player kills trigger combat lock
        if (!isPlayer(killer) || !isPlayer(victim)) return;

        const killerName = safeName(killer?.name || killer?.player?.name || killer?.id);
        if (!killerName) return;

        const now = Date.now();
        const until = now + DURATION_MS;

        await queueWrite(async () => {
          const all = readJsonSafe(COMBATLOCK_PATH, {});
          cleanupExpired(all);

          const srv = ensure(all, serverId);
          srv[keyLower(killerName)] = {
            name: killerName,
            until,
            lastKillAt: now,
          };

          writeJsonSafe(COMBATLOCK_PATH, all);
        });

        console.log(`[combatlock] ${killerName} locked until +60s (${serverId})`);
      } catch (e) {
        console.error("[combatlock] error:", e?.message || e);
      }
    });
  },
};