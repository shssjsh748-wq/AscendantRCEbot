const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const { listServers, getServer } = require("./rce");

const { readLinks } = require("./links");
const CLANS_PATH = path.join(__dirname, "clans.json");
const ROLES_PATH = path.join(__dirname, "roles.json");
const ZORP_PATH = path.join(__dirname, "clan_zorp.json");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVW";
const GRID_MIN_X = -1750;
const GRID_MAX_Z = 1749;
const GRID_CELL_X = (-76 - GRID_MIN_X) / 11;
const GRID_CELL_Z = (GRID_MAX_Z + 76) / 12;

const MIN_ZORP_MEMBERS = 1; // test value
const MEMBER_REFRESH_MS = 30_000;
const RED_DELAY_MS = 5 * 60 * 1000;
const AUTO_DELETE_MS = 16 * 60 * 60 * 1000;
const FORCE_DURATION_MS = 30 * 60 * 1000;
const GRACE_SWEEP_MS = 2_000;
const MIN_AXIS_DISTANCE = 200;

const ORANGE = 0xff7c00;
const WHITE = 0xffffff;

const GREEN_RGB = "(143,237,143)";
const YELLOW_RGB = "(255,170,0)";
const RED_RGB = "(255,0,0)";
const GRACE_RGB = "(0,60,160)";

const runtime = new Map(); // key -> { belowSince, appliedColor, appliedRadiation, appliedDamage }
const lastGraceSweepAt = new Map();
let lastRefreshAt = 0;

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

function readClans() {
  return readJsonSafe(CLANS_PATH, {});
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, {
    adminRoleId: null,
    ownerRoleId: null,
    consoleRoleId: null,
  });
}

function readZorp() {
  return readJsonSafe(ZORP_PATH, {});
}

function writeZorp(data) {
  writeJsonSafe(ZORP_PATH, data);
}

function ensureGuildServer(obj, guildId, serverId) {
  if (!obj[guildId]) obj[guildId] = {};
  if (!obj[guildId][serverId]) obj[guildId][serverId] = {};
  return obj[guildId][serverId];
}

function zoneKey(guildId, serverId, roleId) {
  return `${guildId}:${serverId}:${roleId}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function gridSquareFromCoords(x, z) {
  const col = clamp(Math.floor((x - GRID_MIN_X) / GRID_CELL_X), 0, 22);
  const row = clamp(Math.floor((GRID_MAX_Z - z) / GRID_CELL_Z), 0, 22);
  return `${LETTERS[col]}${row}`;
}

function escapeQuotes(str) {
  return String(str || "").replace(/"/g, '\\"');
}

function parsePrintPos(text) {
  const m = String(text || "").match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (!m) return null;
  return {
    x: Number(m[1]),
    y: Number(m[2]),
    z: Number(m[3]),
  };
}

function parseUsersResponse(text) {
  const out = new Set();
  const str = String(text || "");
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(str))) {
    const name = String(m[1] || "").trim().toLowerCase();
    if (name) out.add(name);
  }
  return out;
}

function resolveServerDisplay(serverId) {
  const s = getServer(serverId);
  return String(s?.displayName || s?.identifier || serverId).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatStatus(status) {
  if (status === "on") return "On";
  if (status === "grace") return "Grace";
  return "Off";
}

function formatDurationShort(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins > 0) return `${mins} minute${mins === 1 ? "" : "s"}`;
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

function getLinkedGamertag(userId) {
  const links = readLinks();
  const direct = links?.[userId];

  if (direct && typeof direct === "object") {
    return (
      direct.gamertag ||
      direct.gamerTag ||
      direct.Gamertag ||
      direct.ign ||
      direct.name ||
      direct.playerName ||
      direct.inGameName ||
      null
    );
  }

  for (const maybeGuild of Object.values(links)) {
    if (!maybeGuild || typeof maybeGuild !== "object" || Array.isArray(maybeGuild)) continue;
    const found = maybeGuild[userId];
    if (!found || typeof found !== "object") continue;
    return (
      found.gamertag ||
      found.gamerTag ||
      found.Gamertag ||
      found.ign ||
      found.name ||
      found.playerName ||
      found.inGameName ||
      null
    );
  }

  return null;
}

function extractClanMemberIds(clan) {
  const ids = new Set();
  if (clan?.leaderId) ids.add(String(clan.leaderId));
  if (Array.isArray(clan?.members)) {
    for (const id of clan.members) ids.add(String(id));
  }
  return [...ids];
}

function getUnlinkedClanMembers(memberIds) {
  return memberIds.filter((id) => !getLinkedGamertag(id));
}

function getUserClan(guildId, serverId, userId) {
  const all = readClans();
  const serverObj = all?.[guildId]?.[serverId];
  if (!serverObj) return null;

  for (const [roleId, clan] of Object.entries(serverObj)) {
    const members = extractClanMemberIds(clan);
    if (members.includes(String(userId))) {
      return { roleId, clan, all };
    }
  }

  return null;
}

function getClanByRoleId(guildId, serverId, roleId) {
  const all = readClans();
  return all?.[guildId]?.[serverId]?.[roleId] || null;
}

function getZoneEntry(guildId, serverId, roleId) {
  const all = readZorp();
  return all?.[guildId]?.[serverId]?.[roleId] || null;
}

function setZoneEntry(guildId, serverId, roleId, entry) {
  const all = readZorp();
  const serverObj = ensureGuildServer(all, guildId, serverId);
  serverObj[roleId] = entry;
  writeZorp(all);
}

function removeZoneEntry(guildId, serverId, roleId) {
  const all = readZorp();
  if (!all?.[guildId]?.[serverId]?.[roleId]) return false;
  delete all[guildId][serverId][roleId];
  if (all[guildId] && all[guildId][serverId] && !Object.keys(all[guildId][serverId]).length) {
    delete all[guildId][serverId];
  }
  writeZorp(all);
  return true;
}

function getZoneSize(memberCount) {
  if (memberCount >= 25) return { label: "Large", radius: 150 };
  if (memberCount >= 11) return { label: "Medium", radius: 120 };
  return { label: "Small", radius: 80 };
}

function buildZoneName(clanName, tag) {
  return `<color=orange>${clanName} [${tag}]`;
}

function canManageZorp(interaction) {
  const roles = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasAdminRole = roles.adminRoleId && cache?.has(roles.adminRoleId);
  const hasOwnerRole = roles.ownerRoleId && cache?.has(roles.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasAdminRole || hasOwnerRole || hasDiscordAdmin);
}

function makeInitialEmbed(serverDisplay) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `### Get your clan zorp on ${serverDisplay}`,
        `Make sure your in your core for the system to work accordingly.`,
      ].join("\n")
    );
}

