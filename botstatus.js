const fs = require("fs");
const path = require("path");
const { ActivityType } = require("discord.js");

const { listServers } = require("../rce");

const STATS_PATH = path.join(__dirname, "..", "data", "bot_stats.json");

let writeChain = Promise.resolve();

function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error("[botstatus] write error:", e));
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

function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function safeName(s) {
  return String(s ?? "").trim();
}

function lower(s) {
  return safeName(s).toLowerCase();
}

function parseUsersOutput(resp) {
  const text = String(resp ?? "").replace(/\\n/g, "\n");

  const names = [];
  const re = /"([^"]+)"/g;
  let m;

  while ((m = re.exec(text))) {
    const v = safeName(m[1]);
    if (!v) continue;
    if (v.toLowerCase() === "name") continue;
    names.push(v);
  }

  const seen = new Set();
  const out = [];

  for (const name of names) {
    const k = lower(name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }

  return out;
}

function compactNum(n) {
  const x = Number(n || 0);
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(x);
}

function getStats() {
  return readJsonSafe(STATS_PATH, {
    kitsClaimed: 0,
    players: {},
    updatedAt: 0,
  });
}

async function refreshPresence(client) {
  try {
    const stats = getStats();
    const kitsClaimed = Number(stats.kitsClaimed || 0);
    const uniquePlayers = Object.keys(stats.players || {}).length;

    const text = `${compactNum(kitsClaimed)} Kits Claimed | ${compactNum(uniquePlayers)} Players Logged`;

    if (!client.user) return;

    client.user.setPresence({
      activities: [
        {
          name: text,
          type: ActivityType.Watching,
        },
      ],
      status: "online",
    });
  } catch (e) {
    console.error("[botstatus] presence error:", e);
  }
}

module.exports = {
  name: "botstatus",

  init(client, rce) {
    

    readJsonSafe(STATS_PATH, {
      kitsClaimed: 0,
      players: {},
      updatedAt: 0,
    });

    const running = new Map();

    const tick = async () => {
      const servers = listServers();

      for (const s of servers) {
        const serverId = s?.identifier;
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
            const data = getStats();
            if (!data.players) data.players = {};

            for (const name of onlineNames) {
              const k = lower(name);
              if (!data.players[k]) {
                data.players[k] = {
                  name,
                  firstSeenAt: now,
                  lastSeenAt: now,
                  firstServerId: serverId,
                };
              } else {
                data.players[k].name = name;
                data.players[k].lastSeenAt = now;
              }
            }

            data.updatedAt = now;
            writeJsonSafe(STATS_PATH, data);
          });
        } catch (e) {
          console.error("[botstatus] tick error:", serverId, e?.message || e);
        } finally {
          running.set(serverId, false);
        }
      }

      await refreshPresence(client);
    };

    tick().catch(() => {});
    setInterval(() => {
      tick().catch(() => {});
    }, 20_000);
  },
};
