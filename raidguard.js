const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const { RCEEvent } = require("rce.js");

const { listServers } = require("../rce");

const CFG_PATH = path.join(__dirname, "data", "rg-config.json");
const BUBBLES_PATH = path.join(__dirname, "data", "rb-bubbles.json");
const LINKS_PATH = path.join(__dirname, "..", "data", "links.json");
const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");
const STATUS_PATH = path.join(__dirname, "..", "data", "server_status.json");

const COOLDOWN_MS = 10 * 60 * 1000;
const MIN_BUBBLE_DISTANCE = 120;
const TEAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const COMMAND_SPACING_MS = 40;
const STARTUP_GRACE_MS = 2 * 60 * 1000;
const AUTO_DELETE_OFFLINE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUBBLE_SIZE = 50;

const QUICKCHAT_TRIGGER = "d11_quick_chat_questions_slot_1";

const cooldowns = new Map();
const inFlight = new Set();
const activeBubbles = new Map();

let saving = false;
let saveQueued = false;
let watcherStarted = false;
let stateClient = null;
let stateRce = null;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVW";
const GRID_MIN_X = -1750;
const GRID_MAX_Z = 1749;
const GRID_CELL_X = (-76 - GRID_MIN_X) / 11;
const GRID_CELL_Z = (GRID_MAX_Z + 76) / 12;

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readCfg() {
  return readJsonSafe(CFG_PATH, {});
}

function writeCfg(data) {
  writeJsonAtomic(CFG_PATH, data || {});
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, {
    adminRoleId: null,
    ownerRoleId: null,
    consoleRoleId: null,
  });
}

function readLinks() {
  return readJsonSafe(LINKS_PATH, {});
}

function readServerStatus() {
  return readJsonSafe(STATUS_PATH, {});
}

function normalizeKey(v) {
  return String(v ?? "").trim();
}

function normLower(v) {
  return normalizeKey(v).toLowerCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function gridSquareFromCoords(x, z) {
  const col = clamp(Math.floor((x - GRID_MIN_X) / GRID_CELL_X), 0, 22);
  const row = clamp(Math.floor((GRID_MAX_Z - z) / GRID_CELL_Z), 0, 22);
  return `${LETTERS[col]}${row}`;
}

function formatRemaining(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getCooldownMap(serverIdentifier) {
  let m = cooldowns.get(serverIdentifier);
  if (!m) {
    m = new Map();
    cooldowns.set(serverIdentifier, m);
  }
  return m;
}

function getActiveMap(serverIdentifier) {
  let m = activeBubbles.get(serverIdentifier);
  if (!m) {
    m = new Map();
    activeBubbles.set(serverIdentifier, m);
  }
  return m;
}

function getServerDisplay(serverIdentifier) {
  const servers = listServers();
  const found = servers.find((s) => s.identifier === serverIdentifier);
  return found?.displayName || found?.identifier || serverIdentifier;
}

function getServerCfg(guildId, serverIdentifier) {
  const cfg = readCfg();
  return cfg?.[guildId]?.[serverIdentifier] || null;
}

function setServerCfg(guildId, serverIdentifier, patch) {
  const cfg = readCfg();
  if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId][serverIdentifier] = {
    ...(cfg[guildId][serverIdentifier] || {}),
    ...patch,
  };
  writeCfg(cfg);
  return cfg[guildId][serverIdentifier];
}

function getGuildConfigsForServer(serverIdentifier) {
  const cfg = readCfg();
  const out = [];
  for (const [guildId, guildCfg] of Object.entries(cfg || {})) {
    const serverCfg = guildCfg?.[serverIdentifier];
    if (serverCfg) out.push({ guildId, cfg: serverCfg });
  }
  return out;
}

function getEnabledGuildForServer(serverIdentifier) {
  const rows = getGuildConfigsForServer(serverIdentifier);
  return rows.find((x) => x?.cfg?.enabled) || null;
}

function isRaidguardEnabled(guildId, serverIdentifier) {
  return !!getServerCfg(guildId, serverIdentifier)?.enabled;
}

function getBubbleSize(guildId, serverIdentifier) {
  const cfg = getServerCfg(guildId, serverIdentifier);
  const size = Number(cfg?.size);
  return Number.isFinite(size) && size >= 10 ? size : DEFAULT_BUBBLE_SIZE;
}

function isStaff(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasAdminRole = cfg.adminRoleId && cache?.has(cfg.adminRoleId);
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasAdminRole || hasOwnerRole || hasDiscordAdmin);
}

function findLinkedGamertag(discordUserId) {
  const links = readLinks();
  return normalizeKey(links?.[discordUserId]?.gamertag);
}

function findBubbleByName(serverIdentifier, bubbleName) {
  const map = getActiveMap(serverIdentifier);
  const wanted = normLower(bubbleName);
  for (const [name, info] of map.entries()) {
    if (normLower(name) === wanted) return { name, info };
  }
  return null;
}

function isServerMarkedOnline(serverIdentifier) {
  const data = readServerStatus();
  return data?.[serverIdentifier]?.online === true;
}

function saveBubblesAtomic() {
  const out = {};
  for (const [serverId, map] of activeBubbles.entries()) {
    out[serverId] = Object.fromEntries(map.entries());
  }
  writeJsonAtomic(BUBBLES_PATH, out);
}

function requestSave() {
  if (saving) {
    saveQueued = true;
    return;
  }

  saving = true;
  try {
    saveBubblesAtomic();
  } finally {
    saving = false;
    if (saveQueued) {
      saveQueued = false;
      requestSave();
    }
  }
}

function loadBubbles() {
  try {
    const raw = fs.existsSync(BUBBLES_PATH) ? fs.readFileSync(BUBBLES_PATH, "utf8") : "{}";
    if (raw.includes("\u0000")) throw new Error("rb-bubbles.json contains NUL bytes");

    const obj = JSON.parse(raw || "{}");
    activeBubbles.clear();

    for (const [serverIdRaw, zones] of Object.entries(obj || {})) {
      const serverId = normalizeKey(serverIdRaw);
      const map = new Map();

      for (const [zoneNameRaw, info] of Object.entries(zones || {})) {
        const zoneName = normalizeKey(zoneNameRaw);
        if (info?.coords) map.set(zoneName, info);
      }

      activeBubbles.set(serverId, map);
    }
  } catch (e) {
    console.log("[RaidGuard] bubbles file unreadable/corrupt, resetting:", e?.message || e);
    activeBubbles.clear();
    requestSave();
  }
}