function makeCreatedEmbed({ clanName, tag, roleId, grid, sizeLabel, status }) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `### ZORP Created successfully`,
        `ZORP for **${clanName}** [${tag}] created`,
      ].join("\n")
    )
    .addFields(
      { name: "Grid", value: `\`${grid}\``, inline: true },
      { name: "Size", value: sizeLabel, inline: true },
      { name: "Clan", value: `<@&${roleId}>`, inline: true },
      { name: "Status", value: formatStatus(status), inline: true }
    )
    .setTimestamp();
}

function makeFailedCreateEmbed({ clanName, tag, roleId, grid, sizeLabel }) {
  const fields = [];
  if (grid) fields.push({ name: "Grid", value: `\`${grid}\``, inline: true });
  if (sizeLabel) fields.push({ name: "Size", value: sizeLabel, inline: true });
  if (roleId) fields.push({ name: "Clan", value: `<@&${roleId}>`, inline: true });

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `### Zone creation failed`,
        `Zone creation failed, please contact support`,
      ].join("\n")
    )
    .addFields(fields)
    .setTimestamp();
}

function makeCheckEmbed({ clanName, tag, roleId, grid, autoDeletionValue, status, onlineCount, totalMembers }) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `## ZORP Status Check`,
        `ZORP for **${clanName}** [${tag}]`,
      ].join("\n")
    )
    .addFields(
      { name: "Grid", value: `\`${grid}\``, inline: true },
      { name: "Clan", value: `<@&${roleId}>`, inline: true },
      { name: "Auto Deletion", value: autoDeletionValue, inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Online", value: `${onlineCount}/${totalMembers}`, inline: true }
    )
    .setTimestamp();
}

async function sendRceCommand(rce, serverId, command) {
  return rce.sendCommand(serverId, command);
}

async function announceZone(rce, serverId, text) {
  try {
    await sendRceCommand(rce, serverId, `say ${escapeQuotes(text)}`);
  } catch {}
}

function getRuntime(key) {
  const current = runtime.get(key) || {
    belowSince: null,
    appliedColor: null,
    appliedRadiation: null,
    appliedDamage: null,
  };
  runtime.set(key, current);
  return current;
}

function resetRuntimeForZone(key) {
  runtime.set(key, {
    belowSince: null,
    appliedColor: null,
    appliedRadiation: null,
    appliedDamage: null,
  });
}

async function setZoneVisual(rce, zone, color, damage, radiation) {
  const key = zoneKey(zone.guildId, zone.serverId, zone.roleId);
  const state = getRuntime(key);
  const zoneNameEsc = escapeQuotes(zone.zoneName);

  if (state.appliedColor !== color) {
    await sendRceCommand(rce, zone.serverId, `editcustomzone "${zoneNameEsc}" color ${color}`);
    state.appliedColor = color;
  }

  if (state.appliedDamage !== String(damage)) {
    await sendRceCommand(rce, zone.serverId, `editcustomzone "${zoneNameEsc}" allowbuildingdamage ${damage}`);
    state.appliedDamage = String(damage);
  }

  if (state.appliedRadiation !== String(radiation)) {
    await sendRceCommand(rce, zone.serverId, `editcustomzone "${zoneNameEsc}" radiationdamage "${radiation}"`);
    state.appliedRadiation = String(radiation);
  }
}

