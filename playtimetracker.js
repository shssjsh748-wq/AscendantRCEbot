// trackers/playtimetracker.js
// Polls `users` every 1s per server.
// Output example:
// :LOG: <slot:"name">\n"Jovan654321"\n"Lil_Savage590077"\n2users\n
// Every time a player is seen online, they gain +1 second playtime.
//
// Writes to playtime.json (root):
// { [serverId]: { updatedAt, players: { [nameLower]: { name, seconds, lastSeenAt } } } }

const fs = require("fs");
const path = require("path");

const { listServers } = require("../rce"); 

const { readPlaytime, writePlaytime } = require("../shared/playtime");

let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error("[playtimetracker] write error:", e));
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
    console.error("[playtimetracker] writeJsonSafe failed:", file, e?.message || e);
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

function parseUsersOutput(resp) {
  const text = String(resp ?? "").replace(/\\n/g, "\n");

  // collect quoted names
  const names = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const v = safeName(m[1]);
    if (!v) continue;
    // ignore header slot:"name"
    if (v.toLowerCase() === "name") continue;
    names.push(v);
  }

  // de-dupe (case-insensitive)
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }

  return out;
}

module.exports = {
  name: "playtimetracker",

  init(client, rce) {
    console.log("[playtimetracker] init");

    // ensure file exists
   readPlaytime();
    // one lock per server so calls don't overlap
    const running = new Map(); // serverId -> bool

    setInterval(async () => {
      const servers = listServers();

      for (const s of servers) {
        const serverId = s.identifier;
        if (!serverId) continue;

        if (running.get(serverId)) continue;
        running.set(serverId, true);

        try {
          const resp = await rce.sendCommand(serverId, "users").catch(() => null);
          if (!resp) continue;

          const onlineNames = parseUsersOutput(resp);
          if (!onlineNames.length) continue;

          const now = Date.now();

          await queueWrite(async () => {
            const data = readPlaytime();
            const srv = ensure(data, serverId);
            if (!srv.players) srv.players = {};

            for (const name of onlineNames) {
              const k = keyLower(name);
              if (!srv.players[k]) srv.players[k] = { name, seconds: 0, lastSeenAt: 0 };
              srv.players[k].name = name; // keep latest casing
              srv.players[k].seconds = Number(srv.players[k].seconds || 0) + 1;
              srv.players[k].lastSeenAt = now;
            }

            srv.updatedAt = now;
            writePlaytime(data);
          });
        } catch (e) {
          console.error("[playtimetracker] tick error:", serverId, e?.message || e);
        } finally {
          running.set(serverId, false);
        }
      }
    }, 1000);
  },
};