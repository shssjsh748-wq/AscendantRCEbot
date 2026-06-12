// events/koth/kothEvent.js
const fs = require("fs");
const path = require("path");
const {
  ContainerBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  SeparatorSpacingSize,
} = require("discord.js");

const { RCEEvent } = require("rce.js");
const { listServers } = require("./rce");
const { refreshLeaderboardHub } = require("./eventleaderboard");
const { readLinks } = require("./links");
const ROLES_PATH = path.join(__dirname, "roles.json");
const CLANS_PATH = path.join(__dirname, "clans.json");
const SPAWNS_PATH = path.join(__dirname, "kothspawns.json");
const ADV_PATH = path.join(__dirname, "kothadvanced.json");
const EVENTS_PATH = path.join(__dirname, "kothevents.json");
const EVENTHOMES_PATH = path.join(__dirname, "eventhomes.json");
const LEADERBOARD_PATH = path.join(__dirname, "eventleaderboards.json");

const ORANGE = 0xfaa61a;
const GREEN = 0x57f287;
const PANEL_BLUE = 0x95a5a6;
const WINNER_PURPLE = 0x8b5cf6;

const activeByMessageId = new Map();
const timersByKey = new Map();
const joinLocks = new Set();
const clanLocks = new Set();
const respawnWaiters = new Map();
const rfLocks = new Set();
const runningByServerId = new Map();
const pendingByServerId = new Map();
const winnerTimers = new Map();

const auxTimersByKey = new Map();
const zoneIntervalsByKey = new Map();
const timeoutTimersByKey = new Map();

const EVENT_TIMEOUT_MS = 20 * 60_000;
const KOTH_CHECK_INTERVAL_MS = 5_000;
const PRESTART_BARRICADE_MS = 10_000;
const PRESTART_KOTH_SAFE_MS = 2_000;
const POSTSTART_SPAWN_ARM_MS = 5_000;
const KOTH_EMPTY_GRACE_MS = 30_000;

const JOIN_CUTOFF_MS = 20_000;
const SPAWN_CONFIRM_DELAY_MS = 4_000;
const SPAWN_CONFIRM_RADIUS = 20;

const botKillMarks = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

function safeLower(s) {
  return String(s || "").trim().toLowerCase();
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function looksBad(resp) {
  const s = String(resp || "").toLowerCase();
  return (
    s.includes("unknown command") ||
    s.includes("not found") ||
    s.includes("error") ||
    s.includes("failed") ||
    s.includes("exception")
  );
}

function parsePrintPos(resp) {
  const t = String(resp ?? "");
  const m = t.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (!m) return null;

  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function footerNowText() {
  const d = new Date();
  const hh = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `Today at ${hh}`;
}

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content, embeds: [], components: [] });
    }
    return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {}
}

function buildOrangeErrorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(`## Error\n${message}`)
    .setFooter({ text: footerNowText() });
}

async function replyOrangeError(interaction, message) {
  const payload = { embeds: [buildOrangeErrorEmbed(message)], components: [] };
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch {}
}

function buildGreenSuccessEmbed({ gate, kitName, clanName }) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Joined KOTH!")
    .setDescription(`You've been placed at Gate ${gate} for clan **${clanName}**!`)
    .addFields(
      { name: "Gate", value: String(gate), inline: true },
      { name: "Kit", value: String(kitName || "KOTH"), inline: true },
      { name: "Clan", value: String(clanName || "Unknown Clan"), inline: true }
    )
    .setFooter({ text: footerNowText() });
}

function getRolesCfg() {
  return readJsonSafe(ROLES_PATH, {});
}

function isAdminOrOwner(member) {
  const cfg = getRolesCfg();
  const adminRoleId = cfg?.adminRoleId;
  const ownerRoleId = cfg?.ownerRoleId;

  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (adminRoleId && member?.roles?.cache?.has(adminRoleId)) return true;
  if (ownerRoleId && member?.roles?.cache?.has(ownerRoleId)) return true;
  return false;
}

function getLinksAll() {
  return readLinks();
}

function getLinkedGamertag(userId, guildId) {
  const data = getLinksAll();
  const a = data?.[guildId]?.[userId] || data?.[userId];
  if (!a) return null;
  if (typeof a === "string") return a;
  if (typeof a?.gamertag === "string") return a.gamertag;
  if (typeof a?.gt === "string") return a.gt;
  return null;
}

function getSpawnMap(guildId, serverId) {
  const all = readJsonSafe(SPAWNS_PATH, {});
  const spawns = all?.[guildId]?.[serverId]?.spawns;
  return spawns && typeof spawns === "object" ? spawns : {};
}

function getConfiguredSpawnsList(guildId, serverId) {
  const spawns = getSpawnMap(guildId, serverId);
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const p = spawns?.[i];
    if (!p) continue;
    out.push({ num: i, x: Number(p.x), y: Number(p.y), z: Number(p.z) });
  }
  return out;
}

function getSpawnCount(guildId, serverId) {
  return getConfiguredSpawnsList(guildId, serverId).length;
}

function getAdvanced(guildId, serverId) {
  const all = readJsonSafe(ADV_PATH, {});
  const a = all?.[guildId]?.[serverId];
  return a && typeof a === "object" ? a : {};
}

function getKothKitName(guildId, serverId) {
  const a = getAdvanced(guildId, serverId);
  return a?.kitName ? String(a.kitName).trim() : null;
}

function getRfFrequency(guildId, serverId) {
  const a = getAdvanced(guildId, serverId);
  return a?.rfFrequency ? String(a.rfFrequency).trim() : null;
}

function getServerDisplay(serverId) {
  const match = listServers().find((s) => s.identifier === serverId);
  return match?.displayName || match?.identifier || serverId;
}

function getClanForMember(guildId, serverId, member) {
  const all = readJsonSafe(CLANS_PATH, {});
  const byServer = all?.[guildId]?.[serverId];
  if (!byServer || typeof byServer !== "object") return null;

  const userId = member?.id;
  const entries = Object.values(byServer);

  for (const c of entries) {
    const roleId = String(c?.roleId || "");
    if (!roleId) continue;
    if (!Array.isArray(c?.members)) continue;
    if (!c.members.includes(userId)) continue;
    if (member?.roles?.cache?.has(roleId)) return { roleId, clan: c };
  }

  for (const c of entries) {
    const roleId = String(c?.roleId || "");
    if (!roleId) continue;
    if (!Array.isArray(c?.members)) continue;
    if (!c.members.includes(userId)) continue;
    return { roleId, clan: c };
  }

  return null;
}

function getClanByRoleId(guildId, serverId, clanRoleId) {
  const all = readJsonSafe(CLANS_PATH, {});
  const byServer = all?.[guildId]?.[serverId];
  if (!byServer || typeof byServer !== "object") return null;

  for (const clan of Object.values(byServer)) {
    if (String(clan?.roleId || "") === String(clanRoleId || "")) return clan;
  }

  return null;
}

function getClanDisplay(guildId, serverId, clanRoleId) {
  const clan = getClanByRoleId(guildId, serverId, clanRoleId);
  if (!clan) return "Unknown Clan";
  const name = String(clan.name || "Unknown Clan");
  const tag = String(clan.tag || "").trim();
  return tag ? `${name} [${tag}]` : name;
}

function getClanRoleMention(clanRoleId) {
  return `<@&${clanRoleId}>`;
}

function readEventsAll() {
  return readJsonSafe(EVENTS_PATH, {});
}

function writeEventState(state) {
  const all = readEventsAll();
  ensure(all, state.guildId);
  all[state.guildId][state.serverId] = { ...(all[state.guildId][state.serverId] || {}), ...state };
  writeJsonSafe(EVENTS_PATH, all);
}