loadBubbles();

async function fetchConfiguredChannel(guildId, serverIdentifier, kind) {
  const client = stateClient;
  if (!client) return null;
  const cfg = getServerCfg(guildId, serverIdentifier);
  const channelId = cfg?.[kind];
  if (!channelId) return null;
  return await client.channels.fetch(channelId).catch(() => null);
}

function chunkLinesForDiscordCodeblock(lines, maxChars = 1900) {
  const chunks = [];
  let cur = [];
  let curLen = 0;

  for (const rawLine of lines) {
    const line = String(rawLine ?? "");

    if (line.length > maxChars) {
      if (cur.length) {
        chunks.push(cur);
        cur = [];
        curLen = 0;
      }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push([line.slice(i, i + maxChars)]);
      }
      continue;
    }

    const addLen = line.length + (cur.length ? 1 : 0);
    if (curLen + addLen > maxChars) {
      chunks.push(cur);
      cur = [line];
      curLen = line.length;
    } else {
      cur.push(line);
      curLen += addLen;
    }
  }

  if (cur.length) chunks.push(cur);
  return chunks;
}

async function sendRbLogToGuild(guildId, serverIdentifier, title, lines = [], color = 0x57f287) {
  try {
    const channel = await fetchConfiguredChannel(guildId, serverIdentifier, "logsChannelId");
    if (!channel) return;

    const safeTitle = String(title ?? "").slice(0, 4000);
    const safeLines = Array.isArray(lines) ? lines.filter(Boolean).map(String) : [];
    const chunks = chunkLinesForDiscordCodeblock(safeLines, 1900);

    if (!chunks.length) {
      const embed = new EmbedBuilder().setColor(0x95a5a6).setDescription(safeTitle);
      await channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      const partTitle = chunks.length > 1 ? `${safeTitle} (${i + 1}/${chunks.length})` : safeTitle;
      const embed = new EmbedBuilder().setColor(0x95a5a6).setDescription(partTitle);
      const content = `\`\`\`\n${chunks[i].join("\n")}\n\`\`\``;
      await channel.send({ embeds: [embed], content }).catch(() => {});
      await sleep(60);
    }
  } catch (e) {
    console.log("[RaidGuard] sendRbLogToGuild crashed:", e?.stack || e);
  }
}

async function sendRbLogToConfiguredGuilds(serverIdentifier, title, lines = [], color = 0x57f287) {
  const guilds = getGuildConfigsForServer(serverIdentifier);
  for (const { guildId } of guilds) {
    await sendRbLogToGuild(guildId, serverIdentifier, title, lines, color);
  }
}

async function sendPlainLogToGuild(guildId, serverIdentifier, content) {
  try {
    const channel = await fetchConfiguredChannel(guildId, serverIdentifier, "logsChannelId");
    if (!channel) return;
    await channel.send({ content: String(content || "").slice(0, 2000) }).catch(() => {});
  } catch (e) {
    console.log("[RaidGuard] sendPlainLogToGuild crashed:", e?.stack || e);
  }
}

async function sendPlainLogToConfiguredGuilds(serverIdentifier, content) {
  const guilds = getGuildConfigsForServer(serverIdentifier);
  for (const { guildId } of guilds) {
    await sendPlainLogToGuild(guildId, serverIdentifier, content);
  }
}

async function sendAlertToGuild(guildId, serverIdentifier, embed) {
  const channel = await fetchConfiguredChannel(guildId, serverIdentifier, "alertsChannelId");
  if (!channel) return;
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function sendAlertToConfiguredGuilds(serverIdentifier, embed) {
  const guilds = getGuildConfigsForServer(serverIdentifier);
  for (const { guildId } of guilds) {
    await sendAlertToGuild(guildId, serverIdentifier, EmbedBuilder.from(embed));
  }
}

function extractCoords(printposLog) {
  if (!printposLog) return null;
  const m = String(printposLog).match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

async function runCmd(rce, serverIdentifier, cmd) {
  const resp = await rce.sendCommand(serverIdentifier, cmd);
  return { cmd, resp };
}

async function say(rce, serverIdentifier, msg) {
  const cmd = `say ${msg}`;
  await rce.sendCommand(serverIdentifier, cmd);
  return cmd;
}

async function isServerResponsive(rce, serverIdentifier) {
  try {
    const res = await rce.sendCommand(serverIdentifier, "serverinfo");
    if (!res) return false;
    const txt = String(res).toLowerCase();
    return txt.includes("hostname") || txt.includes("fps") || txt.includes("players") || txt.includes("entities");
  } catch {
    return false;
  }
}

function deleteResponseMeansDeleted(resp) {
  const t = String(resp || "").toLowerCase();
  return t.includes("deleted") || t.includes("removed");
}

function createResponseMeansCreated(resp) {
  const t = String(resp || "").toLowerCase();
  return t.includes("created") || t.includes("success");
}

function editResponseLooksOkay(resp) {
  const t = String(resp || "").toLowerCase();
  return t.includes("updated") || t.includes("edited") || t.includes("success") || t.includes("color") || t.includes("allowbuildingdamage");
}

function parseTeamInfoAll(raw) {
  const text = String(raw || "");
  if (!text) return [];

  const s = text.replace(/\r/g, "");
  const parts = s.split(/(?:^|\n)(?:.*?:LOG:\s*)?Team\s+(\d+)\s+member\s+list:\s*/g);
  const teams = [];

  for (let i = 1; i < parts.length; i += 2) {
    const teamId = Number(parts[i]);
    const block = parts[i + 1] ?? "";
    const members = [];
    let leaderName = null;

    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/Team\s+\d+\s+member\s+list:/i.test(line)) break;
      const m = line.match(/^(.+?)\s+\[(.+?)\]\s*(\((LEADER|MEMBER)\))?\s*$/i);
      if (!m) continue;
      const name = normalizeKey(m[1]);
      if (!name || name === "(LEADER)") continue;
      const role = (m[4] || "").toUpperCase();
      members.push(name);
      if (role === "LEADER") leaderName = name;
    }

    if (!members.length && !leaderName) continue;
    teams.push({ id: teamId, leaderName, members });
  }

  return teams;
}

function findTeamForPlayer(teams, playerName) {
  const target = normLower(playerName);
  for (const t of teams) {
    if (!t?.members?.length) continue;
    if (t.members.some((m) => normLower(m) === target)) return t;
  }
  return null;
}