function updateZoneSnapshotFromClan(zone, freshClan) {
  const memberIds = extractClanMemberIds(freshClan);
  zone.leaderId = String(freshClan.leaderId || zone.leaderId || "");
  zone.clanName = freshClan.name || zone.clanName;
  zone.tag = freshClan.tag || zone.tag;
  zone.memberIds = memberIds;
  zone.totalMembers = memberIds.length;
  return zone;
}

function getTooCloseZone(guildId, serverId, x, z, skipRoleId = null) {
  const all = readZorp();
  const serverObj = all?.[guildId]?.[serverId] || {};

  for (const [roleId, zone] of Object.entries(serverObj)) {
    if (skipRoleId && String(roleId) === String(skipRoleId)) continue;

    const dx = Math.abs(Number(zone?.coords?.x ?? 0) - x);
    const dz = Math.abs(Number(zone?.coords?.z ?? 0) - z);

    if (dx < MIN_AXIS_DISTANCE && dz < MIN_AXIS_DISTANCE) {
      const moveAway = Math.ceil(Math.min(MIN_AXIS_DISTANCE - dx, MIN_AXIS_DISTANCE - dz));
      return { zone, moveAway };
    }
  }

  return null;
}

function getOnlineCountForZone(zone, onlineSet) {
  const ids = Array.isArray(zone.memberIds) ? zone.memberIds : [];
  let onlineCount = 0;

  for (const memberId of ids) {
    const gt = getLinkedGamertag(memberId);
    if (!gt) continue;
    if (onlineSet.has(String(gt).trim().toLowerCase())) onlineCount++;
  }

  return onlineCount;
}

function isGamertagInZoneClan(zone, gamertag) {
  const ids = Array.isArray(zone.memberIds) ? zone.memberIds : [];
  const check = String(gamertag || "").trim().toLowerCase();

  for (const memberId of ids) {
    const gt = getLinkedGamertag(memberId);
    if (gt && String(gt).trim().toLowerCase() === check) return true;
  }

  return false;
}

function parseGraceDuration(value) {
  const v = String(value || "").toLowerCase();
  if (v === "1minute") return 60_000;
  if (v === "1hour" || v === "1hours") return 60 * 60_000;
  if (v === "2hours") return 2 * 60 * 60_000;
  if (v === "6hours") return 6 * 60 * 60_000;
  return null;
}

function findZoneByClanText(guildId, serverId, text) {
  const all = readZorp();
  const serverObj = all?.[guildId]?.[serverId] || {};
  const q = String(text || "").trim().toLowerCase();

  for (const [roleId, zone] of Object.entries(serverObj)) {
    if (
      String(zone.clanName || "").toLowerCase() === q ||
      String(zone.tag || "").toLowerCase() === q ||
      String(zone.zoneName || "").toLowerCase() === q
    ) {
      return { roleId, zone };
    }
  }

  return null;
}

async function refreshZoneMembershipSnapshots(rce) {
  const allZones = readZorp();
  let changed = false;

  for (const [guildId, guildObj] of Object.entries(allZones)) {
    for (const [serverId, serverObj] of Object.entries(guildObj || {})) {
      for (const [roleId, zone] of Object.entries(serverObj || {})) {
        const freshClan = getClanByRoleId(guildId, serverId, roleId);

        if (!freshClan) {
          try {
            await sendRceCommand(rce, serverId, `deletecustomzone "${escapeQuotes(zone.zoneName)}"`);
          } catch {}
          await announceZone(
            rce,
            serverId,
            `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was removed because the clan no longer exists.`
          );
          delete allZones[guildId][serverId][roleId];
          runtime.delete(zoneKey(guildId, serverId, roleId));
          changed = true;
          continue;
        }

        const oldMembers = JSON.stringify(zone.memberIds || []);
        const oldName = zone.clanName;
        const oldTag = zone.tag;

        updateZoneSnapshotFromClan(zone, freshClan);

        if (
          oldMembers !== JSON.stringify(zone.memberIds || []) ||
          oldName !== zone.clanName ||
          oldTag !== zone.tag
        ) {
          changed = true;
        }
      }
    }
  }

  if (changed) writeZorp(allZones);
}

