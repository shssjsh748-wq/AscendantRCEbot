const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data", "../server_status.json");
const POLL_MS = 30000;

function read() {
  try {
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "{}", "utf8");
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function write(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

module.exports = {
  name: "serverstatus",

  init(client, rce) {
    const { listServers } = require("../rce");
    const data = read();
    let running = false;

    async function check(serverId) {
      const now = Date.now();

      try {
        console.log(`[STATUS] checking ${serverId}...`);
        const res = await rce.sendCommand(serverId, "serverinfo");

        const online = !!res;
        const prev = data[serverId]?.online;

        data[serverId] = {
          online,
          lastChecked: now,
          lastChange: prev === online ? (data[serverId]?.lastChange || now) : now,
          lastError: null,
        };

        write(data);

        if (prev !== online) {
          console.log(`[STATUS] ${serverId} -> ${online ? "ONLINE" : "OFFLINE"}`);
          client.emit("serverStatusChange", { identifier: serverId, online });
        }
      } catch (e) {
        const prev = data[serverId]?.online;

        data[serverId] = {
          online: false,
          lastChecked: now,
          lastChange: prev === false ? (data[serverId]?.lastChange || now) : now,
          lastError: String(e?.message || e || "Unknown error"),
        };

        write(data);

        console.log(`[STATUS] ${serverId} check failed: ${e?.message || e}`);

        if (prev !== false) {
          console.log(`[STATUS] ${serverId} -> OFFLINE`);
          client.emit("serverStatusChange", { identifier: serverId, online: false });
        }
      }
    }

    async function runAll() {
      if (running) return;
      running = true;

      try {
        const servers = listServers();
        for (const s of servers) {
          await check(s.identifier);
        }
      } finally {
        running = false;
      }
    }

    runAll();
    setInterval(runAll, POLL_MS);

    console.log("[Tracker] serverstatus loaded (15s polling)");
  },
};