function patchEvent(guildId, serverId, patch) {
  const all = readEventsAll();
  ensure(all, guildId);
  const cur = all[guildId][serverId] || {};
  all[guildId][serverId] = { ...cur, ...patch };
  writeJsonSafe(EVENTS_PATH, all);
}

function readLeaderboardsAll() {
  return readJsonSafe(LEADERBOARD_PATH, {});
}

function writeLeaderboardsAll(data) {
  writeJsonSafe(LEADERBOARD_PATH, data);
}

function ensureLeaderboardServer(all, guildId, serverId) {
  ensure(all, guildId, serverId);

  const entry = all[guildId][serverId];

  if (!entry.totals) entry.totals = {};
  if (!entry.totals.byClan) entry.totals.byClan = {};
  if (!Number.isFinite(Number(entry.totals.totalEventKills))) entry.totals.totalEventKills = 0;

  if (!entry.events) entry.events = {};
  for (const ev of ["KOTH", "NUKETOWN", "MAZE", "CAPTURE ZONE"]) {
    if (!entry.events[ev]) entry.events[ev] = {};
    if (!entry.events[ev].byClan) entry.events[ev].byClan = {};
  }

  return entry;
}

function ensureLeaderboardClan(serverEntry, eventName, clanRoleId) {
  if (!serverEntry.totals.byClan[clanRoleId]) {
    serverEntry.totals.byClan[clanRoleId] = { points: 0, kills: 0, wins: 0 };
  }

  if (!serverEntry.events[eventName].byClan[clanRoleId]) {
    serverEntry.events[eventName].byClan[clanRoleId] = { points: 0, kills: 0, wins: 0 };
  }

  return {
    total: serverEntry.totals.byClan[clanRoleId],
    event: serverEntry.events[eventName].byClan[clanRoleId],
  };
}

function clanKills(state, clanRoleId) {
  const users = Array.isArray(state.joinedByClan?.[clanRoleId]) ? state.joinedByClan[clanRoleId] : [];
  let sum = 0;
  for (const uid of users) sum += Number(state.killsByUser?.[uid] || 0);
  return sum;
}

function awardKothLeaderboard(state, winnerRoleId) {
  const all = readLeaderboardsAll();
  const serverEntry = ensureLeaderboardServer(all, state.guildId, state.serverId);

  let totalKillsAdded = 0;

  for (const roleId of Object.keys(state.joinedByClan || {})) {
    const joined = Array.isArray(state.joinedByClan[roleId]) ? state.joinedByClan[roleId] : [];
    if (!joined.length) continue;

    const stats = ensureLeaderboardClan(serverEntry, "KOTH", roleId);
    const kills = Number(clanKills(state, roleId) || 0);

    stats.total.kills += kills;
    stats.event.kills += kills;
    totalKillsAdded += kills;
  }

  const winnerStats = ensureLeaderboardClan(serverEntry, "KOTH", winnerRoleId);
  winnerStats.total.points += 1;
  winnerStats.total.wins += 1;
  winnerStats.event.points += 1;
  winnerStats.event.wins += 1;

  serverEntry.totals.totalEventKills += totalKillsAdded;
  serverEntry.updatedAt = Date.now();

  writeLeaderboardsAll(all);
}

function readClanHome(guildId, serverId, clanRoleId) {
  const all = readJsonSafe(EVENTHOMES_PATH, {});
  const h = all?.[guildId]?.[serverId]?.[clanRoleId]?.home;
  if (!h) return null;
  const x = Number(h.x);
  const y = Number(h.y);
  const z = Number(h.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function makeRespawnKey(serverId, playerName) {
  return `${String(serverId || "").trim()}::${safeLower(playerName)}`;
}

function waitForEnteredGame(serverId, playerName, timeoutMs = 120_000) {
  const key = makeRespawnKey(serverId, playerName);
  return new Promise((resolve, reject) => {
    const arr = respawnWaiters.get(key) || [];
    const entry = { resolve, reject, timeout: null };

    entry.timeout = setTimeout(() => {
      const cur = respawnWaiters.get(key) || [];
      const next = cur.filter((w) => w !== entry);
      if (next.length) respawnWaiters.set(key, next);
      else respawnWaiters.delete(key);
      reject(new Error("respawn-timeout"));
    }, timeoutMs);

    arr.push(entry);
    respawnWaiters.set(key, arr);
  });
}

function addAuxTimer(key, t) {
  const arr = auxTimersByKey.get(key) || [];
  arr.push(t);
  auxTimersByKey.set(key, arr);
}

function clearRuntimeTimers(key) {
  const main = timersByKey.get(key);
  if (main) clearTimeout(main);
  timersByKey.delete(key);

  const aux = auxTimersByKey.get(key) || [];
  for (const t of aux) clearTimeout(t);
  auxTimersByKey.delete(key);

  const interval = zoneIntervalsByKey.get(key);
  if (interval) clearInterval(interval);
  zoneIntervalsByKey.delete(key);

  const timeout = timeoutTimersByKey.get(key);
  if (timeout) clearTimeout(timeout);
  timeoutTimersByKey.delete(key);
}

function getSavedKothConfig(guildId, serverId) {
  const all = readJsonSafe(SPAWNS_PATH, {});
  const entry = all?.[guildId]?.[serverId];

  return {
    spawns: entry?.spawns && typeof entry.spawns === "object" ? entry.spawns : {},
    middlePoint: entry?.middlePoint && typeof entry.middlePoint === "object" ? entry.middlePoint : null,
  };
}

function parseCustomZoneInfo(resp) {
  const t = String(resp ?? "");

  const pos = t.match(/Position\s*\[\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\]/i);
  const size = t.match(/Size\s*\[\s*(-?\d+(?:\.\d+)?)\s*\]/i);

  if (!pos) return null;

  return {
    x: Number(pos[1]),
    y: Number(pos[2]),
    z: Number(pos[3]),
    size: size ? Number(size[1]) : 60,
  };
}

async function getKothZone(rce, state) {
  const live = await rce.sendCommand(state.serverId, `customzoneinfo "KOTH"`).catch(() => null);
  const parsed = parseCustomZoneInfo(live);
  if (parsed) return parsed;

  const saved = getSavedKothConfig(state.guildId, state.serverId);
  if (saved.middlePoint) {
    return {
      x: Number(saved.middlePoint.x),
      y: Number(saved.middlePoint.y),
      z: Number(saved.middlePoint.z),
      size: 60,
    };
  }

  return null;
}

function isInsideZone(pos, zone) {
  if (!pos || !zone) return false;
  return dist3(pos, zone) <= Number(zone.size || 60);
}

function getAliveUserIds(state) {
  const out = [];
  for (const roleId of Object.keys(state.aliveByClan || {})) {
    const arr = Array.isArray(state.aliveByClan[roleId]) ? state.aliveByClan[roleId] : [];
    for (const uid of arr) out.push(uid);
  }
  return out;
}

function isUserAlive(state, userId) {
  for (const roleId of Object.keys(state.aliveByClan || {})) {
    const arr = Array.isArray(state.aliveByClan[roleId]) ? state.aliveByClan[roleId] : [];
    if (arr.includes(userId)) return true;
  }
  return false;
}

function getJoinedClanCount(state) {
  return Object.keys(state.joinedByClan || {}).filter((roleId) => {
    const arr = Array.isArray(state.joinedByClan[roleId]) ? state.joinedByClan[roleId] : [];
    return arr.length > 0;
  }).length;
}

function getTakenGatesCount(state) {
  return Object.keys(state.clanSpawnMap || {}).filter((roleId) => {
    const users = Array.isArray(state.joinedByClan?.[roleId]) ? state.joinedByClan[roleId] : [];
    return users.length > 0;
  }).length;
}

function getTotalParticipants(state) {
  let total = 0;
  for (const roleId of Object.keys(state.joinedByClan || {})) {
    total += Array.isArray(state.joinedByClan[roleId]) ? state.joinedByClan[roleId].length : 0;
  }
  return total;
}

function getTotalKills(state) {
  let total = 0;
  for (const uid of Object.keys(state.killsByUser || {})) {
    total += Number(state.killsByUser[uid] || 0);
  }
  return total;
}

async function resetEventZones(rce, state) {
  const spawns = getConfiguredSpawnsList(state.guildId, state.serverId);

  await rce.sendCommand(state.serverId, `editcustomzone "KOTH" color (128.,0.,128.)`).catch(() => null);
  await rce.sendCommand(state.serverId, `editcustomzone "KOTH" "radiationdamage" 300.`).catch(() => null);

  for (const spawn of spawns) {
    // eslint-disable-next-line no-await-in-loop
    await rce.sendCommand(state.serverId, `editcustomzone "Spawn ${spawn.num}" color (143,237,143)`).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    await rce.sendCommand(state.serverId, `editcustomzone "Spawn ${spawn.num}" "radiationdamage" 0`).catch(() => null);
  }
}

function buildRedStatusPanel(title, body) {
  const c = new ContainerBuilder().setAccentColor(0x95a5a6);
  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        `### ${title}`,
        body,
      ].join("\n\n")
    )
  );
  return c;
}