async function enforceGraceZonesForServer(rce, serverId, onlineSet, graceZones) {
  const lastAt = lastGraceSweepAt.get(serverId) || 0;
  const now = Date.now();
  if (now - lastAt < GRACE_SWEEP_MS) return;
  lastGraceSweepAt.set(serverId, now);

  const players = [...onlineSet];
  const positions = new Map();

  for (const playerName of players) {
    try {
      const raw = await sendRceCommand(rce, serverId, `printpos "${escapeQuotes(playerName)}"`);
      const pos = parsePrintPos(raw);
      if (pos) positions.set(playerName, pos);
    } catch {}
  }

  for (const zone of graceZones) {
    for (const [playerName, pos] of positions.entries()) {
      if (isGamertagInZoneClan(zone, playerName)) continue;

      const dx = Number(pos.x) - Number(zone.coords.x);
      const dz = Number(pos.z) - Number(zone.coords.z);
      const dist2d = Math.sqrt(dx * dx + dz * dz);

      if (dist2d <= Number(zone.radius || 0)) {
        try {
          await sendRceCommand(rce, serverId, `global.killplayer "${escapeQuotes(playerName)}"`);
        } catch {}
      }
    }
  }
}

function getPublicChannel(interaction) {
  return interaction.channel ?? null;
}

async function sendPublicEmbed(interaction, embed) {
  const ch = getPublicChannel(interaction);
  if (!ch) return null;
  return ch.send({ embeds: [embed] }).catch(() => null);
}

async function computeNormalZoneState(zone, onlineCount, now) {
  if (onlineCount >= 1) {
    return {
      status: "off",
      visualState: "green",
      color: GREEN_RGB,
      damage: 1,
      radiation: 0,
      belowSince: null,
    };
  }

  const key = zoneKey(zone.guildId, zone.serverId, zone.roleId);
  const rt = getRuntime(key);
  if (!rt.belowSince) rt.belowSince = now;

  const shouldBeRed = now - rt.belowSince >= RED_DELAY_MS;

  if (shouldBeRed) {
    return {
      status: "on",
      visualState: "red",
      color: RED_RGB,
      damage: 0,
      radiation: onlineCount === 0 ? 300 : 0,
      belowSince: rt.belowSince,
    };
  }

  return {
  status: "off",
  visualState: "yellow",
  color: YELLOW_RGB,
  damage: 1,
  radiation: 0,
  belowSince: rt.belowSince,
};
}

async function processZoneState(rce, zone, onlineCount, now) {
  const key = zoneKey(zone.guildId, zone.serverId, zone.roleId);
  const rt = getRuntime(key);

  const prevStatus = zone.status || "off";
  const prevVisual = zone.visualState || "green";

  if (zone.forceUntil && now >= Number(zone.forceUntil)) {
    const old = zone.forceState;
    zone.forceUntil = null;
    zone.forceState = null;
    await announceZone(
      rce,
      zone.serverId,
      `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s forced ${String(old || "").toUpperCase()} has ended.`
    );
  }

  if (zone.graceUntil && now >= Number(zone.graceUntil)) {
    zone.graceUntil = null;
    zone.status = "off";
    zone.visualState = "green";
    rt.belowSince = null;
    await setZoneVisual(rce, zone, GREEN_RGB, 1, 0);
    await announceZone(
      rce,
      zone.serverId,
      `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s grace has ended, zone is green and raidable.`
    );
    return;
  }

  if (zone.graceUntil) {
    if (onlineCount < 2) {
      zone.graceUntil = null;
      await announceZone(
        rce,
        zone.serverId,
        `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s grace was cancelled because the clan went inactive.`
      );
    } else {
      rt.belowSince = null;
      zone.status = "grace";
      zone.visualState = "grace";
      await setZoneVisual(rce, zone, GRACE_RGB, 0, 0);

      if (prevStatus !== "grace" || prevVisual !== "grace") {
        await announceZone(
          rce,
          zone.serverId,
          `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone is now on grace.`
        );
      }

      return;
    }
  }

  if (zone.forceUntil && zone.forceState) {
    rt.belowSince = null;

    if (zone.forceState === "on") {
      zone.status = "on";
      zone.visualState = "red";
      await setZoneVisual(rce, zone, RED_RGB, 0, 0);
      if (prevStatus !== "on" || prevVisual !== "red") {
        await announceZone(
          rce,
          zone.serverId,
          `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was forced On for 30 minutes.`
        );
      }
      return;
    }

    zone.status = "off";
    zone.visualState = "green";
    await setZoneVisual(rce, zone, GREEN_RGB, 1, 0);
    if (prevStatus !== "off" || prevVisual !== "green") {
      await announceZone(
        rce,
        zone.serverId,
        `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was forced Off for 30 minutes.`
      );
    }
    return;
  }

  const next = await computeNormalZoneState(zone, onlineCount, now);
  rt.belowSince = next.belowSince;

  zone.status = next.status;
  zone.visualState = next.visualState;

  await setZoneVisual(rce, zone, next.color, next.damage, next.radiation);

  if (prevVisual !== next.visualState || prevStatus !== next.status) {
    if (next.visualState === "yellow") {
      const remaining = Math.max(0, RED_DELAY_MS - (now - (rt.belowSince || now)));
      await announceZone(
        rce,
        zone.serverId,
        `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone is turning yellow, turns red in ${formatDurationShort(remaining)}.`
      );
    } else if (next.visualState === "red") {
      await announceZone(
        rce,
        zone.serverId,
        `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone is now red and protected.`
      );
    } else if (next.visualState === "green") {
      await announceZone(
        rce,
        zone.serverId,
        `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone is green and raidable.`
      );
    }
  }
}

