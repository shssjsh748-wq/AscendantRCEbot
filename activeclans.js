// modules/activeclans.js
const fs = require("fs");
const path = require("path");

const { PermissionFlagsBits, MessageFlags, ContainerBuilder } = require("discord.js");
const { listServers, getServer } = require("../rce");

const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");
const CFG_PATH = path.join(__dirname, "..", "data", "activeclans_config.json");
const CLANS_PATH = path.join(__dirname, "..", "data", "clans.json");

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

function readRoles() {
  return readJsonSafe(ROLES_PATH, { consoleRoleId: null, adminRoleId: null, ownerRoleId: null });
}
function readClans() {
  return readJsonSafe(CLANS_PATH, {});
}

function isOwner(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasAdminRole = cfg.adminRoleId && cache?.has(cfg.adminRoleId);
  return Boolean(hasOwnerRole || hasAdminRole);
}

function resolveDisplayName(serverId) {
  const s = getServer(serverId);
  if (!s) return serverId;
  return (s.displayName || s.identifier || serverId).trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatLastUpdated(now) {
  const hh = pad2(now.getHours());
  const mm = pad2(now.getMinutes());
  return `Last updated Today at ${hh}:${mm}`;
}

function getServerClanMap(all, guildId, serverId) {
  return all?.[guildId]?.[serverId] || {};
}

// ✅ stable: uses clans.json member arrays (updates immediately on join/leave)
async function getClanStatsForPanelLive({ guildId, serverId, minimum }) {
  const all = readClans();
  const serverMap = getServerClanMap(all, guildId, serverId);

  const min = Number(minimum) > 1 ? Number(minimum) : 1;

  const entries = [];
  for (const clan of Object.values(serverMap)) {
    const roleId = clan?.roleId;
    if (!roleId) continue;

    const membersCount = Array.isArray(clan.members) ? clan.members.length : 0;
    entries.push({ roleId, membersCount });
  }

  // highest members on top
  const clans = entries
    .filter((c) => c.membersCount >= min)
    .sort((a, b) => b.membersCount - a.membersCount);

  const totalClans = Object.keys(serverMap || {}).length;
  const totalUsers = entries.reduce((sum, c) => sum + c.membersCount, 0);

  return { clans, totalClans, totalUsers };
}

function buildActiveClansPanel({ displayName, clans, totalClans, totalUsers, now }) {
  const clanLines =
    clans.length === 0
      ? ["- No active clans yet"]
      : clans.map((c) => `- <@&${c.roleId}> - ${c.membersCount} members`);

  const footer = `Clans ${totalClans} - Total Users ${totalUsers} - ${formatLastUpdated(now)}`;

  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents((t) =>
      t.setContent(
        [
          "## **Active Clans**",
          `> :white_check_mark: Here is the list for active clans on **${displayName}**`,
          `> Create/Join clans with **/clan create** & **/clan join**`,
        ].join("\n")
      )
    )
    .addSeparatorComponents((s) => s)
    .addTextDisplayComponents((t) => t.setContent(clanLines.join("\n")))
    .addSeparatorComponents((s) => s)
    .addTextDisplayComponents((t) => t.setContent(footer));
}

async function refreshOnePanel(client, guildId, serverId, entry) {
  const { channelId, messageId, minimum } = entry || {};
  if (!channelId || !messageId) return;

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) throw new Error("PANEL_MESSAGE_MISSING");

  const displayName = resolveDisplayName(serverId);
  const now = new Date();

  const stats = await getClanStatsForPanelLive({ guildId, serverId, minimum });

  const container = buildActiveClansPanel({
    displayName,
    clans: stats.clans,
    totalClans: stats.totalClans,
    totalUsers: stats.totalUsers,
    now,
  });

  await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
}

async function refreshAllPanels(client) {
  const cfg = readJsonSafe(CFG_PATH, {});
  for (const guildId of Object.keys(cfg)) {
    const serversObj = cfg[guildId] || {};
    for (const serverId of Object.keys(serversObj)) {
      const entry = serversObj[serverId];
      if (!entry?.channelId || !entry?.messageId) continue;

      try {
        await refreshOnePanel(client, guildId, serverId, entry);
      } catch (e) {
        if (String(e?.message || "").includes("PANEL_MESSAGE_MISSING")) {
          const next = readJsonSafe(CFG_PATH, {});
          if (next?.[guildId]?.[serverId]) {
            next[guildId][serverId].messageId = null;
            writeJsonSafe(CFG_PATH, next);
          }
        }
      }
    }
  }
}

module.exports = {
  name: "activeclans",

  init(client) {
    

    // auto refresh loop (every 30s)
    setInterval(() => {
      refreshAllPanels(client).catch(() => {});
    }, 30_000);

    // ✅ your bot uses clientReady
    client.on("clientReady", () => {
      refreshAllPanels(client).catch(() => {});
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        // autocomplete for server
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "setup-activeclans") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const servers = listServers();
          const q = String(focused.value || "").toLowerCase();

          const choices = servers
            .map((s) => ({
              name: (s.displayName || s.identifier).slice(0, 100),
              value: s.identifier,
            }))
            .filter((c) => c.name.toLowerCase().includes(q))
            .slice(0, 25);

          return interaction.respond(choices).catch(() => {})
        }

        // /setup-activeclans
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "setup-activeclans") return;

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          if (!isOwner(interaction)) {
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const channel = interaction.options.getChannel("channel", true);
          const minimum = interaction.options.getInteger("minimum", true);

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists) {
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
          }

          const cfg = readJsonSafe(CFG_PATH, {});
          if (!cfg[interaction.guildId]) cfg[interaction.guildId] = {};
          cfg[interaction.guildId][serverId] = {
            channelId: channel.id,
            minimum,
            messageId: null,
            setAt: Date.now(),
            setBy: interaction.user.id,
          };
          writeJsonSafe(CFG_PATH, cfg);

          const displayName = resolveDisplayName(serverId);
          const now = new Date();

          const stats = await getClanStatsForPanelLive({
            guildId: interaction.guildId,
            serverId,
            minimum,
          });

          const msg = await channel.send({
            components: [
              buildActiveClansPanel({
                displayName,
                clans: stats.clans,
                totalClans: stats.totalClans,
                totalUsers: stats.totalUsers,
                now,
              }),
            ],
            flags: MessageFlags.IsComponentsV2,
          });

          cfg[interaction.guildId][serverId].messageId = msg.id;
          writeJsonSafe(CFG_PATH, cfg);

          return interaction.reply({
            content: "Active clans panel deployed.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        console.error("[activeclans] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};