function clanDeaths(state, clanRoleId) {
  const entered = Array.isArray(state.joinedByClan?.[clanRoleId]) ? state.joinedByClan[clanRoleId].length : 0;
  const alive = Array.isArray(state.aliveByClan?.[clanRoleId]) ? state.aliveByClan[clanRoleId].length : 0;
  return Math.max(0, entered - alive);
}

function getClanBestPlayer(state, clanRoleId) {
  const users = Array.isArray(state.joinedByClan?.[clanRoleId]) ? state.joinedByClan[clanRoleId] : [];
  let bestUserId = null;
  let bestKills = -1;

  for (const uid of users) {
    const kills = Number(state.killsByUser?.[uid] || 0);
    if (kills > bestKills) {
      bestKills = kills;
      bestUserId = uid;
    }
  }

  const gamertag = bestUserId
    ? ((state.joinedIgnByUser && state.joinedIgnByUser[bestUserId]) || getLinkedGamertag(bestUserId, state.guildId) || "Unknown")
    : "None";

  return { userId: bestUserId, gamertag, kills: Math.max(0, bestKills) };
}

function formatKD(kills, deaths) {
  if (kills <= 0 && deaths <= 0) return "0.00";
  if (deaths <= 0) return Number(kills || 0).toFixed(2);
  return (Number(kills || 0) / Number(deaths || 1)).toFixed(2);
}

function getParticipatingTeamLines(state) {
  const joinedByClan = state.joinedByClan || {};
  const order = Array.isArray(state.clanOrder) ? state.clanOrder : Object.keys(joinedByClan);
  const cap = Number(state.spawnCap || 0);

  const lines = [];
  for (const roleId of order) {
    const arr = Array.isArray(joinedByClan[roleId]) ? joinedByClan[roleId] : [];
    if (!arr.length) continue;
    lines.push(`${getClanRoleMention(roleId)} — ${arr.length}/${cap}`);
  }

  return lines.length ? lines : ["No clans entered yet."];
}
function getQueueEntriesForClan(state, clanRoleId) {
  const map = state.queueStatusByClan || {};
  const byClan = map[clanRoleId] || {};
  return Object.entries(byClan).map(([userId, entry]) => ({
    userId,
    gamertag: String(entry?.gamertag || getLinkedGamertag(userId, state.guildId) || "Unknown"),
    status: String(entry?.status || "confirmed"),
  }));
}

function getQueueCountForClan(state, clanRoleId) {
  const confirmed = Array.isArray(state.joinedByClan?.[clanRoleId]) ? state.joinedByClan[clanRoleId].length : 0;
  const pending = getQueueEntriesForClan(state, clanRoleId).filter((e) => e.status === "joining").length;
  return confirmed + pending;
}

function setQueueUserStatus(state, clanRoleId, userId, gamertag, status) {
  state.queueStatusByClan = state.queueStatusByClan || {};
  state.queueStatusByClan[clanRoleId] = state.queueStatusByClan[clanRoleId] || {};
  state.queueStatusByClan[clanRoleId][userId] = {
    gamertag: String(gamertag || "Unknown"),
    status: String(status || "joining"),
  };
}

function removeQueueUserStatus(state, clanRoleId, userId) {
  if (!state.queueStatusByClan?.[clanRoleId]?.[userId]) return;
  delete state.queueStatusByClan[clanRoleId][userId];
  if (!Object.keys(state.queueStatusByClan[clanRoleId]).length) {
    delete state.queueStatusByClan[clanRoleId];
  }
}
// Queue panel — only the bottom stats change after start/end, team list is frozen
function buildQueuePanel(state) {
  const c = new ContainerBuilder().setAccentColor(PANEL_BLUE);
  const unix = Math.floor(Number(state.startAt || 0) / 1000);
  const serverDisplay = state.serverDisplay || getServerDisplay(state.serverId);
  const order = Array.isArray(state.clanOrder) ? state.clanOrder : Object.keys(state.joinedByClan || {});

  const sections = [];

  for (const roleId of order) {
    const gate = Number(state.clanSpawnMap?.[roleId] || state.spawnReservations?.[roleId]?.spawnNum || 0) || "?";
    const clan = getClanByRoleId(state.guildId, state.serverId, roleId);
    const clanName = String(clan?.name || "Unknown Clan");

    const confirmedIds = Array.isArray(state.joinedByClan?.[roleId]) ? state.joinedByClan[roleId] : [];
    const confirmedSet = new Set(confirmedIds);
    const queueEntries = getQueueEntriesForClan(state, roleId);

    const lines = [];

    for (const uid of confirmedIds) {
      const gt = (state.joinedIgnByUser && state.joinedIgnByUser[uid]) || getLinkedGamertag(uid, state.guildId) || "Unknown";
      lines.push(`* :white_check_mark: ${gt}`);
    }

    for (const entry of queueEntries) {
      if (confirmedSet.has(entry.userId)) continue;
      if (entry.status === "joining") lines.push(`* :arrows_counterclockwise: ${entry.gamertag}`);
      else if (entry.status === "failed") lines.push(`* :x: ${entry.gamertag}`);
    }

    const count = getQueueCountForClan(state, roleId);

    sections.push(
      [
        `**Gate ${gate}**`,
        `> ### ${clanName} (${count}/${Number(state.spawnCap || 0)})`,
        lines.length ? lines.join("\n") : "* No players yet",
      ].join("\n")
    );
  }

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        `### King Of The Hill - ${serverDisplay}`,
       `Use \`/koth join\` - ${serverDisplay} to participate!`,
        sections.length ? sections.join("\n\n") : "No clans entered yet.",
      ].join("\n\n")
    )
  );

c.addTextDisplayComponents((t) =>
  t.setContent(`**Starts in**\n<t:${unix}:R>`)
);

  return c;
}