async function scanAllZones(rce) {
  const now = Date.now();

  if (now - lastRefreshAt >= MEMBER_REFRESH_MS) {
    lastRefreshAt = now;
    await refreshZoneMembershipSnapshots(rce);
  }

  const allZones = readZorp();
  const byServer = new Map();
  let changed = false;

  for (const [guildId, guildObj] of Object.entries(allZones)) {
    for (const [serverId, serverObj] of Object.entries(guildObj || {})) {
      for (const [roleId, zone] of Object.entries(serverObj || {})) {
        const list = byServer.get(serverId) || [];
        list.push({ guildId, serverId, roleId, zone });
        byServer.set(serverId, list);
      }
    }
  }

  for (const [serverId, zoneRefs] of byServer.entries()) {
    let onlineSet = new Set();

    try {
      const usersRaw = await sendRceCommand(rce, serverId, "users");
      onlineSet = parseUsersResponse(usersRaw);
    } catch {
      continue;
    }

    const graceZones = [];

    for (const ref of zoneRefs) {
      const { guildId, roleId, zone } = ref;
      const key = zoneKey(guildId, serverId, roleId);

      const totalMembers = Array.isArray(zone.memberIds) ? zone.memberIds.length : 0;
      const onlineCount = getOnlineCountForZone(zone, onlineSet);

      if (onlineCount > 0) {
        zone.lastAnyMemberOnlineAt = now;
      }

      const lastSeen = Number(zone.lastAnyMemberOnlineAt || zone.createdAt || now);
      if (onlineCount === 0 && now - lastSeen >= AUTO_DELETE_MS) {
        try {
          await sendRceCommand(rce, serverId, `deletecustomzone "${escapeQuotes(zone.zoneName)}"`);
        } catch {}
        await announceZone(
          rce,
          serverId,
          `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was removed after 16 hours with no clan members online.`
        );
        delete allZones[guildId][serverId][roleId];
        runtime.delete(key);
        changed = true;
        continue;
      }

      const beforeStatus = zone.status;
      const beforeVisual = zone.visualState;
      const beforeForceUntil = zone.forceUntil;
      const beforeGraceUntil = zone.graceUntil;

      zone.onlineCount = onlineCount;
      zone.totalMembers = totalMembers;

      await processZoneState(rce, { ...zone, guildId, serverId, roleId }, onlineCount, now);

      if (zone.graceUntil) {
        graceZones.push(zone);
      }

      if (
        beforeStatus !== zone.status ||
        beforeVisual !== zone.visualState ||
        beforeForceUntil !== zone.forceUntil ||
        beforeGraceUntil !== zone.graceUntil
      ) {
        changed = true;
      }

      changed = true;
    }

    if (graceZones.length) {
      await enforceGraceZonesForServer(rce, serverId, onlineSet, graceZones.map((z) => ({ ...z, serverId })));
    }
  }

  if (changed) writeZorp(allZones);
}

