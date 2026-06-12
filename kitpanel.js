// modules/kitpanel.js
const fs = require("fs");
const path = require("path");

const {
  ContainerBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const { listServers, getServer } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const KITS_PANEL_PATH = path.join(__dirname, "kits_panel.json");
const KITS_CFG_PATH = path.join(__dirname, "kits_config.json"); // reads configured kits

function log(...a) { console.log("[kitpanel]", ...a); }
function logErr(...a) { console.error("[kitpanel]", ...a); }

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logErr("readJsonSafe failed:", file, e?.message || e);
    return fallback;
  }
}
function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    logErr("writeJsonSafe failed:", file, e?.message || e);
  }
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, { consoleRoleId: null, adminRoleId: null, ownerRoleId: null });
}

function isOwner(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasDiscordAdmin);
}

function readPanels() {
  // {
  //   "guildId": {
  //     "messageId": { serverId, channelId, setBy, status: "enabled"|"disabled", createdAt, updatedAt }
  //   }
  // }
  return readJsonSafe(KITS_PANEL_PATH, {});
}
function writePanels(data) {
  writeJsonSafe(KITS_PANEL_PATH, data);
}

function readKitsCfg() {
  // {
  //   "guildId": {
  //     "serverId": { kits: [ { name, ingameKit, cooldownHours, roleId, addedBy, addedAt } ] }
  //   }
  // }
  return readJsonSafe(KITS_CFG_PATH, {});
}

function getConfiguredKits(guildId, serverId) {
  const all = readKitsCfg();
  const kits = all?.[guildId]?.[serverId]?.kits;
  return Array.isArray(kits) ? kits : [];
}

function resolveDisplayName(serverId) {
  const s = getServer(serverId);
  return (s?.displayName || s?.identifier || serverId).trim();
}

function ensureGuild(panels, guildId) {
  if (!panels[guildId]) panels[guildId] = {};
  return panels[guildId];
}

function renderKitsLines(kits) {
  if (!Array.isArray(kits) || kits.length === 0) return ["• *(No kits configured yet)*"];

  return kits.map((k) => {
    const name = String(k?.name || "Unknown").slice(0, 100);
    const roleId = typeof k?.roleId === "string" ? k.roleId : null;
    const cd = Number.isFinite(k?.cooldownHours) ? `${k.cooldownHours}h` : "0h";
    const ingameKit = String(k?.ingameKit || "kit_name").slice(0, 100);
    return `• **${name}** → **${roleId ? `<@&${roleId}>` : "No Role"}** → **${cd}** → **${ingameKit}**`;
  });
}

function buildPanelContainer({ serverDisplay, kits, status }) {
  const enabled = status === "enabled";
  const kitsLines = renderKitsLines(kits);

  const enableDisableBtn = new ButtonBuilder()
    .setCustomId("kits_toggle")
    .setLabel(enabled ? "Disable" : "Enable")
    .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success);

  const wipeCooldownsBtn = new ButtonBuilder()
    .setCustomId("kits_wipe_cooldowns")
    .setLabel("Wipe Cooldowns")
    .setStyle(ButtonStyle.Secondary);

  return new ContainerBuilder()
    .setAccentColor(0x95a5a6) // green
    .addTextDisplayComponents((t) =>
      t.setContent(
        [
          "## **Kits Panel**",
          `> Server: **${serverDisplay}**`,
          "",
          "**Configured Kits:**",
          ...kitsLines,
        ].join("\n")
      )
    )
    .addSeparatorComponents((s) => s)
    .addActionRowComponents((row) => row.setComponents(enableDisableBtn, wipeCooldownsBtn))
    .addTextDisplayComponents((t) =>
      t.setContent(
        [
          "**Kits status:**",
          `Global Status: **${enabled ? "Enabled" : "Disabled"}**`,
        ].join("\n")
      )
    );
}