// Started panel — live stats, no separators between clans
function buildStartedPanel(state) {
  const c = new ContainerBuilder().setAccentColor(PANEL_BLUE);

  const serverDisplay = state.serverDisplay || getServerDisplay(state.serverId);
  const order = Array.isArray(state.clanOrder) ? state.clanOrder : Object.keys(state.joinedByClan || {});

  const teamBlocks = [];

  for (const roleId of order) {
    const entered = Array.isArray(state.joinedByClan?.[roleId]) ? state.joinedByClan[roleId] : [];
    if (!entered.length) continue;

    const clan = getClanByRoleId(state.guildId, state.serverId, roleId);
    const clanName = String(clan?.name || "Unknown Clan");
    const gate = Number(state.clanSpawnMap?.[roleId] || 0) || "?";
    const kills = clanKills(state, roleId);
    const deaths = clanDeaths(state, roleId);
    const kd = formatKD(kills, deaths);
    const best = getClanBestPlayer(state, roleId);

    teamBlocks.push(
      [
        `> ### ${clanName} (Gate ${gate})`,
        "> ‎",
        `Total Kills: ${kills} | Total Deaths: ${deaths} | K/D: ${kd}`,
        `Best Player: ${best.gamertag} (${best.kills} kills)`,
      ].join("\n")
    );
  }

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        `### King Of The Hill - ${serverDisplay}`,
        `KOTH Battle is ongoing on ${serverDisplay}!`,
        teamBlocks.length ? teamBlocks.join("\n\n") : "No teams entered.",
      ].join("\n\n")
    )
  );

  return c;
}

function buildWinnersPanel(state, winnerRoleId, mvpUserId, mvpKills) {
  const c = new ContainerBuilder().setAccentColor(0x95a5a6);
  const winnerClan = getClanDisplay(state.guildId, state.serverId, winnerRoleId);
  const serverDisplay = state.serverDisplay || getServerDisplay(state.serverId);
  const mvpGamertag = mvpUserId
    ? ((state.joinedIgnByUser && state.joinedIgnByUser[mvpUserId]) || getLinkedGamertag(mvpUserId, state.guildId) || "Unknown")
    : "None";

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        `### King Of The Hill - ${serverDisplay}`,
        `:tada: **${winnerClan}** wins the King Of The Hill event - They will be teleported back to there home **in 2 minutes**!`,
      ].join("\n")
    )
  );

  c.addTextDisplayComponents((t) =>
    t.setContent(`MVP - **${mvpGamertag}** (${mvpKills} Kills)`)
  );

  return c;
}

function buildPanelComponents(pingRoleId, container) {
  return [
    {
      type: 10,
      content: `<@&${pingRoleId}>`,
    },
    container.toJSON(),
  ];
}
function buildTextPanelComponents(topText, container) {
  return [
    {
      type: 10,
      content: String(topText || ""),
    },
    container.toJSON(),
  ];
}
async function postV2Panel(client, channelId, pingRoleId, container) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const okType = channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
  if (!okType) return null;

  return channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: buildPanelComponents(pingRoleId, container),
    allowedMentions: { roles: [pingRoleId] },
  }).catch((e) => {
    console.error("[KOTH] send panel failed:", e?.message || e);
    return null;
  });
}

async function postV2TextPanel(client, channelId, topText, container) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const okType = channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
  if (!okType) return null;

  return channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: buildTextPanelComponents(topText, container),
    allowedMentions: { parse: [] },
  }).catch((e) => {
    console.error("[KOTH] send panel failed:", e?.message || e);
    return null;
  });
}
async function editV2Message(client, channelId, messageId, pingRoleId, container) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return null;

  await msg.edit({
    flags: MessageFlags.IsComponentsV2,
    components: buildPanelComponents(pingRoleId, container),
    allowedMentions: { roles: [pingRoleId] },
  }).catch(() => {});
  return msg;
}

function joinClosedReason(state) {
  const now = Date.now();
  if (state.ended) return "Event ended.";
  if (state.started || now >= Number(state.startAt || 0)) return "Event already started.";
  const msLeft = Number(state.startAt || 0) - now;
  if (msLeft <= JOIN_CUTOFF_MS) return "❌ Too late to join this event.";
  return null;
}

function getOrReserveSpawn(state, clanRoleId, spawnsList) {
  state.spawnReservations = state.spawnReservations || {};

  const committed = Number(state.clanSpawnMap?.[clanRoleId] || 0);
  if (committed) {
    return spawnsList.find((s) => s.num === committed) || null;
  }

  const res = state.spawnReservations[clanRoleId];
  if (res && Number(res.exp || 0) > Date.now()) {
    const found = spawnsList.find((s) => s.num === Number(res.spawnNum));
    if (found) return found;
  }

  for (const rid of Object.keys(state.spawnReservations)) {
    if (Number(state.spawnReservations[rid]?.exp || 0) <= Date.now()) delete state.spawnReservations[rid];
  }

  const used = new Set(Object.values(state.clanSpawnMap || {}).map((n) => Number(n)));
  for (const rid of Object.keys(state.spawnReservations)) {
    used.add(Number(state.spawnReservations[rid]?.spawnNum || 0));
  }

  const pick = spawnsList.find((s) => !used.has(s.num));
  if (!pick) return null;

  state.spawnReservations[clanRoleId] = { spawnNum: pick.num, exp: Date.now() + 60_000 };
  return pick;
}

function commitClanSpawnIfNeeded(state, clanRoleId, spawnNum) {
  state.clanSpawnMap = state.clanSpawnMap || {};
  if (!state.clanSpawnMap[clanRoleId]) state.clanSpawnMap[clanRoleId] = Number(spawnNum);
  if (state.spawnReservations?.[clanRoleId]) delete state.spawnReservations[clanRoleId];
}

function cleanupClanIfEmpty(state, clanRoleId) {
  const arr = Array.isArray(state.joinedByClan?.[clanRoleId]) ? state.joinedByClan[clanRoleId] : [];
  if (arr.length) return;

  if (state.joinedByClan?.[clanRoleId]) delete state.joinedByClan[clanRoleId];
  if (state.clanSpawnMap?.[clanRoleId]) delete state.clanSpawnMap[clanRoleId];
  if (state.spawnReservations?.[clanRoleId]) delete state.spawnReservations[clanRoleId];
  if (Array.isArray(state.clanOrder)) state.clanOrder = state.clanOrder.filter((r) => r !== clanRoleId);
}

function rebuildIgnMap(state) {
  const map = {};
  const userToClan = {};

  for (const roleId of Object.keys(state.joinedByClan || {})) {
    const arr = Array.isArray(state.joinedByClan[roleId]) ? state.joinedByClan[roleId] : [];
    for (const uid of arr) {
      const gt = (state.joinedIgnByUser && state.joinedIgnByUser[uid]) || getLinkedGamertag(uid, state.guildId);
      if (gt) map[safeLower(gt)] = uid;
      userToClan[uid] = roleId;
    }
  }

  state.ignToUserId = map;
  state.userToClanRole = userToClan;
}

function initKillState(state) {
  state.killsByUser = state.killsByUser || {};
  state.aliveByClan = state.aliveByClan || {};
  state.deadUsers = state.deadUsers || [];

  for (const roleId of Object.keys(state.joinedByClan || {})) {
    const arr = Array.isArray(state.joinedByClan[roleId]) ? state.joinedByClan[roleId] : [];
    state.aliveByClan[roleId] = [...arr];
  }

  rebuildIgnMap(state);
  writeEventState(state);
}

function getAliveClans(state) {
  const out = [];
  for (const roleId of Object.keys(state.aliveByClan || {})) {
    const alive = Array.isArray(state.aliveByClan[roleId]) ? state.aliveByClan[roleId].length : 0;
    if (alive > 0) out.push(roleId);
  }
  return out;
}

function getMvp(state) {
  let bestUid = null;
  let bestKills = -1;

  for (const roleId of Object.keys(state.joinedByClan || {})) {
    const users = Array.isArray(state.joinedByClan[roleId]) ? state.joinedByClan[roleId] : [];
    for (const uid of users) {
      const k = Number(state.killsByUser?.[uid] || 0);
      if (k > bestKills) {
        bestKills = k;
        bestUid = uid;
      }
    }
  }

  if (!bestUid) return { userId: null, kills: 0 };
  return { userId: bestUid, kills: Math.max(0, bestKills) };
}

