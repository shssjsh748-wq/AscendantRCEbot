const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
} = require("discord.js");
const { RCEEvent } = require("rce.js");

const { listServers } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const CFG_PATH = path.join(__dirname, "rce_logs.json");

const GLOBAL_KEY = "_global";
const downAlerts = new Map();

const LOG_TYPES = [
  { key: "kits", label: "Kits claiming", emoji: "🎁", section: "bot" },
  { key: "spawn", label: "Spawn logs", emoji: "📦", section: "bot" },
  { key: "wheeltp", label: "Wheel teleports", emoji: "🛞", section: "bot" },
  { key: "console", label: "Console", emoji: "🖥️", section: "bot" },
  { key: "linking", label: "Linking", emoji: "🔗", section: "bot" },
  { key: "wheelkits", label: "Wheel Kits", emoji: "🎰", section: "bot" },
  { key: "serverstatus", label: "Server Status", emoji: "⚠️", section: "bot" },
  { key: "playerlogs", label: "Player Logs", emoji: "👤", section: "rce" },
  { key: "authlevels", label: "Auth Levels", emoji: "📈", section: "rce" },
];

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
  return readJsonSafe(ROLES_PATH, { adminRoleId: null, ownerRoleId: null, consoleRoleId: null });
}

function readCfg() {
  return readJsonSafe(CFG_PATH, {});
}

function writeCfg(data) {
  writeJsonSafe(CFG_PATH, data);
}

function ensureScopeCfg(guildId, scopeKey) {
  const all = readCfg();
  if (!all[guildId]) all[guildId] = {};
  if (!all[guildId][scopeKey]) all[guildId][scopeKey] = {};
  return all;
}

function isOwner(interaction) {
  const roles = readRoles();
  const cache = interaction.member?.roles?.cache;
  if (!cache) return false;
  return !!(roles.ownerRoleId && cache.has(roles.ownerRoleId));
}

function canEdit(interaction, ownerId) {
  return interaction.user.id === ownerId || isOwner(interaction);
}

function serverExists(serverId) {
  return listServers().some((s) => s.identifier === serverId);
}

function lineFor(cfg, key, label) {
  const channelId = cfg?.[key];
  return channelId ? `✅ ${label} - <#${channelId}>` : `❌ ${label}`;
}

function buildEmbed(serverId, cfg) {
  const bot = LOG_TYPES.filter((x) => x.section === "bot")
    .map((x) => lineFor(cfg, x.key, x.label))
    .join("\n");

  const rce = LOG_TYPES.filter((x) => x.section === "rce")
    .map((x) => lineFor(cfg, x.key, x.label))
    .join("\n");

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("RCE Logs configuration ⚙️")
    .setDescription(
      `**Server:** \`${serverId}\`\n\n` +
        `__**Bot Logs**__\n${bot}\n\n` +
        `__**RCE Logs**__\n${rce}`
    )
    .setFooter({ text: "Only the command user or an owner can edit this panel." });
}

function buildButtons(serverId, ownerId) {
  const rows = [];
  for (let i = 0; i < LOG_TYPES.length; i += 5) {
    const chunk = LOG_TYPES.slice(i, i + 5);
    rows.push(
      new ActionRowBuilder().addComponents(
        chunk.map((x) =>
          new ButtonBuilder()
            .setCustomId(`rlogs_btn:${ownerId}:${serverId}:${x.key}`)
            .setLabel(x.label)
            .setEmoji(x.emoji)
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }
  return rows;
}

function buildSelect(serverId, ownerId, key) {
  const meta = LOG_TYPES.find((x) => x.key === key);
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`rlogs_sel:${ownerId}:${serverId}:${key}`)
      .setPlaceholder(`Select channel for ${meta?.label || key}`)
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText)
  );
}

async function sendConfiguredLog(client, guildId, serverId, key, payload = {}) {
  try {
    const cfg = readCfg();

    const channelId =
      (serverId ? cfg?.[guildId]?.[serverId]?.[key] : null) ||
      cfg?.[guildId]?.[GLOBAL_KEY]?.[key];

    if (!channelId) return false;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    await channel.send(payload).catch(() => {});
    return true;
  } catch (e) {
    console.error("[rcelogs] sendConfiguredLog error:", e);
    return false;
  }
}

function safeName(v, max = 80) {
  return String(v || "Unknown").trim().slice(0, max) || "Unknown";
}

function isDangerousRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "owner" || r === "admin" || r === "moderator";
}

