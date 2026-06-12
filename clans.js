const fs = require("fs");
const path = require("path");
const { MessageFlags, PermissionFlagsBits } = require("discord.js");

const { listServers } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const CLANS_CFG_PATH = path.join(__dirname, "clans_config.json");

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

function isOwner(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasAdminPerm = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasAdminPerm);
}

function ensureGuildServer(cfg, guildId, serverId) {
  if (!cfg[guildId]) cfg[guildId] = {};
  if (!cfg[guildId][serverId]) {
    cfg[guildId][serverId] = {
      type: null, // "default" | "advanced"
      requestChannelId: null,
      setAt: null,
      setBy: null,
    };
  }
  return cfg[guildId][serverId];
}

module.exports = {
  name: "clans",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // -------- AUTOCOMPLETE (server) --------
        if (interaction.isAutocomplete()) {
          const cmd = interaction.commandName;
          if (cmd !== "setup-clans" && cmd !== "setup-clanrequests") return;

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

        // -------- /setup-clans --------
        if (interaction.isChatInputCommand() && interaction.commandName === "setup-clans") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const type = interaction.options.getString("type", true); // "default" | "advanced"

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists) {
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
          }

          const cfg = readJsonSafe(CLANS_CFG_PATH, {});
          const row = ensureGuildServer(cfg, interaction.guildId, serverId);

          row.type = type;
          row.setAt = Date.now();
          row.setBy = interaction.user.id;

          writeJsonSafe(CLANS_CFG_PATH, cfg);

          console.log("[clans] setup-clans:", { guildId: interaction.guildId, serverId, type });

          return interaction.reply({
            content: `Saved clans type for **${serverId}** -> **${type}**`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // -------- /setup-clanrequests (ADVANCED ONLY) --------
        if (interaction.isChatInputCommand() && interaction.commandName === "setup-clanrequests") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const channel = interaction.options.getChannel("channel", true);

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists) {
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
          }

          const cfg = readJsonSafe(CLANS_CFG_PATH, {});
          const row = ensureGuildServer(cfg, interaction.guildId, serverId);

          if (row.type !== "advanced") {
            return interaction.reply({
              content: "This is for **Advanced** clans only. Use `/setup-clans` and set type to **Advanced** first.",
              flags: MessageFlags.Ephemeral,
            });
          }

          row.requestChannelId = channel.id;
          row.setAt = Date.now();
          row.setBy = interaction.user.id;

          writeJsonSafe(CLANS_CFG_PATH, cfg);

          console.log("[clans] setup-clanrequests:", { guildId: interaction.guildId, serverId, channelId: channel.id });

          return interaction.reply({
            content: `Saved clan request channel for **${serverId}** -> <#${channel.id}>`,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        console.error("[clans] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};