const fs = require("fs");
const path = require("path");

const { default: RCEManager, LogLevel, RCEIntent } = require("rce.js");

const SERVERS_PATH = path.join(__dirname, "data", "servers.json");

const rce = new RCEManager({
  logger: { level: LogLevel.Error },
});

// --- file helpers ---
function readServersFile() {
  try {
    if (!fs.existsSync(SERVERS_PATH)) fs.writeFileSync(SERVERS_PATH, "[]", "utf8");
    const raw = fs.readFileSync(SERVERS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[servers.json] read error:", err);
    return [];
  }
}

function writeServersFile(servers) {
  fs.writeFileSync(SERVERS_PATH, JSON.stringify(servers, null, 2), "utf8");
}

// identifier = display name (exact)
function makeIdentifier(displayName) {
  return String(displayName || "Unknown").trim();
}

function stripAngleTags(str) {
  return String(str || "").replace(/<[^>]*>/g, "").trim();
}

function parseServerInfoResponse(response) {
  const text = String(response ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const jsonSlice = text.slice(start, end + 1).replace(/\\n/g, "\n");
  try {
    return JSON.parse(jsonSlice);
  } catch {
    try {
      return JSON.parse(jsonSlice.replace(/\n/g, ""));
    } catch {
      return null;
    }
  }
}

// --- rce actions ---
async function addServerToRCE({ identifier, host, port, password }) {
  console.log("[RCE] addServer:", { identifier, host, port });

  const success = await rce.addServer({
    identifier,
    rcon: {
      host,
      port: Number(port),
      password,
    },
    state: [],
    intents: [RCEIntent.ServerInfo, RCEIntent.PlayerList, RCEIntent.PlayerKill],
    intentTimers: {
      [RCEIntent.ServerInfo]: 30_000,
      [RCEIntent.PlayerList]: 45_000,
    },
    reconnection: {
      enabled: true,
      interval: 10_000,
      maxAttempts: -1,
    },
  });

  console.log("[RCE] addServer success:", success);
  return success;
}

async function removeServerFromRCE(identifier) {
  console.log("[RCE] removeServer:", identifier);
  try {
    rce.removeServer(identifier);
    return true;
  } catch (e) {
    console.error("[RCE] removeServer error:", e);
    return false;
  }
}

async function testRCONConnection(identifier) {
  console.log("[RCE] test connection (serverinfo):", identifier);

  const response = await rce.sendCommand(identifier, "serverinfo");
  console.log("[RCE] serverinfo raw response:", response);

  const info = parseServerInfoResponse(response);
  if (!info) return { ok: false };

  const hostname = stripAngleTags(info.Hostname);
  const fps = info.Framerate ?? info.FPS ?? null;
  const entities = info.EntityCount ?? null;

  return { ok: true, hostname, fps, entities, info };
}

// --- persistence API used by modules ---
async function loadAllServers() {
  const servers = readServersFile();
  console.log(`[RCE] Loading ${servers.length} server(s) from servers.json...`);

  for (const s of servers) {
    try {
      await addServerToRCE(s);
    } catch (e) {
      console.error("[RCE] Failed loading server:", s?.identifier, e);
    }
  }

  console.log("[RCE] Done loading servers.");
  return servers;
}

function listServers() {
  return readServersFile();
}

function getServer(identifier) {
  return readServersFile().find((s) => s.identifier === identifier) || null;
}

function saveServer(newServer) {
  const servers = readServersFile();

  // prevent duplicates since identifier == displayName
  if (servers.some((s) => s.identifier === newServer.identifier)) {
    console.log("[servers.json] duplicate identifier, not saving:", newServer.identifier);
    return null;
  }

  servers.push(newServer);
  writeServersFile(servers);
  console.log("[servers.json] saved:", newServer.identifier);
  return newServer;
}

function updateServer(identifier, patch) {
  const servers = readServersFile();
  const idx = servers.findIndex((s) => s.identifier === identifier);
  if (idx === -1) return null;

  servers[idx] = { ...servers[idx], ...patch, identifier };
  writeServersFile(servers);
  console.log("[servers.json] updated:", identifier);
  return servers[idx];
}

function deleteServer(identifier) {
  const servers = readServersFile();
  const next = servers.filter((s) => s.identifier !== identifier);
  if (next.length === servers.length) return false;

  writeServersFile(next);
  console.log("[servers.json] deleted:", identifier);
  return true;
}

module.exports = {
  rce,

  // json helpers
  makeIdentifier,
  listServers,
  getServer,
  saveServer,
  updateServer,
  deleteServer,

  // rce helpers
  loadAllServers,
  addServerToRCE,
  removeServerFromRCE,
  testRCONConnection,
};