async function runRfSequence(rce, state) {
  const key = `${state.guildId}::${state.serverId}`;
  if (state.rfSequenceDone) return;
  if (rfLocks.has(key)) return;
  rfLocks.add(key);

  let removeScheduled = false;

  try {
    const freq = getRfFrequency(state.guildId, state.serverId);
    if (!freq) {
      state.rfSequenceDone = true;
      patchEvent(state.guildId, state.serverId, {
        rfSequenceDone: true,
        rfError: "no-frequency",
        rfDoneAt: Date.now(),
      });
      return;
    }

    const spawnCmd = `rf.spawnfakebroadcaster "${escapeQuotes(freq)}" "10000"`;
    const spawnResp = await rce.sendCommand(state.serverId, spawnCmd).catch((e) => String(e));
    console.log(`[KOTH RF] spawn resp (${state.serverId}):`, spawnResp);

    patchEvent(state.guildId, state.serverId, {
      rfFrequencyUsed: freq,
      rfSpawnCmd: spawnCmd,
      rfSpawnResp: String(spawnResp || "").slice(0, 500),
      rfSpawnedAt: Date.now(),
    });

    removeScheduled = true;

    setTimeout(async () => {
      try {
        const candidates = [
          `rf.removefakeboardcaster "${escapeQuotes(freq)} MHz"`,
          `rf.removefakeboardcaster "${escapeQuotes(freq)}"`,
          `rf.removefakebroadcaster "${escapeQuotes(freq)} MHz"`,
          `rf.removefakebroadcaster "${escapeQuotes(freq)}"`,
        ];

        let usedCmd = null;
        let lastResp = null;

        for (const cmd of candidates) {
          usedCmd = cmd;
          // eslint-disable-next-line no-await-in-loop
          lastResp = await rce.sendCommand(state.serverId, cmd).catch((e) => String(e));
          console.log(`[KOTH RF] remove resp (${state.serverId}):`, lastResp);
          if (!looksBad(lastResp)) break;
        }

        const ok = !looksBad(lastResp);
        state.rfSequenceDone = ok;

        patchEvent(state.guildId, state.serverId, {
          rfRemoveCmd: usedCmd,
          rfRemoveResp: String(lastResp || "").slice(0, 500),
          rfRemovedAt: Date.now(),
          rfSequenceDone: ok,
          rfDoneAt: Date.now(),
        });
      } finally {
        rfLocks.delete(key);
      }
    }, 15_000);
  } finally {
    if (!removeScheduled) rfLocks.delete(key);
  }
}

async function deleteBarricades(rce, serverId) {
  if (!rce || typeof rce.sendCommand !== "function") return;
  await rce.sendCommand(serverId, "entity.deleteentity barricade.cover.wood_double").catch(() => null);
}

async function cancelEvent(client, rce, state, title, body, reason) {
  if (state.ended) return;

  state.ended = true;
  state.endedAt = Date.now();
  state.endedReason = reason;

  writeEventState(state);

  const key = `${state.guildId}::${state.serverId}`;
  clearRuntimeTimers(key);

  runningByServerId.delete(state.serverId);
  pendingByServerId.delete(state.serverId);

  await deleteBarricades(rce, state.serverId);
  await resetEventZones(rce, state);

  if (state.messageId) {
    await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
  }

  const channel = await client.channels.fetch(state.channelId).catch(() => null);
if (channel) {
  await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: buildPanelComponents(
      state.pingRoleId,
      buildRedStatusPanel(title, body)
    ),
    allowedMentions: { roles: [state.pingRoleId] },
  }).catch(() => {});
}
}

async function handleParticipantOut(client, rce, state, playerName) {
  rebuildIgnMap(state);

  const victimUid = state.ignToUserId?.[safeLower(playerName)] || null;
  if (!victimUid) return false;

  const victimClan = state.userToClanRole?.[victimUid];
  if (!victimClan) return false;

  if (!state.started) {
    state.preStartDeadUsers = state.preStartDeadUsers || [];
    if (!state.preStartDeadUsers.includes(victimUid)) state.preStartDeadUsers.push(victimUid);

    state.joinedByClan[victimClan] = (state.joinedByClan[victimClan] || []).filter((u) => u !== victimUid);

    if (state.joinedIgnByUser?.[victimUid]) delete state.joinedIgnByUser[victimUid];
    if (state.killsByUser?.[victimUid] != null) delete state.killsByUser[victimUid];

    cleanupClanIfEmpty(state, victimClan);
    rebuildIgnMap(state);
    writeEventState(state);
    removeQueueUserStatus(state, victimClan, victimUid);

    if (state.messageId) {
      await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
    }

    return true;
  }

  const aliveArr = Array.isArray(state.aliveByClan?.[victimClan]) ? state.aliveByClan[victimClan] : [];
  if (!aliveArr.includes(victimUid)) return false;

  state.aliveByClan[victimClan] = aliveArr.filter((u) => u !== victimUid);
  state.deadUsers = state.deadUsers || [];
  if (!state.deadUsers.includes(victimUid)) state.deadUsers.push(victimUid);

  writeEventState(state);

  if (state.startedMessageId) {
    await editV2Message(client, state.channelId, state.startedMessageId, state.pingRoleId, buildStartedPanel(state));
  }

  const aliveClans = getAliveClans(state);
  if (getJoinedClanCount(state) >= 2 && aliveClans.length === 1) {
    await endEvent(client, rce, state, aliveClans[0]);
  }

  return true;
}

async function checkKothPopulation(client, rce, state) {
  if (!state.started || state.ended) return;
  if (Date.now() < Number(state.startedAt || 0) + KOTH_EMPTY_GRACE_MS) return;

  const aliveUsers = getAliveUserIds(state);
  if (!aliveUsers.length) {
    await cancelEvent(client, rce, state, "KOTH Event Cancelled", "Nobody found in event so event cancelling.", "no-players");
    return;
  }

  const zone = await getKothZone(rce, state);
  if (!zone) return;

  let anyoneInside = false;

  for (const uid of aliveUsers) {
    const gt = (state.joinedIgnByUser && state.joinedIgnByUser[uid]) || getLinkedGamertag(uid, state.guildId);
    if (!gt) continue;

    // eslint-disable-next-line no-await-in-loop
    const posResp = await rce.sendCommand(state.serverId, `printpos "${escapeQuotes(gt)}"`).catch(() => null);
    const pos = parsePrintPos(posResp);

    if (pos && isInsideZone(pos, zone)) {
      anyoneInside = true;
      break;
    }
  }

  if (!anyoneInside) {
    await cancelEvent(client, rce, state, "KOTH Event Cancelled", "Nobody found in event so event cancelling.", "empty-zone");
  }
}

function startKothZoneMonitor(client, rce, state) {
  const key = `${state.guildId}::${state.serverId}`;

  const old = zoneIntervalsByKey.get(key);
  if (old) clearInterval(old);

  const interval = setInterval(() => {
    checkKothPopulation(client, rce, state).catch(() => {});
  }, KOTH_CHECK_INTERVAL_MS);

  zoneIntervalsByKey.set(key, interval);
}

function scheduleEventTimeout(client, rce, state) {
  const key = `${state.guildId}::${state.serverId}`;

  const old = timeoutTimersByKey.get(key);
  if (old) clearTimeout(old);

  const t = setTimeout(() => {
    cancelEvent(client, rce, state, "KOTH Event Timed Out", "Event timed out.", "timeout").catch(() => {});
  }, EVENT_TIMEOUT_MS);

  timeoutTimersByKey.set(key, t);
}

function markBotKill(serverId, playerName, ms = 12_000) {
  const key = makeRespawnKey(serverId, playerName);
  botKillMarks.set(key, { exp: Date.now() + ms, remaining: 1 });
}