// IMPORTANT: V2 messages cannot be edited with content/embeds — components only.
async function updatePanelMessage(guild, messageId, panelRow) {
  const channel = await guild.channels.fetch(panelRow.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return false;

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return false;

  const serverDisplay = resolveDisplayName(panelRow.serverId);
  const kits = getConfiguredKits(guild.id, panelRow.serverId);

  const container = buildPanelContainer({
    serverDisplay,
    kits,
    status: panelRow.status || "disabled",
  });

  await msg.edit({ components: [container] }).catch(() => {});
  return true;
}

module.exports = {
  name: "kitpanel",

  // accept (client, rce) because your loader passes both
  init(client, rce) {


    // Refresh panels when kits are added/removed elsewhere
    client.on("kits:refreshPanels", async ({ guildId, serverId } = {}) => {
      try {
        if (!guildId || !serverId) return;

        const panels = readPanels();
        const gPanels = panels?.[guildId];
        if (!gPanels) return;

        const guild =
          client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) return;

        let refreshed = 0;
        for (const [messageId, row] of Object.entries(gPanels)) {
          if (!row || row.serverId !== serverId) continue;
          const ok = await updatePanelMessage(guild, messageId, row);
          if (ok) refreshed++;
        }

        log("kits:refreshPanels", { guildId, serverId, refreshed });
      } catch (e) {
        logErr("kits:refreshPanels error:", e?.message || e);
      }
    });

    // Autocomplete ONLY for /kits-config panel server
    // (prevents collisions with kitsconfig.js autocomplete for add/remove)
    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isAutocomplete()) return;
      if (interaction.commandName !== "kits-config") return;

      const sub = interaction.options.getSubcommand(false);
      if (sub !== "panel") return;

      const focused = interaction.options.getFocused(true);
      if (focused.name !== "server") return;

      try {
        const servers = listServers();
        const q = String(focused.value || "").toLowerCase();

        const choices = servers
          .map((s) => ({
            name: (s.displayName || s.identifier).slice(0, 100),
            value: s.identifier,
          }))
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 25);

        // if the interaction expired (10062), just ignore
        await interaction.respond(choices).catch((e) => {
          logErr("autocomplete respond failed:", e?.code || e?.message || e);
        });
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // /kits-config panel -> deploy panel (owner only)
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "kits-config") return;

        const sub = interaction.options.getSubcommand(false);
        if (sub !== "panel") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
        }

        const serverId = interaction.options.getString("server", true);

        const exists = listServers().some((s) => s.identifier === serverId);
        if (!exists) {
          return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
        }

        const serverDisplay = resolveDisplayName(serverId);

        const panelRow = {
          serverId,
          channelId: interaction.channelId,
          setBy: interaction.user.id,
          status: "disabled",
          createdAt: Date.now(),
        };

        const kits = getConfiguredKits(interaction.guildId, serverId);
        const container = buildPanelContainer({
          serverDisplay,
          kits,
          status: panelRow.status,
        });

        const msg = await interaction.channel.send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });

        const panels = readPanels();
        const g = ensureGuild(panels, interaction.guildId);
        g[msg.id] = panelRow;
        writePanels(panels);

        log("deployed", { guildId: interaction.guildId, serverId, messageId: msg.id, by: interaction.user.id });

        return interaction.reply({ content: "Kits panel deployed.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        logErr("deploy error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });

    // Buttons (only deployer can use)
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isButton()) return;
        if (interaction.customId !== "kits_toggle" && interaction.customId !== "kits_wipe_cooldowns") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        const messageId = interaction.message?.id;
        if (!messageId) return;

        const panels = readPanels();
        const row = panels?.[interaction.guildId]?.[messageId];
        if (!row) {
          return interaction.reply({ content: "This kits panel isn’t registered.", flags: MessageFlags.Ephemeral });
        }

        if (interaction.user.id !== row.setBy) {
          return interaction.reply({
            content: "Only the person who deployed this panel can use it.",
            flags: MessageFlags.Ephemeral,
          });
        }

        // Always ACK buttons fast (prevents “Unknown interaction”)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        if (interaction.customId === "kits_toggle") {
          row.status = row.status === "enabled" ? "disabled" : "enabled";
          row.updatedAt = Date.now();

          panels[interaction.guildId][messageId] = row;
          writePanels(panels);

          log("toggle", { guildId: interaction.guildId, messageId, status: row.status, by: interaction.user.id });

          await updatePanelMessage(interaction.guild, messageId, row);

          return interaction.editReply({
            content: `Kits are now **${row.status.toUpperCase()}**.`,
          });
        }

        if (interaction.customId === "kits_wipe_cooldowns") {
          log("wipe_cooldowns (placeholder)", { guildId: interaction.guildId, messageId, by: interaction.user.id });

          // Update panel anyway (future proof)
          await updatePanelMessage(interaction.guild, messageId, row);

          return interaction.editReply({ content: "Cooldowns wiped (placeholder)." });
        }
      } catch (e) {
        logErr("button error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};