module.exports = {
  name: "clanzorp",

  init(client, rce) {
    let scanBusy = false;

    if (client.__clanZorpInterval) clearInterval(client.__clanZorpInterval);
    client.__clanZorpInterval = setInterval(async () => {
      if (scanBusy) return;
      scanBusy = true;
      try {
        await scanAllZones(rce);
      } catch (e) {
        console.error("[clanzorp] scan error:", e);
      } finally {
        scanBusy = false;
      }
    }, 1000);

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "zorp") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const q = String(focused.value || "").toLowerCase();
          const choices = listServers()
            .map((s) => ({
              name: String(s.displayName || s.identifier).slice(0, 100),
              value: s.identifier,
            }))
            .filter((c) => c.name.toLowerCase().includes(q))
            .slice(0, 25);

          return interaction.respond(choices).catch(() => {});
        }

        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "zorp") return;

          const sub = interaction.options.getSubcommand();
          const serverId = interaction.options.getString("server", true);
          const serverDisplay = resolveServerDisplay(serverId);
          const serverExists = listServers().some((s) => s.identifier === serverId);

          if (!serverExists) {
            return interaction.reply({
              content: ":x: Server not found.",
              flags: MessageFlags.Ephemeral,
            });
          }

          if (sub === "get") {
            const gamertag = getLinkedGamertag(interaction.user.id);
            if (!gamertag) {
              return interaction.reply({
                content: ":x: Your account isn't linked!",
                flags: MessageFlags.Ephemeral,
              });
            }

            const found = getUserClan(interaction.guildId, serverId, interaction.user.id);
            if (!found) {
              return interaction.reply({
                content: ":x: You must be in a clan to use clan zorp!",
                flags: MessageFlags.Ephemeral,
              });
            }

            if (String(found.clan.leaderId) !== String(interaction.user.id)) {
              return interaction.reply({
                content: ":x: You must be clan leader to use clan zorp!",
                flags: MessageFlags.Ephemeral,
              });
            }

            const memberIds = extractClanMemberIds(found.clan);
            if (memberIds.length < MIN_ZORP_MEMBERS) {
              const needed = MIN_ZORP_MEMBERS - memberIds.length;
              return interaction.reply({
                content: `:x: Your clan needs **${needed}** more members to be eligible for clan zorp!`,
                flags: MessageFlags.Ephemeral,
              });
            }

            const unlinked = getUnlinkedClanMembers(memberIds);
            if (unlinked.length) {
              return interaction.reply({
                content: ":x: Every clan member must be linked before you can place clan zorp!",
                flags: MessageFlags.Ephemeral,
              });
            }

            const existing = getZoneEntry(interaction.guildId, serverId, found.roleId);
            if (existing) {
              return interaction.reply({
                content: ":x: Your clan already has a zorp zone on this server!",
                flags: MessageFlags.Ephemeral,
              });
            }

            return interaction.reply({
              embeds: [makeInitialEmbed(serverDisplay)],
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`zorp_get_button|${serverId}`)
                    .setLabel("Get ZORP")
                    .setStyle(ButtonStyle.Success)
                ),
              ],
              flags: MessageFlags.Ephemeral,
            });
          }

          if (sub === "view") {
            const all = readZorp();
            const serverObj = all?.[interaction.guildId]?.[serverId] || {};
            const entries = Object.values(serverObj);

            if (!entries.length) {
              return interaction.reply({
                content: ":x: No zorp zones found for this server.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const embed = new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle(`ZORP zones on ${serverDisplay}`)
              .setDescription(
                entries
                  .slice(0, 25)
                  .map(
                    (z) =>
                      `• **${z.clanName}** [${z.tag}] - \`${z.grid}\` - **${z.sizeLabel || "Unknown"}** - **${formatStatus(z.status)}**`
                  )
                  .join("\n")
              )
              .setTimestamp();

            return interaction.reply({ embeds: [embed] });
          }

          if (sub === "check") {
            const found = getUserClan(interaction.guildId, serverId, interaction.user.id);
            if (!found) {
              return interaction.reply({
                content: ":x: You must be in a clan to use clan zorp!",
                flags: MessageFlags.Ephemeral,
              });
            }

            const zone = getZoneEntry(interaction.guildId, serverId, found.roleId);
            if (!zone) {
              return interaction.reply({
                content: ":x: Your clan does not have a zorp on this server.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const liveClan = getClanByRoleId(interaction.guildId, serverId, found.roleId);
            if (liveClan) {
              updateZoneSnapshotFromClan(zone, liveClan);
              setZoneEntry(interaction.guildId, serverId, found.roleId, zone);
            }

            let onlineSet = new Set();
            try {
              const usersRaw = await sendRceCommand(rce, serverId, "users");
              onlineSet = parseUsersResponse(usersRaw);
            } catch {}

            const totalMembers = Array.isArray(zone.memberIds) ? zone.memberIds.length : 0;
            const onlineCount = getOnlineCountForZone(zone, onlineSet);

            let autoDeletionValue = "Paused - clan online";
            if (onlineCount === 0) {
              const lastSeen = Number(zone.lastAnyMemberOnlineAt || zone.createdAt || Date.now());
              autoDeletionValue = `<t:${Math.floor((lastSeen + AUTO_DELETE_MS) / 1000)}:R>`;
            }

            return interaction.reply({
              embeds: [
                makeCheckEmbed({
                  clanName: zone.clanName,
                  tag: zone.tag,
                  roleId: found.roleId,
                  grid: zone.grid,
                  autoDeletionValue,
                  status: formatStatus(zone.status),
                  onlineCount,
                  totalMembers,
                }),
              ],
            });
          }

          if (sub === "remove") {
            if (!canManageZorp(interaction)) {
              return interaction.reply({
                content: ":x: Staff only.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const name = interaction.options.getString("name", true).trim();
            const all = readZorp();
            const serverObj = all?.[interaction.guildId]?.[serverId] || {};
            const entries = Object.entries(serverObj);

            if (!entries.length) {
              return interaction.reply({
                content: ":x: No zorp zones found for this server.",
                flags: MessageFlags.Ephemeral,
              });
            }

            if (name.toLowerCase() === "all") {
              let removed = 0;

              for (const [roleId, zone] of entries) {
                try {
                  await sendRceCommand(rce, serverId, `deletecustomzone "${escapeQuotes(zone.zoneName)}"`);
                } catch {}
                await announceZone(
                  rce,
                  serverId,
                  `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was removed.`
                );
                removeZoneEntry(interaction.guildId, serverId, roleId);
                runtime.delete(zoneKey(interaction.guildId, serverId, roleId));
                removed++;
              }

              return interaction.reply({
                content: `✅ Removed **${removed}** zorp zone(s).`,
                flags: MessageFlags.Ephemeral,
              });
            }

            const match = findZoneByClanText(interaction.guildId, serverId, name);
            if (!match) {
              return interaction.reply({
                content: ":x: Zorp zone not found.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const { roleId, zone } = match;

            try {
              await sendRceCommand(rce, serverId, `deletecustomzone "${escapeQuotes(zone.zoneName)}"`);
            } catch {}

            await announceZone(
              rce,
              serverId,
              `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was removed.`
            );

            removeZoneEntry(interaction.guildId, serverId, roleId);
            runtime.delete(zoneKey(interaction.guildId, serverId, roleId));

            return interaction.reply({
              content: `✅ Removed zorp for **${zone.clanName}** [${zone.tag}].`,
              flags: MessageFlags.Ephemeral,
            });
          }

          if (sub === "force") {
            const found = getUserClan(interaction.guildId, serverId, interaction.user.id);
            if (!found) {
              return interaction.reply({
                content: ":x: You must be in a clan to use clan zorp!",
                flags: MessageFlags.Ephemeral,
              });
            }

            if (String(found.clan.leaderId) !== String(interaction.user.id) && !canManageZorp(interaction)) {
              return interaction.reply({
                content: ":x: You must be clan leader to force clan zorp!",
                flags: MessageFlags.Ephemeral,
              });
            }

            const zone = getZoneEntry(interaction.guildId, serverId, found.roleId);
            if (!zone) {
              return interaction.reply({
                content: ":x: Your clan does not have a zorp on this server.",
                flags: MessageFlags.Ephemeral,
              });
            }

            if (zone.graceUntil) {
              return interaction.reply({
                content: ":x: You cant force a zone while grace is active.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const status = String(interaction.options.getString("status", true)).toLowerCase();
            if (!["on", "off"].includes(status)) {
              return interaction.reply({
                content: ":x: Invalid force status.",
                flags: MessageFlags.Ephemeral,
              });
            }

            zone.forceState = status;
            zone.forceUntil = Date.now() + FORCE_DURATION_MS;
            zone.status = status === "on" ? "on" : "off";
            zone.visualState = status === "on" ? "red" : "green";
            setZoneEntry(interaction.guildId, serverId, found.roleId, zone);
            resetRuntimeForZone(zoneKey(interaction.guildId, serverId, found.roleId));

            await announceZone(
              rce,
              serverId,
              `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone was forced ${status === "on" ? "On" : "Off"} for 30 minutes.`
            );

            return interaction.reply({
              content: `✅ Forced your clan zorp ${status === "on" ? "On" : "Off"} for 30 minutes.`,
              flags: MessageFlags.Ephemeral,
            });
          }

          if (sub === "grace") {
            if (!canManageZorp(interaction)) {
              return interaction.reply({
                content: ":x: Staff only.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const clanText = interaction.options.getString("clan", true);
            const timeValue = interaction.options.getString("time", true);
            const duration = parseGraceDuration(timeValue);

            if (!duration) {
              return interaction.reply({
                content: ":x: Invalid grace time.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const match = findZoneByClanText(interaction.guildId, serverId, clanText);
            if (!match) {
              return interaction.reply({
                content: ":x: Zorp zone not found.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const { roleId, zone } = match;
            zone.forceState = null;
            zone.forceUntil = null;
            zone.graceUntil = Date.now() + duration;
            zone.status = "grace";
            zone.visualState = "grace";
            setZoneEntry(interaction.guildId, serverId, roleId, zone);
            resetRuntimeForZone(zoneKey(interaction.guildId, serverId, roleId));

            await announceZone(
              rce,
              serverId,
              `<color=orange><b>[ZORP]</b></color> ${zone.clanName} [${zone.tag}]'s zone is now on grace.`
            );

            return interaction.reply({
              content: `✅ Grace enabled for **${zone.clanName}** [${zone.tag}] for ${formatDurationShort(duration)}.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        if (interaction.isButton()) {
          if (!interaction.customId.startsWith("zorp_get_button|")) return;

          const [, serverId] = interaction.customId.split("|");
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const gamertag = getLinkedGamertag(interaction.user.id);
          if (!gamertag) {
            return interaction.editReply({ content: ":x: Your account isn't linked!" });
          }

          const found = getUserClan(interaction.guildId, serverId, interaction.user.id);
          if (!found) {
            return interaction.editReply({ content: ":x: You must be in a clan to use clan zorp!" });
          }

          if (String(found.clan.leaderId) !== String(interaction.user.id)) {
            return interaction.editReply({ content: ":x: You must be clan leader to use clan zorp!" });
          }

          const memberIds = extractClanMemberIds(found.clan);
          if (memberIds.length < MIN_ZORP_MEMBERS) {
            const needed = MIN_ZORP_MEMBERS - memberIds.length;
            return interaction.editReply({
              content: `:x: Your clan needs **${needed}** more members to be eligible for clan zorp!`,
            });
          }

          const unlinked = getUnlinkedClanMembers(memberIds);
          if (unlinked.length) {
            return interaction.editReply({
              content: ":x: Every clan member must be linked before you can place clan zorp!",
            });
          }

          const existing = getZoneEntry(interaction.guildId, serverId, found.roleId);
          if (existing) {
            return interaction.editReply({
              content: ":x: Your clan already has a zorp zone on this server!",
            });
          }

          const printPosRaw = await sendRceCommand(rce, serverId, `printpos "${escapeQuotes(gamertag)}"`);
          const pos = parsePrintPos(printPosRaw);

          if (!pos) {
            return interaction.editReply({
              content: ":x: Failed to get your in-game position.",
            });
          }

          const closeZone = getTooCloseZone(interaction.guildId, serverId, pos.x, pos.z);
          if (closeZone) {
            return interaction.editReply({
              content: `You cant put your clan ZORP so close to **${closeZone.zone.clanName}** [${closeZone.zone.tag}], mover **${closeZone.moveAway}** metres away to place it!`,
            });
          }

          const { label: sizeLabel, radius } = getZoneSize(memberIds.length);
          const zoneName = buildZoneName(found.clan.name, found.clan.tag);
          const zoneNameEsc = escapeQuotes(zoneName);
          const grid = gridSquareFromCoords(pos.x, pos.z);

          const createRaw = await sendRceCommand(
            rce,
            serverId,
            `createcustomzone "${zoneNameEsc}" (${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}) 45 sphere ${radius}`
          );

          const createText = String(createRaw || "");
          const createdOk = createText.includes("[CreateCustomZone] Successfully created zone [");

          if (!createdOk) {
            const failedEmbed = makeFailedCreateEmbed({
              clanName: found.clan.name,
              tag: found.clan.tag,
              roleId: found.roleId,
              grid,
              sizeLabel,
            });

            await sendPublicEmbed(interaction, failedEmbed);

            return interaction.editReply({
              content: "Zone creation failed, please contact support.",
            });
          }

          await sleep(1000);
          await sendRceCommand(rce, serverId, `editcustomzone "${zoneNameEsc}" color ${GREEN_RGB}`);
          await sendRceCommand(rce, serverId, `editcustomzone "${zoneNameEsc}" allowbuildingdamage 1`);
          await sendRceCommand(rce, serverId, `editcustomzone "${zoneNameEsc}" radiationdamage "0"`);

          const now = Date.now();
          const entry = {
            guildId: interaction.guildId,
            serverId,
            serverDisplay: resolveServerDisplay(serverId),
            roleId: found.roleId,
            leaderId: String(found.clan.leaderId),
            clanName: found.clan.name,
            tag: found.clan.tag,
            zoneName,
            coords: { x: pos.x, y: pos.y, z: pos.z },
            grid,
            sizeLabel,
            radius,
            createdAt: now,
            lastAnyMemberOnlineAt: now,
            memberIds,
            totalMembers: memberIds.length,
            onlineCount: 0,
            status: "off",
            visualState: "green",
            forceState: null,
            forceUntil: null,
            graceUntil: null,
          };

          setZoneEntry(interaction.guildId, serverId, found.roleId, entry);

          runtime.set(zoneKey(interaction.guildId, serverId, found.roleId), {
            belowSince: null,
            appliedColor: GREEN_RGB,
            appliedRadiation: "0",
            appliedDamage: "1",
          });

          await sendPublicEmbed(
            interaction,
            makeCreatedEmbed({
              clanName: found.clan.name,
              tag: found.clan.tag,
              roleId: found.roleId,
              grid,
              sizeLabel,
              status: "off",
            })
          );

          await announceZone(
            rce,
            serverId,
            `<color=orange><b>[ZORP]</b></color> ${found.clan.name} [${found.clan.tag}]'s zone was created.`
          );

          return interaction.editReply({
            content: "✅ ZORP created.",
          });
        }
      } catch (e) {
        console.error("[clanzorp] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({
              content: ":x: Error. Check console.",
              flags: MessageFlags.Ephemeral,
            });
          } catch {}
        }
      }
    });
  },
};