function shouldIgnoreAsBotKill(serverId, victimName, killerName) {
  const key = makeRespawnKey(serverId, victimName);
  const entry = botKillMarks.get(key);
  if (!entry) return false;

  if (Date.now() > Number(entry.exp || 0) || Number(entry.remaining || 0) <= 0) {
    botKillMarks.delete(key);
    return false;
  }

  const k = safeLower(killerName);
  const v = safeLower(victimName);
  const looksServer = !k || k === v || k.includes("server") || k.includes("unknown");

  if (looksServer) {
    entry.remaining -= 1;
    if (entry.remaining <= 0) botKillMarks.delete(key);
    else botKillMarks.set(key, entry);
    return true;
  }

  botKillMarks.delete(key);
  return false;
}

async function endEvent(client, rce, state, winnerRoleId, opts = {}) {
  if (state.ended) return;

  state.ended = true;
  state.endedAt = Date.now();
  state.winnerRoleId = winnerRoleId;

  const { userId: mvpUserId, kills: mvpKills } = getMvp(state);
  state.mvpUserId = mvpUserId;
  state.mvpKills = mvpKills;

  if (!state.leaderboardAwardedAt) {
    awardKothLeaderboard(state, winnerRoleId);
    state.leaderboardAwardedAt = Date.now();
    await refreshLeaderboardHub(client, state.guildId).catch(() => null);
  }

  writeEventState(state);

  const key = `${state.guildId}::${state.serverId}`;
  clearRuntimeTimers(key);

  runningByServerId.delete(state.serverId);
  pendingByServerId.delete(state.serverId);

  await deleteBarricades(rce, state.serverId);

  if (state.messageId) {
    await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
  }

  const backAtUnix = Math.floor((Date.now() + 120_000) / 1000);

  const channel = await client.channels.fetch(state.channelId).catch(() => null);
  if (channel) {
  await channel.send({
  flags: MessageFlags.IsComponentsV2,
  components: buildPanelComponents(
    winnerRoleId,
    buildWinnersPanel(state, winnerRoleId, mvpUserId, mvpKills)
  ),
  allowedMentions: { roles: [winnerRoleId] },
}).catch(() => {});
  }

  const oldWinner = winnerTimers.get(key);
  if (oldWinner) clearTimeout(oldWinner);

  const t = setTimeout(async () => {
    try {
      const home = readClanHome(state.guildId, state.serverId, winnerRoleId);

      if (home) {
        const teleportUserIds =
          Array.isArray(opts.teleportUserIds) && opts.teleportUserIds.length
            ? opts.teleportUserIds
            : (
                Array.isArray(state.aliveByClan?.[winnerRoleId]) && state.aliveByClan[winnerRoleId].length
                  ? state.aliveByClan[winnerRoleId]
                  : Array.isArray(state.joinedByClan?.[winnerRoleId])
                    ? state.joinedByClan[winnerRoleId]
                    : []
              );

        for (const uid of teleportUserIds) {
          const gt = (state.joinedIgnByUser && state.joinedIgnByUser[uid]) || getLinkedGamertag(uid, state.guildId);
          if (!gt) continue;

          // eslint-disable-next-line no-await-in-loop
          await rce.sendCommand(
            state.serverId,
            `global.teleportpos ${home.x},${home.y},${home.z} "${escapeQuotes(gt)}"`
          ).catch(() => null);
        }

        patchEvent(state.guildId, state.serverId, { homeTeleportedAt: Date.now() });
      } else {
        patchEvent(state.guildId, state.serverId, { homeTeleportError: "no-home", homeTeleportedAt: Date.now() });
      }

      await resetEventZones(rce, state);
    } finally {
      winnerTimers.delete(key);
    }
  }, 120_000);

  winnerTimers.set(key, t);
}

function scheduleStart(client, rce, state) {
  const key = `${state.guildId}::${state.serverId}`;
  clearRuntimeTimers(key);

  const ms = Math.max(0, Number(state.startAt || 0) - Date.now());

  if (ms > PRESTART_BARRICADE_MS) {
    addAuxTimer(
      key,
      setTimeout(() => {
        deleteBarricades(rce, state.serverId).catch(() => {});
      }, ms - PRESTART_BARRICADE_MS)
    );
  }

  if (ms > PRESTART_KOTH_SAFE_MS) {
    addAuxTimer(
      key,
      setTimeout(() => {
        rce.sendCommand(state.serverId, `editcustomzone "KOTH" "radiationdamage" 0`).catch(() => null);
      }, ms - PRESTART_KOTH_SAFE_MS)
    );
  }

  const t = setTimeout(async () => {
    try {
      state.started = true;
      state.startedAt = Date.now();
      state.killsByUser = state.killsByUser || {};
      state.rfSequenceDone = Boolean(state.rfSequenceDone);

      writeEventState(state);

      pendingByServerId.delete(state.serverId);

      if (state.messageId) {
        await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
      }

      initKillState(state);

    const startedTopText = `:trophy: **King Of The Hill** has started on **${state.serverDisplay || getServerDisplay(state.serverId)}**`;

const startedMsg = await postV2TextPanel(
  client,
  state.channelId,
  startedTopText,
  buildStartedPanel(state)
);

      runningByServerId.set(state.serverId, state);

      addAuxTimer(
        key,
        setTimeout(async () => {
          const spawns = getConfiguredSpawnsList(state.guildId, state.serverId);

          for (const spawn of spawns) {
            // eslint-disable-next-line no-await-in-loop
            await rce.sendCommand(state.serverId, `editcustomzone "Spawn ${spawn.num}" color (220,40,40)`).catch(() => null);
            // eslint-disable-next-line no-await-in-loop
            await rce.sendCommand(state.serverId, `editcustomzone "Spawn ${spawn.num}" "radiationdamage" 300`).catch(() => null);
          }
        }, POSTSTART_SPAWN_ARM_MS)
      );

      startKothZoneMonitor(client, rce, state);
      scheduleEventTimeout(client, rce, state);

      if (rce && typeof rce.sendCommand === "function") {
        await runRfSequence(rce, state);
      }
    } catch {}
  }, ms);

  timersByKey.set(key, t);
}