function parseUsers(raw) {
  const text = String(raw || "").replace(/\r/g, "");
  const names = [];
  for (const line of text.split("\n")) {
    const m = line.match(/"(.+?)"/);
    if (m) names.push(normalizeKey(m[1]));
  }
  return names;
}

async function getTeamsSnapshot({ rce, serverIdentifier, logLines }) {
  const res = await runCmd(rce, serverIdentifier, "teaminfoall");
  logLines.push(`:LOG: Executing console system command '${res.cmd}'.`);
  logLines.push(String(res.resp || "").trim());
  return parseTeamInfoAll(res.resp);
}

async function getOnlineUsers({ rce, serverIdentifier, logLines }) {
  const res = await runCmd(rce, serverIdentifier, "users");
  logLines.push(`:LOG: Executing console system command '${res.cmd}'.`);
  logLines.push(String(res.resp || "").trim());
  const users = parseUsers(res.resp);
  return { users, set: new Set(users.map(normLower)) };
}

function compareTeams(prev, next) {
  if (!prev) return { changed: false, reason: "baseline_set" };
  if (!next) return { changed: true, reason: "team_deleted" };

  const prevLeader = normalizeKey(prev.leaderName);
  const nextLeader = normalizeKey(next.leaderName);
  const prevSet = new Set((prev.members || []).map(normLower));
  const nextSet = new Set((next.members || []).map(normLower));

  const added = [];
  const removed = [];
  for (const n of nextSet) if (!prevSet.has(n)) added.push(n);
  for (const p of prevSet) if (!nextSet.has(p)) removed.push(p);

  if (prevLeader && nextLeader && normLower(prevLeader) !== normLower(nextLeader)) {
    return { changed: true, reason: "leader_changed", details: { from: prevLeader, to: nextLeader } };
  }
  if (added.length) return { changed: true, reason: "member_added", details: { added } };
  if (removed.length) return { changed: true, reason: "member_removed", details: { removed } };
  return { changed: false, reason: "no_change" };
}

function getBubbleLocation(info) {
  if (!info?.coords) return "Unknown";
  return gridSquareFromCoords(info.coords.x, info.coords.z);
}

function findCurrentTeamForBubble(bubbleName, info, byId) {
  const prevTeam = info?.team || null;
  if (prevTeam?.id != null && byId.has(Number(prevTeam.id))) return byId.get(Number(prevTeam.id));
  return findTeamForPlayer([...byId.values()], bubbleName);
}

function buildMembersStatus(team, onlineSet) {
  const members = team?.members || [];
  return members.map((name) => ({
    name,
    isOnline: onlineSet.has(normLower(name)),
    isLeader: team?.leaderName && normLower(team.leaderName) === normLower(name),
  }));
}

function getSavedOfflineFallbackTeam(info, onlineSet) {
  const savedTeam = info?.team || null;
  const savedMembers = Array.isArray(savedTeam?.members) ? savedTeam.members.filter(Boolean) : [];
  if (!savedMembers.length) return null;

  const anySavedOnline = savedMembers.some((name) => onlineSet.has(normLower(name)));
  if (anySavedOnline) return null;

  return {
    id: savedTeam.id ?? null,
    leaderName: savedTeam.leaderName || null,
    members: savedMembers,
    _fallbackOfflineOnly: true,
  };
}

function makeBubbleUpdateEmbed({ serverIdentifier, bubbleName, info, membersStatus, isProtected }) {
  const onlineCount = membersStatus.filter((m) => m.isOnline).length;
  const totalCount = membersStatus.length;
  const grid = getBubbleLocation(info);
  const serverDisplay = getServerDisplay(serverIdentifier);

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`${bubbleName}'s bubble has updated.`)
    .addFields(
      { name: "Server", value: serverDisplay, inline: true },
      { name: "Location", value: grid, inline: true },
      {
        name: "Status",
        value: isProtected ? "🔴 Offline (Protected)" : "🟢 Online (Unprotected)",
        inline: true,
      },
      { name: "Online", value: `${onlineCount}/${totalCount}`, inline: true },
      {
        name: "Members",
        value: membersStatus.length
          ? membersStatus.map((m) => `${m.isOnline ? "🟢" : "🔴"} ${m.name}${m.isLeader ? " (Leader)" : ""}`).join("\n").slice(0, 1024)
          : "No members found.",
      }
    )
    .setTimestamp(new Date());
}

function makeBubbleRemovedEmbed({ serverIdentifier, bubbleName, info, reasonText, membersStatus }) {
  const onlineCount = membersStatus.filter((m) => m.isOnline).length;
  const totalCount = membersStatus.length;
  const grid = getBubbleLocation(info);
  const serverDisplay = getServerDisplay(serverIdentifier);

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`⚠️ ${bubbleName}'s bubble has been removed`)
    .addFields(
      { name: "Server", value: serverDisplay, inline: true },
      { name: "Location", value: grid, inline: true },
      { name: "Online", value: `${onlineCount}/${totalCount}`, inline: true },
      { name: "Reason", value: String(reasonText || "No reason provided.").slice(0, 1024) },
      {
        name: "Members",
        value: membersStatus.length
          ? membersStatus.map((m) => `${m.isOnline ? "🟢" : "🔴"} ${m.name}${m.isLeader ? " (Leader)" : ""}`).join("\n").slice(0, 1024)
          : "No members found.",
      }
    )
    .setTimestamp(new Date());
}

function makeStatusEmbed({ serverIdentifier, bubbleName, info, membersStatus }) {
  const isProtected = !!info?.status?.protected;
  const onlineCount = membersStatus.filter((m) => m.isOnline).length;
  const totalCount = membersStatus.length;
  const grid = getBubbleLocation(info);
  const serverDisplay = getServerDisplay(serverIdentifier);
  const offlineSince = Number(info?.status?.offlineSince || 0);
  const timeValue = isProtected && offlineSince
    ? formatRemaining(AUTO_DELETE_OFFLINE_MS - (Date.now() - offlineSince))
    : "Active";

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`Team ${bubbleName}'s raid guard zone`)
    .setDescription("Current raid guard status for your team.")
    .addFields(
      { name: "Server", value: serverDisplay, inline: true },
      { name: "Location", value: grid, inline: true },
      { name: "Bubble Size", value: String(info?.size || DEFAULT_BUBBLE_SIZE), inline: true },
      {
        name: "Status",
        value: isProtected ? "🔴 Protected" : "🟢 Unprotected",
        inline: true,
      },
      { name: "Online", value: `${onlineCount}/${totalCount}`, inline: true },
      { name: "Time", value: timeValue, inline: true },
      {
        name: "Members",
        value: membersStatus.length
          ? membersStatus.map((m) => `${m.isOnline ? "🟢" : "🔴"} ${m.name}${m.isLeader ? " (Leader)" : ""}`).join("\n").slice(0, 1024)
          : "No members found.",
      }
    )
    .setTimestamp(new Date());
}