function authAddMessage(ign, role) {
  const roleName = safeName(role, 40);
  if (isDangerousRole(roleName)) {
    return `**${safeName(ign)}** was given **${roleName}**! :warning: This is a dangerous permission to handout.`;
  }
  return `**${safeName(ign)}** was given **${roleName}**`;
}

function authRemoveMessage(ign, role) {
  const roleName = safeName(role, 40);
  if (isDangerousRole(roleName)) {
    return `**${safeName(ign)}** had **${roleName}** removed! :warning: Dangerous permission changed.`;
  }
  return `**${safeName(ign)}** had **${roleName}** removed`;
}

async function sendServerStatusToConfiguredGuilds(client, serverId, content) {
  const cfg = readCfg();
  for (const guildId of Object.keys(cfg || {})) {
    if (!cfg?.[guildId]?.[serverId]?.serverstatus) continue;
    await sendConfiguredLog(client, guildId, serverId, "serverstatus", { content });
  }
}

module.exports = {
  name: "rcelogs",
  sendConfiguredLog,

  init(client, rce) {


    client.on("serverStatusChange", async ({ identifier, online }) => {
      try {
        const serverId = safeName(identifier, 100);

        if (downAlerts.has(serverId)) {
          clearTimeout(downAlerts.get(serverId));
          downAlerts.delete(serverId);
        }

        if (online) {
          await sendServerStatusToConfiguredGuilds(
            client,
            serverId,
            `🟢 **${serverId}** has came online!`
          );
          return;
        }

        await sendServerStatusToConfiguredGuilds(
          client,
          serverId,
          `🔴 **${serverId}** has gone down!`
        );

        const timeout = setTimeout(async () => {
          downAlerts.delete(serverId);
          await sendServerStatusToConfiguredGuilds(
            client,
            serverId,
            `⚠️ **${serverId}** has been down for over 10 minutes!`
          );
        }, 10 * 60 * 1000);

        downAlerts.set(serverId, timeout);
      } catch (e) {
        console.error("[rcelogs] serverStatusChange error:", e);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "configure-logs") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const q = String(focused.value || "").toLowerCase();
        const choices = listServers()
          .map((s) => ({
            name: (s.displayName || s.identifier).slice(0, 100),
            value: s.identifier,
          }))
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 25);

        await interaction.respond(choices).catch(() => {});
      } catch (e) {
        console.error("[rcelogs] autocomplete error:", e);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "configure-logs") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner role only.", flags: MessageFlags.Ephemeral });
        }

        const serverId = interaction.options.getString("server", true);
        if (!serverExists(serverId)) {
          return interaction.reply({ content: "Unknown server.", flags: MessageFlags.Ephemeral });
        }

        const all = ensureScopeCfg(interaction.guildId, serverId);
        ensureScopeCfg(interaction.guildId, GLOBAL_KEY);
        writeCfg(all);

        const mergedCfg = {
          ...(all?.[interaction.guildId]?.[GLOBAL_KEY] || {}),
          ...(all?.[interaction.guildId]?.[serverId] || {}),
        };

        await interaction.reply({
          embeds: [buildEmbed(serverId, mergedCfg)],
          components: buildButtons(serverId, interaction.user.id),
        });
      } catch (e) {
        console.error("[rcelogs] command error:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "Error.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isButton()) return;
        if (!interaction.customId.startsWith("rlogs_btn:")) return;

        const [, ownerId, serverId, key] = interaction.customId.split(":");

        if (!canEdit(interaction, ownerId)) {
          return interaction.reply({ content: "You can't edit this panel.", flags: MessageFlags.Ephemeral });
        }

        await interaction.reply({
          content: `Select a channel for **${LOG_TYPES.find((x) => x.key === key)?.label || key}**`,
          components: [buildSelect(serverId, ownerId, key)],
          flags: MessageFlags.Ephemeral,
        });
      } catch (e) {
        console.error("[rcelogs] button error:", e);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChannelSelectMenu()) return;
        if (!interaction.customId.startsWith("rlogs_sel:")) return;

        const [, ownerId, serverId, key] = interaction.customId.split(":");

        if (!canEdit(interaction, ownerId)) {
          return interaction.reply({ content: "You can't edit this panel.", flags: MessageFlags.Ephemeral });
        }

        const channelId = interaction.values[0];
        const all = readCfg();

        if (!all[interaction.guildId]) all[interaction.guildId] = {};
        if (!all[interaction.guildId][serverId]) all[interaction.guildId][serverId] = {};
        all[interaction.guildId][serverId][key] = channelId;

        if (!all[interaction.guildId][GLOBAL_KEY]) all[interaction.guildId][GLOBAL_KEY] = {};
        if (["linking"].includes(key)) {
          all[interaction.guildId][GLOBAL_KEY][key] = channelId;
        }

        writeCfg(all);

        const mergedCfg = {
          ...(all?.[interaction.guildId]?.[GLOBAL_KEY] || {}),
          ...(all?.[interaction.guildId]?.[serverId] || {}),
        };

        const targetMessage = await interaction.channel.messages
          .fetch(interaction.message.reference?.messageId || interaction.message.id)
          .catch(() => null);

        const recent = await interaction.channel.messages.fetch({ limit: 20 }).catch(() => null);
        const panelMsg =
          recent?.find(
            (m) =>
              m.author.id === client.user.id &&
              m.components?.length &&
              m.embeds?.[0]?.title === "RCE Logs configuration ⚙️"
          ) || targetMessage;

        if (panelMsg) {
          await panelMsg.edit({
            embeds: [buildEmbed(serverId, mergedCfg)],
            components: buildButtons(serverId, ownerId),
          }).catch(() => {});
        }

        await interaction.update({
          content: `Saved <#${channelId}> for **${LOG_TYPES.find((x) => x.key === key)?.label || key}**`,
          components: [],
        });
      } catch (e) {
        console.error("[rcelogs] select error:", e);
      }
    });

    if (rce && typeof rce.on === "function") {
      rce.on(RCEEvent.PlayerJoined, async (payload) => {
        try {
          const serverId = payload?.server?.identifier;
          const ign = safeName(payload?.ign || payload?.player?.ign || payload?.player?.name);

          if (!serverId || !ign) return;

          const cfg = readCfg();
          for (const guildId of Object.keys(cfg || {})) {
            if (!cfg?.[guildId]?.[serverId]?.playerlogs) continue;

            await sendConfiguredLog(client, guildId, serverId, "playerlogs", {
              content: `🟢 **${ign}** has logged in!`,
            });
          }
        } catch (e) {
          console.error("[rcelogs] PlayerJoined error:", e);
        }
      });

      rce.on(RCEEvent.PlayerLeft, async (payload) => {
        try {
          const serverId = payload?.server?.identifier;
          const ign = safeName(payload?.player?.ign || payload?.ign || payload?.player?.name);

          if (!serverId || !ign) return;

          const cfg = readCfg();
          for (const guildId of Object.keys(cfg || {})) {
            if (!cfg?.[guildId]?.[serverId]?.playerlogs) continue;

            await sendConfiguredLog(client, guildId, serverId, "playerlogs", {
              content: `🔴 **${ign}** has logged out!`,
            });
          }
        } catch (e) {
          console.error("[rcelogs] PlayerLeft error:", e);
        }
      });

      rce.on(RCEEvent.PlayerRoleAdd, async (payload) => {
        try {
          const serverId = payload?.server?.identifier;
          const ign = safeName(payload?.player?.ign || payload?.ign || payload?.player?.name);
          const role = safeName(payload?.role, 40);

          if (!serverId || !ign || !role) return;

          const cfg = readCfg();
          for (const guildId of Object.keys(cfg || {})) {
            if (!cfg?.[guildId]?.[serverId]?.authlevels) continue;

            await sendConfiguredLog(client, guildId, serverId, "authlevels", {
              content: authAddMessage(ign, role),
            });
          }
        } catch (e) {
          console.error("[rcelogs] PlayerRoleAdd error:", e);
        }
      });

      if (RCEEvent.PlayerRoleRemove) {
        rce.on(RCEEvent.PlayerRoleRemove, async (payload) => {
          try {
            const serverId = payload?.server?.identifier;
            const ign = safeName(payload?.player?.ign || payload?.ign || payload?.player?.name);
            const role = safeName(payload?.role, 40);

            if (!serverId || !ign || !role) return;

            const cfg = readCfg();
            for (const guildId of Object.keys(cfg || {})) {
              if (!cfg?.[guildId]?.[serverId]?.authlevels) continue;

              await sendConfiguredLog(client, guildId, serverId, "authlevels", {
                content: authRemoveMessage(ign, role),
              });
            }
          } catch (e) {
            console.error("[rcelogs] PlayerRoleRemove error:", e);
          }
        });
      }
    }
  },
};