module.exports = {
  name: "kothevent",

  init(client, rce) {
    readJsonSafe(EVENTS_PATH, {});
    readJsonSafe(SPAWNS_PATH, {});
    readJsonSafe(ADV_PATH, {});
    readJsonSafe(CLANS_PATH, {});
    readJsonSafe(ROLES_PATH, {});
    readJsonSafe(EVENTHOMES_PATH, {});
    readJsonSafe(LEADERBOARD_PATH, {});

    if (rce && typeof rce.on === "function") {
      rce.on(RCEEvent.PlayerRespawned, async (payload) => {
        try {
          const serverId = String(payload?.server?.identifier || "").trim();
          const playerName = String(payload?.player?.ign || payload?.player?.name || "").trim();
          if (!serverId || !playerName) return;

          const key = makeRespawnKey(serverId, playerName);
          const waiters = respawnWaiters.get(key);
          if (waiters?.length) {
            respawnWaiters.delete(key);
            for (const w of waiters) {
              clearTimeout(w.timeout);
              w.resolve({ serverId, playerName });
            }
          }

          const state = runningByServerId.get(serverId);
          if (!state || state.ended) return;

          await handleParticipantOut(client, rce, state, playerName);
        } catch {}
      });

      rce.on(RCEEvent.PlayerSuicide, async (payload) => {
        try {
          const serverId = String(payload?.server?.identifier || "").trim();
          const playerName = String(payload?.player?.ign || payload?.player?.name || "").trim();
          if (!serverId || !playerName) return;

          const state = runningByServerId.get(serverId) || pendingByServerId.get(serverId);
          if (!state || state.ended) return;

          await handleParticipantOut(client, rce, state, playerName);
        } catch {}
      });

      rce.on(RCEEvent.PlayerLeft, async (payload) => {
        try {
          const serverId = String(payload?.server?.identifier || "").trim();
          const playerName = String(payload?.player?.ign || payload?.player?.name || "").trim();
          if (!serverId || !playerName) return;

          const state = runningByServerId.get(serverId) || pendingByServerId.get(serverId);
          if (!state || state.ended) return;

          const removed = await handleParticipantOut(client, rce, state, playerName);
          if (removed) {
            await rce.sendCommand(serverId, `global.killplayer "${escapeQuotes(playerName)}"`).catch(() => null);
          }
        } catch {}
      });

      rce.on(RCEEvent.PlayerKill, async (payload) => {
        try {
          const serverId = String(payload?.server?.identifier || "").trim();
          const killerName = String(payload?.killer?.name || "").trim();
          const victimName = String(payload?.victim?.name || "").trim();
          if (!serverId || !victimName) return;

          const state = runningByServerId.get(serverId) || pendingByServerId.get(serverId);
          if (!state || state.ended) return;

          rebuildIgnMap(state);

          const victimUid = state.ignToUserId?.[safeLower(victimName)] || null;
          if (!victimUid) return;

          const victimClan = state.userToClanRole?.[victimUid];
          if (!victimClan) return;

          if (!state.started && shouldIgnoreAsBotKill(serverId, victimName, killerName)) return;

          const killerUid = killerName ? state.ignToUserId?.[safeLower(killerName)] || null : null;
          let killerGetsCredit = false;

          if (!state.started) {
            killerGetsCredit = Boolean(killerUid && state.userToClanRole?.[killerUid] && killerUid !== victimUid);
          } else {
            killerGetsCredit = Boolean(killerUid && killerUid !== victimUid && isUserAlive(state, killerUid));
          }

          if (killerGetsCredit) {
            state.killsByUser = state.killsByUser || {};
            state.killsByUser[killerUid] = Number(state.killsByUser[killerUid] || 0) + 1;
          }

          await handleParticipantOut(client, rce, state, victimName);
        } catch {}
      });
    }

    const all = readEventsAll();
    for (const guildId of Object.keys(all || {})) {
      for (const serverId of Object.keys(all[guildId] || {})) {
        const st = all[guildId][serverId];
        if (!st || typeof st !== "object") continue;

        if (!st.serverDisplay) st.serverDisplay = getServerDisplay(serverId);
        if (st.messageId) activeByMessageId.set(st.messageId, st);

        if (!st.started && !st.ended) {
          pendingByServerId.set(serverId, st);
          rebuildIgnMap(st);

          if (st.messageId && st.channelId) {
            if (Number(st.startAt || 0) > Date.now()) scheduleStart(client, rce, st);
            else {
              st.startAt = Date.now();
              scheduleStart(client, rce, st);
            }
          }
        }

        if (st.started && !st.ended) {
          st.aliveByClan = st.aliveByClan || {};
          st.killsByUser = st.killsByUser || {};
          rebuildIgnMap(st);
          runningByServerId.set(serverId, st);
          pendingByServerId.delete(serverId);

          if (!st.rfSequenceDone && rce && typeof rce.sendCommand === "function") {
            runRfSequence(rce, st);
          }
        }
      }
    }

    client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const q = String(focused.value || "").toLowerCase().trim();
        const servers = listServers();
        const choices = servers
          .map((s) => ({
            name: (s.displayName || s.identifier).slice(0, 100),
            value: s.identifier,
          }))
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 25);

        if (interaction.commandName === "event-koth") {
          const sub = interaction.options.getSubcommand(false);
          if (sub !== "start" && sub !== "force-end") return;
          return interaction.respond(choices).catch(() => {});
        }

        if (interaction.commandName === "koth") {
          const sub = interaction.options.getSubcommand(false);
          if (sub !== "join") return;
          return interaction.respond(choices).catch(() => {});
        }

        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "event-koth") {
        if (!interaction.inGuild()) return replyEphemeral(interaction, "Use this in a server.");

        const sub = interaction.options.getSubcommand();

        if (sub === "start") {
          if (!isAdminOrOwner(interaction.member)) return replyEphemeral(interaction, "No permission.");

          const serverId = interaction.options.getString("server", true);
          const pingRole = interaction.options.getRole("pingrole", true);
          const channel = interaction.options.getChannel("channel", true);
          const minutes = interaction.options.getInteger("time", true);

          const serverExists = listServers().some((s) => s.identifier === serverId);
          if (!serverExists) return replyEphemeral(interaction, "Server not found.");

          const okChan =
            channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
          if (!okChan) return replyEphemeral(interaction, "Pick a text/announcement channel.");

          const spawnCap = getSpawnCount(interaction.guildId, serverId);
          if (!spawnCap) return replyEphemeral(interaction, "No KOTH spawns configured for this server.");

          const existing = readEventsAll()?.[interaction.guildId]?.[serverId];
          if (existing && !existing.started && !existing.ended) {
            return replyEphemeral(interaction, "A KOTH event is already pending for this server.");
          }

          await replyEphemeral(interaction, "Posting event panel...");

          const kitName = getKothKitName(interaction.guildId, serverId) || "KOTH";

          const state = {
            guildId: interaction.guildId,
            serverId,
            serverDisplay: getServerDisplay(serverId),
            channelId: channel.id,
            pingRoleId: pingRole.id,
            startAt: Date.now() + Math.max(0, minutes) * 60_000,
            kitName,
            spawnCap,

            started: false,
            ended: false,

            joinedByClan: {},
            joinedIgnByUser: {},
            preStartDeadUsers: [],

            queueStatusByClan: {},
            spawnReservations: {},

            clanSpawnMap: {},
            clanOrder: [],

            killsByUser: {},
            aliveByClan: {},
            deadUsers: [],

            createdAt: Date.now(),
            createdBy: interaction.user.id,

            messageId: null,
            startedMessageId: null,
            rfSequenceDone: false,
          };

          const msg = await postV2Panel(client, state.channelId, state.pingRoleId, buildQueuePanel(state));
          if (!msg?.id) return replyEphemeral(interaction, "Failed to send panel.");

          state.messageId = msg.id;
          activeByMessageId.set(msg.id, state);
          pendingByServerId.set(serverId, state);
          writeEventState(state);
          scheduleStart(client, rce, state);

          return replyEphemeral(interaction, "✅ Posted.");
        }

        if (sub === "force-end") {
          if (!isAdminOrOwner(interaction.member)) return replyEphemeral(interaction, "No permission.");

          const serverId = interaction.options.getString("server", true);
          const clanRole = interaction.options.getRole("clan", true);

          const state = runningByServerId.get(serverId) || pendingByServerId.get(serverId);
          if (!state || state.ended) return replyEphemeral(interaction, "No active KOTH event for that server.");

          const winnerRoleId = String(clanRole?.id || "");
          const hasTeam =
            Array.isArray(state.joinedByClan?.[winnerRoleId]) && state.joinedByClan[winnerRoleId].length > 0;

          if (!hasTeam) return replyEphemeral(interaction, "That clan has no confirmed players in this event.");

          await replyEphemeral(interaction, "Force ending event...");
          await endEvent(client, rce, state, winnerRoleId, {
            teleportUserIds: [...state.joinedByClan[winnerRoleId]],
          });
          return replyEphemeral(interaction, "✅ Forced winner posted.");
        }

        return;
      }

      if (interaction.commandName === "koth") {
        if (!interaction.inGuild()) return replyOrangeError(interaction, "Use this in a server.");

        const sub = interaction.options.getSubcommand();
        if (sub !== "join") return;

        const serverId = interaction.options.getString("server", true);
        const serverExists = listServers().some((s) => s.identifier === serverId);
        if (!serverExists) return replyOrangeError(interaction, "Server not found.");

        const state = pendingByServerId.get(serverId) || runningByServerId.get(serverId);
        if (!state || state.ended) return replyOrangeError(interaction, "No active KOTH event found for that server.");

        const reason0 = joinClosedReason(state);
        if (reason0) return replyOrangeError(interaction, reason0);

        const userLockKey = `${interaction.user.id}::${serverId}`;
        if (joinLocks.has(userLockKey)) return replyOrangeError(interaction, "Already processing your join...");
        joinLocks.add(userLockKey);

        let clanRoleId = null;
        let clanLockKey = null;

        try {
          const reason1 = joinClosedReason(state);
          if (reason1) return replyOrangeError(interaction, reason1);

          const playerName = getLinkedGamertag(interaction.user.id, state.guildId);
          if (!playerName) return replyOrangeError(interaction, "You must be linked to join KOTH.");

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member) return replyOrangeError(interaction, "Could not fetch member.");

          const found = getClanForMember(state.guildId, state.serverId, member);
          if (!found) {
            return replyOrangeError(interaction, "You must be in a clan to participate in KOTH's");
          }

          clanRoleId = found.roleId;
          clanLockKey = `${state.guildId}::${state.serverId}::${clanRoleId}`;
          if (clanLocks.has(clanLockKey)) return replyOrangeError(interaction, "Your clan is already joining... wait.");
          clanLocks.add(clanLockKey);

          state.preStartDeadUsers = state.preStartDeadUsers || [];
          if (state.preStartDeadUsers.includes(interaction.user.id)) {
            return replyOrangeError(interaction, "You died before the event started. You can't rejoin.");
          }

          const home = readClanHome(state.guildId, state.serverId, clanRoleId);
          if (!home) {
            return replyOrangeError(interaction, "Your clan hasnt set your event home! set it now with /event-sethome");
          }

          for (const rid of Object.keys(state.joinedByClan || {})) {
            const arr = Array.isArray(state.joinedByClan[rid]) ? state.joinedByClan[rid] : [];
            if (arr.includes(interaction.user.id)) {
              return replyOrangeError(interaction, "You already joined the event.");
            }
          }

          state.joinedByClan = state.joinedByClan || {};
          const clanCount = getQueueCountForClan(state, clanRoleId);
if (clanCount >= Number(state.spawnCap || 0)) {
  return replyOrangeError(interaction, "Your clan is full.");
}

          const reason2 = joinClosedReason(state);
          if (reason2) return replyOrangeError(interaction, reason2);

          const spawnsList = getConfiguredSpawnsList(state.guildId, state.serverId);
          const spawn = getOrReserveSpawn(state, clanRoleId, spawnsList);
          if (!spawn) return replyOrangeError(interaction, "Be faster! KOTH Is full, all gates are taken.");

          setQueueUserStatus(state, clanRoleId, interaction.user.id, playerName, "joining");
if (!Array.isArray(state.clanOrder)) state.clanOrder = [];
if (!state.clanOrder.includes(clanRoleId)) state.clanOrder.push(clanRoleId);
writeEventState(state);

if (state.messageId) {
  await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
}

          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          const setStatus = async (text) =>
            interaction.editReply({ content: text, embeds: [], components: [] }).catch(() => {});

          const reason3 = joinClosedReason(state);
          if (reason3) return setStatus(reason3);

          const kitName = state.kitName || getKothKitName(state.guildId, state.serverId) || "KOTH";
          const clanName = String(found.clan?.name || "Unknown Clan");

          await setStatus("Killing player...");
          const firstRespawnPromise = waitForEnteredGame(state.serverId, playerName, 120_000);

          markBotKill(state.serverId, playerName, 12_000);
          await rce.sendCommand(state.serverId, `global.killplayer "${escapeQuotes(playerName)}"`).catch(() => null);

          await setStatus("✅ Kill successful...");
          await sleep(1000);

          await setStatus("Checking for respawn...");
          try {
            await firstRespawnPromise;
          } catch {
            return setStatus("❌ Respawn not detected (timeout).");
          }

          await setStatus("✅ Respawn detected...");
          await sleep(2000);

          await setStatus("Teleporting in 3...");
          await sleep(1000);
          await setStatus("Teleporting in 2...");
          await sleep(1000);
          await setStatus("Teleporting in 1...");
          await sleep(1000);

          await setStatus("Teleporting...");
          await rce.sendCommand(
            state.serverId,
            `global.teleportpos ${spawn.x},${spawn.y},${spawn.z} "${escapeQuotes(playerName)}"`
          ).catch(() => null);

          await sleep(SPAWN_CONFIRM_DELAY_MS);

          const posResp = await rce.sendCommand(state.serverId, `printpos "${escapeQuotes(playerName)}"`).catch(() => null);
          const pos = parsePrintPos(posResp);
const d = pos ? dist3(pos, spawn) : NaN;

          const failQueueJoin = async (text) => {
  setQueueUserStatus(state, clanRoleId, interaction.user.id, playerName, "failed");
  writeEventState(state);

  if (state.messageId) {
    await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
  }

  setTimeout(async () => {
    removeQueueUserStatus(state, clanRoleId, interaction.user.id);
    if (state.spawnReservations?.[clanRoleId] && !Array.isArray(state.joinedByClan?.[clanRoleId])) {
      delete state.spawnReservations[clanRoleId];
    }
    writeEventState(state);

    if (state.messageId) {
      await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
    }
  }, 5000);

  return setStatus(text);
};
          if (!pos) return failQueueJoin("❌ Could not confirm your position. Not confirmed at event.");

if (!Number.isFinite(d) || d > SPAWN_CONFIRM_RADIUS) {
  return failQueueJoin("❌ Not at the event spawn. Not confirmed at event.");
}

          state.joinedByClan[clanRoleId] = Array.isArray(state.joinedByClan[clanRoleId]) ? state.joinedByClan[clanRoleId] : [];
          state.joinedIgnByUser = state.joinedIgnByUser || {};

          if (!state.joinedByClan[clanRoleId].includes(interaction.user.id)) {
            state.joinedByClan[clanRoleId].push(interaction.user.id);
          }

          state.joinedIgnByUser[interaction.user.id] = playerName;
setQueueUserStatus(state, clanRoleId, interaction.user.id, playerName, "confirmed");

          commitClanSpawnIfNeeded(state, clanRoleId, spawn.num);

          if (!Array.isArray(state.clanOrder)) state.clanOrder = [];
          if (!state.clanOrder.includes(clanRoleId)) state.clanOrder.push(clanRoleId);

          rebuildIgnMap(state);
          writeEventState(state);

          if (state.messageId) {
            await editV2Message(client, state.channelId, state.messageId, state.pingRoleId, buildQueuePanel(state));
          }

          await setStatus("✅ Confirmed at event.");
          await sleep(1000);

          await setStatus(`Giving **${kitName}** kit in 3...`);
          await sleep(1000);
          await setStatus(`Giving **${kitName}** kit in 2...`);
          await sleep(1000);
          await setStatus(`Giving **${kitName}** kit in 1...`);
          await sleep(1000);

          await rce.sendCommand(
            state.serverId,
            `kit givetoplayer "${escapeQuotes(kitName)}" "${escapeQuotes(playerName)}"`
          ).catch(() => null);

          await interaction.followUp({
            embeds: [buildGreenSuccessEmbed({ gate: spawn.num, kitName, clanName })],
            components: [],
            allowedMentions: { parse: [] },
          }).catch(() => {});

          setTimeout(() => {
            interaction.deleteReply().catch(() => {});
          }, 3000);

          return;
        } finally {
          joinLocks.delete(userLockKey);
          if (clanLockKey) clanLocks.delete(clanLockKey);
        }
      }
    });
  },
};