async function deleteBubbleWithReason({
  rce,
  serverIdentifier,
  bubbleName,
  reasonText,
  logLines,
  info,
  membersStatus = [],
  announceInGame = true,
}) {
  if (announceInGame) {
    const msg = `<b><color=red>[Raid Guard]</color></b> Bubble: ${bubbleName} ${reasonText}`;
    const sayCmd = await say(rce, serverIdentifier, msg);
    logLines.push(`:LOG: Executing console system command '${sayCmd}'.`);
    await sleep(COMMAND_SPACING_MS);
  }

  const del = await runCmd(rce, serverIdentifier, `zones.deletecustomzone "${bubbleName}"`);
  logLines.push(`:LOG: Executing console system command '${del.cmd}'.`);
  logLines.push(String(del.resp || "").trim());

  const active = getActiveMap(serverIdentifier);
  active.delete(bubbleName);
  requestSave();

  await sendAlertToConfiguredGuilds(
    serverIdentifier,
    makeBubbleRemovedEmbed({ serverIdentifier, bubbleName, info, reasonText, membersStatus })
  );

  await sendRbLogToConfiguredGuilds(
    serverIdentifier,
    `✅ Bubble Deleted: ${bubbleName} on ${serverIdentifier}`,
    logLines
  );

  return del;
}

async function setZoneProtected({ rce, serverIdentifier, zoneName, teamNameForChat, logLines }) {
  const cmd1 = `zones.editcustomzone "${zoneName}" allowbuildingdamage 0`;
  const r1 = await runCmd(rce, serverIdentifier, cmd1);
  logLines.push(`:LOG: Executing console system command '${r1.cmd}'.`);
  logLines.push(String(r1.resp || "").trim());
  await sleep(COMMAND_SPACING_MS);

  const cmd2 = `zones.editcustomzone "${zoneName}" color (220,40,40)`;
  const r2 = await runCmd(rce, serverIdentifier, cmd2);
  logLines.push(`:LOG: Executing console system command '${r2.cmd}'.`);
  logLines.push(String(r2.resp || "").trim());
  await sleep(COMMAND_SPACING_MS);

  const chat = `<b><color=red>[Raid Guard]</color></b> ${teamNameForChat}! Status: <color=red>Protected.</color>`;
  const sayCmd = await say(rce, serverIdentifier, chat);
  logLines.push(`:LOG: Executing console system command '${sayCmd}'.`);

  return editResponseLooksOkay(r1.resp) || editResponseLooksOkay(r2.resp);
}

async function setZoneUnprotected({ rce, serverIdentifier, zoneName, teamNameForChat, logLines }) {
  const cmd1 = `zones.editcustomzone "${zoneName}" allowbuildingdamage 1`;
  const r1 = await runCmd(rce, serverIdentifier, cmd1);
  logLines.push(`:LOG: Executing console system command '${r1.cmd}'.`);
  logLines.push(String(r1.resp || "").trim());
  await sleep(COMMAND_SPACING_MS);

  const cmd2 = `zones.editcustomzone "${zoneName}" color (143,237,143)`;
  const r2 = await runCmd(rce, serverIdentifier, cmd2);
  logLines.push(`:LOG: Executing console system command '${r2.cmd}'.`);
  logLines.push(String(r2.resp || "").trim());
  await sleep(COMMAND_SPACING_MS);

  const chat = `<b><color=red>[Raid Guard]</color></b> ${teamNameForChat}! Status: <color=green>Unprotected.</color>`;
  const sayCmd = await say(rce, serverIdentifier, chat);
  logLines.push(`:LOG: Executing console system command '${sayCmd}'.`);

  return editResponseLooksOkay(r1.resp) || editResponseLooksOkay(r2.resp);
}

async function handleQuickChatCreateBubble({ serverIdentifier, playerName, guildId }) {
  const rce = stateRce;
  const client = stateClient;

  if (!rce || !client) throw new Error("RaidGuard module not initialised yet.");

  serverIdentifier = normalizeKey(serverIdentifier);
  playerName = normalizeKey(playerName);

  if (!isRaidguardEnabled(guildId, serverIdentifier)) {
    const msg = `<b><color=red>[Raid Guard]</color></b> ${playerName}! Raid Guard is not enabled on this server.`;
    await say(rce, serverIdentifier, msg).catch(() => {});
    return { blocked: true, reason: "disabled" };
  }

  const key = `${serverIdentifier}:${playerName}`;
  if (inFlight.has(key)) return { blocked: true, reason: "in_flight" };

  const now = Date.now();
  const serverCooldown = getCooldownMap(serverIdentifier);
  const allowedAt = serverCooldown.get(playerName) || 0;

  if (now < allowedAt) {
    const remaining = formatRemaining(allowedAt - now);
    const msg = `<b><color=red>[Raid Guard]</color></b> ${playerName}! You cant create another raid bubble for ${remaining}`;

    inFlight.add(key);
    try {
      const sayCmd = await say(rce, serverIdentifier, msg);
      await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Tried Raid Bubble (Cooldown) on ${serverIdentifier}`, [
        `SERVER KEY USED: "${serverIdentifier}"`,
        `:LOG: Executing console system command '${sayCmd}'.`,
        `Cooldown remaining: ${remaining}`,
      ]);
    } finally {
      inFlight.delete(key);
    }

    return { blocked: true, remaining };
  }

  inFlight.add(key);
  serverCooldown.set(playerName, now + COOLDOWN_MS);

  const logLines = [];
  const addLog = (line) => line && logLines.push(line);

  try {
    loadBubbles();

    const teams = await getTeamsSnapshot({ rce, serverIdentifier, logLines });
    addLog(`SERVER KEY USED: "${serverIdentifier}"`);
    addLog(`Parsed teams: ${teams.length}`);

    const myTeam = findTeamForPlayer(teams, playerName);
    if (!myTeam || !myTeam.members.length) {
      const msg = `<b><color=red>[Raid Guard]</color></b> ${playerName}! You must be in a team to create a bubble.`;
      const sayCmd = await say(rce, serverIdentifier, msg);
      addLog(`:LOG: Executing console system command '${sayCmd}'.`);
      await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Raid Bubble Failed (No Team) on ${serverIdentifier}`, logLines);
      serverCooldown.delete(playerName);
      return { blocked: true, reason: "no_team" };
    }

    if (!myTeam.leaderName || normLower(myTeam.leaderName) !== normLower(playerName)) {
      const ask = myTeam.leaderName || "your leader";
      const msg = `<b><color=red>[Raid Guard]</color></b> ${playerName}! You must be the team leader to make a bubble, ask ${ask} instead.`;
      const sayCmd = await say(rce, serverIdentifier, msg);
      addLog(`:LOG: Executing console system command '${sayCmd}'.`);
      await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Raid Bubble Failed (Not Leader) on ${serverIdentifier}`, logLines);
      serverCooldown.delete(playerName);
      return { blocked: true, reason: "not_leader", leaderName: myTeam.leaderName };
    }

    const pos = await runCmd(rce, serverIdentifier, `printpos "${playerName}"`);
    addLog(`:LOG: Executing console system command '${pos.cmd}'.`);
    addLog(String(pos.resp || "").trim());

    const coords = extractCoords(String(pos.resp || ""));
    if (!coords) {
      await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Raid Bubble Failed (No Coords Parsed) on ${serverIdentifier}`, logLines);
      serverCooldown.delete(playerName);
      return { blocked: true, reason: "coords_parse_failed" };
    }

    const active = getActiveMap(serverIdentifier);
    for (const [zoneName, info] of active.entries()) {
      if (normLower(zoneName) === normLower(playerName)) continue;
      if (!info?.coords) continue;
      const d = dist3(coords, info.coords);
      if (d < MIN_BUBBLE_DISTANCE) {
        const msg = `<b><color=red>[Raid Guard]</color></b> ${playerName}! You cant place a raid bubble this close to another players bubble!`;
        const sayCmd = await say(rce, serverIdentifier, msg);
        addLog(`:LOG: Executing console system command '${sayCmd}'.`);
        await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Raid Bubble Blocked (Too Close) on ${serverIdentifier}`, logLines);
        serverCooldown.delete(playerName);
        return { blocked: true, reason: "too_close", near: zoneName, distance: d };
      }
    }

    let deletedOld = false;
    const delOld = await runCmd(rce, serverIdentifier, `zones.deletecustomzone "${playerName}"`);
    addLog(`:LOG: Executing console system command '${delOld.cmd}'.`);
    addLog(String(delOld.resp || "").trim());
    deletedOld = deleteResponseMeansDeleted(delOld.resp);
    if (deletedOld) {
      active.delete(playerName);
      requestSave();
    }

    const size = getBubbleSize(guildId, serverIdentifier);
    const createCmd = `zones.createcustomzone "${playerName}" (${coords.x},${coords.y},${coords.z}) 45 sphere ${size} 1 1 0 1 1`;
    const created = await runCmd(rce, serverIdentifier, createCmd);
    addLog(`:LOG: Executing console system command '${created.cmd}'.`);
    addLog(String(created.resp || "").trim());

    if (!createResponseMeansCreated(created.resp)) {
      await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Raid Bubble Failed (Zone Create Failed) on ${serverIdentifier}`, logLines);
      serverCooldown.delete(playerName);
      return { blocked: true, reason: "create_failed" };
    }

    const grid = gridSquareFromCoords(coords.x, coords.z);
    active.set(playerName, {
      coords,
      grid,
      size,
      createdAt: Date.now(),
      team: { id: myTeam.id, leaderName: myTeam.leaderName, members: myTeam.members },
      status: { teamOnline: true, protected: false, offlineSince: null },
    });
    requestSave();

    const msg = deletedOld
      ? `<b><color=red>[Raid Guard]</color></b> ${playerName}! Old bubble deleted, new bubble placed successfully.`
      : `<b><color=red>[Raid Guard]</color></b> ${playerName}! Raid bubble successfully created!`;
    const sayCmd = await say(rce, serverIdentifier, msg);
    addLog(`:LOG: Executing console system command '${sayCmd}'.`);

    setTimeout(async () => {
      try {
        const edited = await runCmd(rce, serverIdentifier, `zones.editcustomzone "${playerName}" color (143,237,143)`);
        await sendRbLogToConfiguredGuilds(
          serverIdentifier,
          `✅ (${playerName}) Raid Bubble Zone Turned Green on ${serverIdentifier}`,
          [...logLines, `:LOG: Executing console system command '${edited.cmd}'.`, String(edited.resp || "").trim()]
        );
      } catch (e) {
        await sendRbLogToConfiguredGuilds(serverIdentifier, `❌ (${playerName}) Green Zone Delay Error on ${serverIdentifier}`, [`ERROR: ${e?.stack || e}`], 0xed4245);
      }
    }, 10_000);

    await sendRbLogToConfiguredGuilds(
      serverIdentifier,
      deletedOld ? `✅ (${playerName}) Replaced Raid Bubble on ${serverIdentifier}` : `✅ (${playerName}) Created a Raid Bubble on ${serverIdentifier}`,
      logLines
    );

    return { blocked: false, coords, deletedOld, size };
  } catch (err) {
    serverCooldown.delete(playerName);
    await sendRbLogToConfiguredGuilds(serverIdentifier, `✅ (${playerName}) Raid Bubble Error on ${serverIdentifier}`, [...logLines, `ERROR: ${err?.stack || err}`], 0xed4245);
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

async function processOneBubble({ rce, serverIdentifier, map, byId, online, bubbleNameRaw, infoRaw }) {
  const bubbleName = normalizeKey(bubbleNameRaw);
  const info = infoRaw || {};

  let currentTeam = findCurrentTeamForBubble(bubbleName, info, byId);

  if (!currentTeam) {
    const fallbackTeam = getSavedOfflineFallbackTeam(info, online.set);

    if (fallbackTeam) {
      currentTeam = fallbackTeam;

      await sendRbLogToConfiguredGuilds(
        serverIdentifier,
        `⚠️ (Watcher) Team Skipped: ${bubbleName} on ${serverIdentifier}`,
        [
          `teaminfoall did not return a usable team for "${bubbleName}".`,
          `Using saved team data because all saved members are offline.`,
          `Saved leader: ${fallbackTeam.leaderName || "Unknown"}`,
          `Saved members: ${fallbackTeam.members.join(", ") || "None"}`,
        ],
        0xfee75c
      );
    }
  }

  if (!currentTeam) {
    await deleteBubbleWithReason({
      rce,
      serverIdentifier,
      bubbleName,
      reasonText: "has been removed because the team could not be verified (team changed / disbanded).",
      logLines: [`teaminfoall had no matching team for "${bubbleName}".`],
      info,
      membersStatus: [],
    });
    await sleep(COMMAND_SPACING_MS);
    return;
  }

  const membersStatus = buildMembersStatus(currentTeam, online.set);
  const teamOnlineNow = membersStatus.some((m) => m.isOnline);
  const savedProtected = !!info?.status?.protected;
  const offlineSince = Number(info?.status?.offlineSince || 0);
  const now = Date.now();

  const nextInfo = {
    ...info,
    team: { id: currentTeam.id, leaderName: currentTeam.leaderName, members: currentTeam.members },
    status: {
      ...(info.status || {}),
      teamOnline: teamOnlineNow,
      protected: savedProtected,
      offlineSince: teamOnlineNow ? null : offlineSince || now,
    },
  };

  const needProtectNow = !teamOnlineNow && !savedProtected;
  const needUnprotectNow = teamOnlineNow && savedProtected;

  if (needProtectNow) {
    const logs = [];
    const teamNameForChat = currentTeam.leaderName || bubbleName;
    await setZoneProtected({ rce, serverIdentifier, zoneName: bubbleName, teamNameForChat, logLines: logs });
    nextInfo.status.protected = true;
    nextInfo.status.teamOnline = false;
    nextInfo.status.offlineSince = nextInfo.status.offlineSince || now;
    map.set(bubbleName, nextInfo);
    requestSave();

    await sendAlertToConfiguredGuilds(
      serverIdentifier,
      makeBubbleUpdateEmbed({ serverIdentifier, bubbleName, info: nextInfo, membersStatus, isProtected: true })
    );
    await sendRbLogToConfiguredGuilds(serverIdentifier, `🔴 ${teamNameForChat} Is offline (ZONE TURNING RED)`, logs, 0xed4245);
  } else if (needUnprotectNow) {
    const logs = [];
    const teamNameForChat = currentTeam.leaderName || bubbleName;
    await setZoneUnprotected({ rce, serverIdentifier, zoneName: bubbleName, teamNameForChat, logLines: logs });
    nextInfo.status.protected = false;
    nextInfo.status.teamOnline = true;
    nextInfo.status.offlineSince = null;
    map.set(bubbleName, nextInfo);
    requestSave();

    await sendAlertToConfiguredGuilds(
      serverIdentifier,
      makeBubbleUpdateEmbed({ serverIdentifier, bubbleName, info: nextInfo, membersStatus, isProtected: false })
    );
    await sendRbLogToConfiguredGuilds(serverIdentifier, `🟢 ${teamNameForChat} Is online (ZONE TURNING GREEN)`, logs, 0x57f287);
  } else {
    map.set(bubbleName, nextInfo);
    requestSave();
  }

  const protectedNow = !!nextInfo?.status?.protected;
  const offlineMs = protectedNow && nextInfo.status.offlineSince ? now - nextInfo.status.offlineSince : 0;
  if (protectedNow && offlineMs >= AUTO_DELETE_OFFLINE_MS) {
    await deleteBubbleWithReason({
      rce,
      serverIdentifier,
      bubbleName,
      reasonText: "has been removed after staying protected/offline for 24 hours.",
      logLines: [`Bubble was protected for ${formatRemaining(offlineMs)}.`],
      info: nextInfo,
      membersStatus,
    });
    await sleep(COMMAND_SPACING_MS);
    return;
  }

  if (currentTeam._fallbackOfflineOnly) {
    await sleep(COMMAND_SPACING_MS);
    return;
  }

  const prevTeam = info?.team || null;
  const cmp = compareTeams(prevTeam, {
    id: currentTeam.id,
    leaderName: currentTeam.leaderName,
    members: currentTeam.members,
  });

  if (!cmp.changed) {
    await sleep(COMMAND_SPACING_MS);
    return;
  }

  if (cmp.reason === "leader_changed") {
    await deleteBubbleWithReason({
      rce,
      serverIdentifier,
      bubbleName,
      reasonText: `has been removed due to a leadership change (Leader: ${cmp.details.from} ➜ ${cmp.details.to}).`,
      logLines: [`TeamId: ${currentTeam.id}`],
      info: nextInfo,
      membersStatus,
    });
  } else if (cmp.reason === "member_added") {
    await deleteBubbleWithReason({
      rce,
      serverIdentifier,
      bubbleName,
      reasonText: `has been removed because a new member joined the team (${cmp.details.added.join(", ")}).`,
      logLines: [`TeamId: ${currentTeam.id}`],
      info: nextInfo,
      membersStatus,
    });
  } else if (cmp.reason === "member_removed") {
    await deleteBubbleWithReason({
      rce,
      serverIdentifier,
      bubbleName,
      reasonText: `has been removed because a team member left (${cmp.details.removed.join(", ")}).`,
      logLines: [`TeamId: ${currentTeam.id}`],
      info: nextInfo,
      membersStatus,
    });
  }

  await sleep(COMMAND_SPACING_MS);
}

function startOfflineTeamWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;

  let running = false;

  setTimeout(() => {
    setInterval(async () => {
      if (running) return;
      running = true;

      try {
        const rce = stateRce;
        if (!rce) return;

        loadBubbles();

        for (const [serverIdentifierRaw, map] of activeBubbles.entries()) {
          const serverIdentifier = normalizeKey(serverIdentifierRaw);
          const serverGuilds = getGuildConfigsForServer(serverIdentifier);
          if (!serverGuilds.some((x) => x.cfg?.enabled)) continue;

          if (!isServerMarkedOnline(serverIdentifier)) {
            await sendPlainLogToConfiguredGuilds(
              serverIdentifier,
              `⚠️ Skipping watcher on ${serverIdentifier} because server_status.json says OFFLINE.`
            );
            continue;
          }

          const sweepLogs = ["server_status.json says server is ONLINE."];

          const teams = await getTeamsSnapshot({ rce, serverIdentifier, logLines: sweepLogs });
          await sleep(COMMAND_SPACING_MS);
          const online = await getOnlineUsers({ rce, serverIdentifier, logLines: sweepLogs });

          await sendRbLogToConfiguredGuilds(
            serverIdentifier,
            `✅ (Watcher) 5 Minute Check Ran on ${serverIdentifier}`,
            sweepLogs
          );

          const byId = new Map(teams.map((t) => [t.id, t]));
          const entries = [...map.entries()];

          for (const [bubbleNameRaw, infoRaw] of entries) {
            try {
              await processOneBubble({ rce, serverIdentifier, map, byId, online, bubbleNameRaw, infoRaw });
            } catch (err) {
              await sendRbLogToConfiguredGuilds(
                serverIdentifier,
                `❌ (Watcher) Bubble Error: ${normalizeKey(bubbleNameRaw)} on ${serverIdentifier}`,
                [`ERROR: ${err?.stack || err}`],
                0xed4245
              );
            }
          }
        }
      } finally {
        running = false;
      }
    }, TEAM_CHECK_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

async function getLiveServerState(rce, serverIdentifier) {
  const logLines = [];
  const responsive = await isServerResponsive(rce, serverIdentifier);
  if (!responsive) return { responsive: false, teams: [], online: { users: [], set: new Set() }, logLines };
  const teams = await getTeamsSnapshot({ rce, serverIdentifier, logLines });
  await sleep(COMMAND_SPACING_MS);
  const online = await getOnlineUsers({ rce, serverIdentifier, logLines });
  return { responsive: true, teams, online, logLines };
}

function resolveBubbleForTeam(serverIdentifier, team) {
  const map = getActiveMap(serverIdentifier);
  if (!team) return null;

  for (const [bubbleName, info] of map.entries()) {
    if (Number(info?.team?.id) === Number(team.id)) return { bubbleName, info };
  }

  const leaderName = normalizeKey(team.leaderName);
  if (leaderName) {
    for (const [bubbleName, info] of map.entries()) {
      if (normLower(bubbleName) === normLower(leaderName)) return { bubbleName, info };
    }
  }

  for (const [bubbleName, info] of map.entries()) {
    if ((info?.team?.members || []).some((m) => team.members.some((tm) => normLower(tm) === normLower(m)))) {
      return { bubbleName, info };
    }
  }

  return null;
}

module.exports = {
  name: "raidguard",

  async handleQuickChatCreateBubble(payload) {
    return handleQuickChatCreateBubble(payload);
  },

  init(client, rce) {
    stateClient = client;
    stateRce = rce;
    startOfflineTeamWatcher();

    rce.on(RCEEvent.QuickChat, async (payload) => {
      try {
        const serverIdentifier = normalizeKey(payload?.server?.identifier);
        const quickChat = normalizeKey(payload?.message);
        const playerName = normalizeKey(payload?.player?.ign || payload?.player?.name);

        if (!serverIdentifier || !playerName) return;
        if (quickChat !== QUICKCHAT_TRIGGER) return;

        const chosen = getEnabledGuildForServer(serverIdentifier);
        if (!chosen) return;

        await handleQuickChatCreateBubble({
          serverIdentifier,
          playerName,
          guildId: chosen.guildId,
        });
      } catch (e) {
        console.error("[raidguard] quickchat error:", e);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isAutocomplete()) return;
      if (interaction.commandName !== "raidguard") return;

      const focused = interaction.options.getFocused(true);
      if (focused.name !== "server") return;

      const q = String(focused.value || "").toLowerCase();
      const choices = listServers()
        .map((s) => ({ name: (s.displayName || s.identifier).slice(0, 100), value: s.identifier }))
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 25);

      return interaction.respond(choices).catch(() => {})
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "raidguard") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();
        const staffOnly = ["setup", "list", "delete", "remove", "force-set", "enable", "disable"];
        if (staffOnly.includes(sub) && !isStaff(interaction)) {
          return interaction.reply({ content: "Admin/Owner only.", flags: MessageFlags.Ephemeral });
        }

        if (sub === "setup") {
          const serverIdentifier = interaction.options.getString("server", true);
          const logs = interaction.options.getChannel("logs", true);
          const alerts = interaction.options.getChannel("alerts", true);
          const size = interaction.options.getInteger("size", true);

          const saved = setServerCfg(interaction.guildId, serverIdentifier, {
            logsChannelId: logs.id,
            alertsChannelId: alerts.id,
            size,
            enabled: getServerCfg(interaction.guildId, serverIdentifier)?.enabled ?? false,
          });

          return interaction.reply({
            content: `RaidGuard setup saved for **${getServerDisplay(serverIdentifier)}**. Size: **${saved.size}**. Logs: <#${logs.id}> Alerts: <#${alerts.id}>.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (sub === "enable") {
          const serverIdentifier = interaction.options.getString("server", true);
          const cfg = getServerCfg(interaction.guildId, serverIdentifier);
          if (!cfg?.logsChannelId || !cfg?.alertsChannelId) {
            return interaction.reply({ content: "Run /raidguard setup first.", flags: MessageFlags.Ephemeral });
          }

          setServerCfg(interaction.guildId, serverIdentifier, { enabled: true });
          return interaction.reply({ content: `RaidGuard enabled on **${getServerDisplay(serverIdentifier)}**.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === "disable") {
          const serverIdentifier = interaction.options.getString("server", true);
          setServerCfg(interaction.guildId, serverIdentifier, { enabled: false });
          return interaction.reply({ content: `RaidGuard disabled on **${getServerDisplay(serverIdentifier)}**.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === "delete" || sub === "remove") {
          const serverIdentifier = interaction.options.getString("server", true);
          const name = interaction.options.getString("name", false) || interaction.options.getString("bubble", false) || "";
          const found = findBubbleByName(serverIdentifier, name);
          if (!found) {
            return interaction.reply({ content: `No active bubble called **${name}** on **${getServerDisplay(serverIdentifier)}**.`, allowedMentions: { parse: [] } });
          }

          const membersStatus = [];
          const logLines = [`Manual remove requested by ${interaction.user.tag} (${interaction.user.id}).`];
          const del = await deleteBubbleWithReason({
            rce,
            serverIdentifier,
            bubbleName: found.name,
            reasonText: `has been manually removed by ${interaction.user.tag}.`,
            logLines,
            info: found.info,
            membersStatus,
            announceInGame: true,
          });

          return interaction.reply({
            content: `Removed bubble **${found.name}** on **${getServerDisplay(serverIdentifier)}**.\nResponse: \`${String(del?.resp || "No response").slice(0, 1500)}\``,
            allowedMentions: { parse: [] },
          });
        }

        if (sub === "force-set") {
          await interaction.deferReply();

          const serverIdentifier = interaction.options.getString("server", true);
          const name = interaction.options.getString("name", true);
          const type = interaction.options.getString("type", true);

          const found = findBubbleByName(serverIdentifier, name);
          if (!found) {
            return interaction.editReply({
              content: `No active bubble called **${name}** on **${getServerDisplay(serverIdentifier)}**.`,
            });
          }

          const logs = [`Manual force-set requested by ${interaction.user.tag} (${interaction.user.id}).`];

          if (type === "red") {
            await setZoneProtected({
              rce,
              serverIdentifier,
              zoneName: found.name,
              teamNameForChat: found.name,
              logLines: logs,
            });
            found.info.status = {
              ...(found.info.status || {}),
              protected: true,
              teamOnline: false,
              offlineSince: Date.now(),
            };
          } else {
            await setZoneUnprotected({
              rce,
              serverIdentifier,
              zoneName: found.name,
              teamNameForChat: found.name,
              logLines: logs,
            });
            found.info.status = {
              ...(found.info.status || {}),
              protected: false,
              teamOnline: true,
              offlineSince: null,
            };
          }

          getActiveMap(serverIdentifier).set(found.name, found.info);
          requestSave();

          const membersStatus = (found.info?.team?.members || []).map((member) => ({
            name: member,
            isOnline: type === "green",
            isLeader: normLower(member) === normLower(found.info?.team?.leaderName),
          }));

          await sendAlertToConfiguredGuilds(
            serverIdentifier,
            makeBubbleUpdateEmbed({
              serverIdentifier,
              bubbleName: found.name,
              info: found.info,
              membersStatus,
              isProtected: type === "red",
            })
          );

          await sendRbLogToConfiguredGuilds(
            serverIdentifier,
            `✅ Manual force-set: ${found.name} (${type}) on ${serverIdentifier}`,
            logs
          );

          return interaction.editReply({
            content: `Bubble **${found.name}** on **${getServerDisplay(serverIdentifier)}** was force-set to **${type === "red" ? "Protected" : "Unprotected"}**.`,
          });
        }

        if (sub === "list") {
          const serverIdentifier = interaction.options.getString("server", true);
          loadBubbles();
          const map = getActiveMap(serverIdentifier);
          if (!map.size) {
            return interaction.reply({ content: `No active bubbles on **${getServerDisplay(serverIdentifier)}**.` });
          }

          const live = await getLiveServerState(rce, serverIdentifier);
          const byId = new Map((live.teams || []).map((t) => [t.id, t]));

          const lines = [];
          for (const [bubbleName, info] of map.entries()) {
            let currentTeam = live.responsive ? findCurrentTeamForBubble(bubbleName, info, byId) : null;

            if (!currentTeam && live.responsive) {
              currentTeam = getSavedOfflineFallbackTeam(info, live.online.set);
            }

            const membersStatus = currentTeam
              ? buildMembersStatus(currentTeam, live.online.set)
              : (info?.team?.members || []).map((m) => ({
                  name: m,
                  isOnline: false,
                  isLeader: normLower(m) === normLower(info?.team?.leaderName),
                }));

            const protectedNow = live.responsive ? !membersStatus.some((m) => m.isOnline) : !!info?.status?.protected;
            const onlineCount = membersStatus.filter((m) => m.isOnline).length;
            const totalCount = membersStatus.length;
            const offlineSince = Number(info?.status?.offlineSince || 0);
            const timer = protectedNow && offlineSince ? formatRemaining(AUTO_DELETE_OFFLINE_MS - (Date.now() - offlineSince)) : "Not counting down";

            lines.push(
              `${protectedNow ? "🔴" : "🟢"} **${bubbleName}**`,
              `Location: ${getBubbleLocation(info)}`,
              `Status: ${protectedNow ? "Offline (Protected)" : "Online (Unprotected)"}`,
              `Online: ${onlineCount}/${totalCount}`,
              `Size: ${info?.size || DEFAULT_BUBBLE_SIZE}`,
              protectedNow ? `Deletion: ${timer}` : `Deletion: Safe while online`,
              membersStatus.length ? `Members: ${membersStatus.map((m) => `${m.isOnline ? "🟢" : "🔴"}${m.name}`).join(", ")}` : "Members: Unknown",
              ""
            );
          }

          const embed = new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle(`Active bubbles on ${getServerDisplay(serverIdentifier)}`)
            .setDescription(lines.join("\n").slice(0, 4096))
            .setFooter({ text: live.responsive ? "Live team data" : "Server offline - showing saved data" })
            .setTimestamp(new Date());

          return interaction.reply({ embeds: [embed] });
        }

        if (sub === "status") {
          const serverIdentifier = interaction.options.getString("server", true);
          const gamertag = findLinkedGamertag(interaction.user.id);
          if (!gamertag) {
            return interaction.reply({ content: "❌ You must link your account first." });
          }

          loadBubbles();
          const live = await getLiveServerState(rce, serverIdentifier);
          if (!live.responsive) {
            return interaction.reply({ content: `⚠️ ${getServerDisplay(serverIdentifier)} is not responding right now.` });
          }

          let myTeam = findTeamForPlayer(live.teams, gamertag);
          let bubble = myTeam ? resolveBubbleForTeam(serverIdentifier, myTeam) : null;

          if (!myTeam || !bubble) {
            const map = getActiveMap(serverIdentifier);
            for (const [bubbleName, info] of map.entries()) {
              const savedMembers = info?.team?.members || [];
              if (savedMembers.some((m) => normLower(m) === normLower(gamertag))) {
                myTeam = getSavedOfflineFallbackTeam(info, live.online.set) || info.team;
                bubble = { bubbleName, info };
                break;
              }
            }
          }

          if (!myTeam) {
            return interaction.reply({ content: `❌ You dont have a zone on **${getServerDisplay(serverIdentifier)}**.` });
          }

          if (!bubble) {
            return interaction.reply({ content: `❌ You dont have a zone on **${getServerDisplay(serverIdentifier)}**.` });
          }

          const membersStatus = buildMembersStatus(myTeam, live.online.set);
          const info = {
            ...bubble.info,
            team: { id: myTeam.id, leaderName: myTeam.leaderName, members: myTeam.members },
            status: {
              ...(bubble.info.status || {}),
              protected: !membersStatus.some((m) => m.isOnline),
              teamOnline: membersStatus.some((m) => m.isOnline),
              offlineSince: bubble.info?.status?.offlineSince || null,
            },
          };

          return interaction.reply({ embeds: [makeStatusEmbed({ serverIdentifier, bubbleName: bubble.bubbleName, info, membersStatus })] });
        }
      } catch (e) {
        console.error("[raidguard] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "RaidGuard error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};
