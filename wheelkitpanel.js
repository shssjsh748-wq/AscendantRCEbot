// modules/wheelkitspanel.js
const fs = require("fs");
const path = require("path");

const {
  ContainerBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const { listServers, getServer } = require("../rce");

const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");
const WHEELKITS_PANEL_PATH = path.join(__dirname, "..", "data", "wheelkits_panel.json");
const WHEELKITS_CFG_PATH = path.join(__dirname, "..", "data", "wheelkits_config.json");
const WHEELKITS_COOLDOWNS_PATH = path.join(__dirname, "..", "data", "wheelkits_cooldowns.json");
const EMOTES_PATH = path.join(__dirname, "..", "data", "emotes.json");

function log(...a) {
  console.log("[wheelkitspanel]", ...a);
}
function logErr(...a) {
  console.error("[wheelkitspanel]", ...a);
}

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

function safe(s, max = 100) {
  return String(s || "").trim().slice(0, max) || "Unknown";
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
  return readJsonSafe(WHEELKITS_PANEL_PATH, {});
}
function writePanels(data) {
  writeJsonSafe(WHEELKITS_PANEL_PATH, data);
}

function ensureGuild(panels, guildId) {
  if (!panels[guildId]) panels[guildId] = {};
  return panels[guildId];
}

function readWheelkitsCfg() {
  // {
  //   "guildId": {
  //     "serverId": { wheelkits: [ { name, ingameKit?, cooldownHours, emoteName?, emote?, addedBy, addedAt } ] }
  //   }
  // }
  return readJsonSafe(WHEELKITS_CFG_PATH, {});
}

function getConfiguredWheelkits(guildId, serverId) {
  const all = readWheelkitsCfg();
  const kits = all?.[guildId]?.[serverId]?.wheelkits;
  return Array.isArray(kits) ? kits : [];
}

function readCooldowns() {
  return readJsonSafe(WHEELKITS_COOLDOWNS_PATH, {});
}
function writeCooldowns(data) {
  writeJsonSafe(WHEELKITS_COOLDOWNS_PATH, data);
}

function readEmotes() {
  return readJsonSafe(EMOTES_PATH, {});
}
function writeEmotes(data) {
  writeJsonSafe(EMOTES_PATH, data);
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function resolveDisplayName(serverId) {
  const s = getServer(serverId);
  return (s?.displayName || s?.identifier || serverId).toString().trim();
}

function renderWheelkitsLines(kits) {
  if (!Array.isArray(kits) || kits.length === 0) return ["• *(No wheelkits configured yet)*"];

  return kits.slice(0, 50).map((k) => {
    const name = safe(k?.name, 100);
    const cd = Number.isFinite(k?.cooldownHours) ? `${k.cooldownHours}h` : "0h";
    const ingameKit = safe(k?.ingameKit || "kit_name", 100);

    // IMPORTANT: show emote NAME only (never raw payload)
    const emoteName = safe(k?.emoteName || "No Emote", 100);

    return `• **${name}**  •  **${emoteName}**  •  **${cd}**  •  **${ingameKit}**`;
  });
}

function buildPanelContainer({ serverDisplay, kits, status }) {
  const enabled = status === "enabled";
  const lines = renderWheelkitsLines(kits);

  const enableDisableBtn = new ButtonBuilder()
    .setCustomId("wheelkits_toggle")
    .setLabel(enabled ? "Disable" : "Enable")
    .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success);

  const wipeCooldownsBtn = new ButtonBuilder()
    .setCustomId("wheelkits_wipe_cooldowns")
    .setLabel("Wipe Cooldowns")
    .setStyle(ButtonStyle.Secondary);

  const c = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents((t) =>
      t.setContent(["## **WheelKits Panel**", `> Server: **${safe(serverDisplay, 100)}**`].join("\n"))
    )
    .addSeparatorComponents((s) => s)
    .addTextDisplayComponents((t) => t.setContent(["**Configured WheelKits**", ...lines].join("\n")))
    .addSeparatorComponents((s) => s)
    .addActionRowComponents((row) => row.setComponents(enableDisableBtn, wipeCooldownsBtn))
    .addSeparatorComponents((s) => s)
    .addTextDisplayComponents((t) =>
      t.setContent(
        [
          "**Status**",
          `Global: **${enabled ? "Enabled" : "Disabled"}**`,
          "",
          "Tip: Use `/kits-config wheelkit-add/remove` then refresh happens automatically.",
        ].join("\n")
      )
    );

  if (Array.isArray(kits) && kits.length > 50) {
    c.addSeparatorComponents((s) => s).addTextDisplayComponents((t) =>
      t.setContent(`⚠️ Showing **50** of **${kits.length}** wheelkits.`)
    );
  }

  return c;
}

// V2: edit components only
async function updatePanelMessage(guild, messageId, row) {
  const channel = await guild.channels.fetch(row.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return false;

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return false;

  const serverDisplay = resolveDisplayName(row.serverId);
  const kits = getConfiguredWheelkits(guild.id, row.serverId);

  const container = buildPanelContainer({
    serverDisplay,
    kits,
    status: row.status || "disabled",
  });

  await msg.edit({ components: [container] }).catch(() => {});
  return true;
}

module.exports = {
  name: "wheelkitspanel",

  init(client) {


    // refresh when wheelkitsconfig emits
    client.on("wheelkits:refreshPanels", async ({ guildId, serverId } = {}) => {
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

        log("wheelkits:refreshPanels", { guildId, serverId, refreshed });
      } catch (e) {
        logErr("wheelkits:refreshPanels error:", e?.message || e);
      }
    });

    // autocomplete for /kits-config wheelkits-panel + wheelkit-add
    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isAutocomplete()) return;
      if (interaction.commandName !== "kits-config") return;

      const sub = interaction.options.getSubcommand(false);
      if (sub !== "wheelkits-panel" && sub !== "wheelkit-add" && sub !== "wheelkit-remove") return;

      const focused = interaction.options.getFocused(true);

      try {
        if (focused.name === "server") {
          const servers = listServers();
          const q = String(focused.value || "").toLowerCase();
          const choices = servers
            .map((s) => ({
              name: (s.displayName || s.identifier).slice(0, 100),
              value: s.identifier,
            }))
            .filter((c) => c.name.toLowerCase().includes(q))
            .slice(0, 25);
          return await interaction.respond(choices).catch((e) => {
            logErr("autocomplete respond failed:", e?.code || e?.message || e);
          });
        }

        if (focused.name === "emote" && sub === "wheelkit-add") {
          const emotes = readEmotes();
          const q = norm(focused.value);
          const choices = Object.entries(emotes)
            .filter(([name]) => !q || norm(name).includes(q))
            .map(([name, raw]) => ({ name: name.slice(0, 100), value: String(raw).slice(0, 100) }))
            .slice(0, 25);
          return await interaction.respond(choices).catch((e) => {
            logErr("autocomplete respond failed:", e?.code || e?.message || e);
          });
        }
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // /kits-config wheelkits-panel -> deploy panel (owner only)
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "kits-config") return;

        const sub = interaction.options.getSubcommand(false);
        if (sub !== "wheelkits-panel") return;

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
        const row = {
          serverId,
          channelId: interaction.channelId,
          setBy: interaction.user.id,
          status: "disabled",
          createdAt: Date.now(),
        };

        const kits = getConfiguredWheelkits(interaction.guildId, serverId);
        const container = buildPanelContainer({ serverDisplay, kits, status: row.status });

        const msg = await interaction.channel.send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });

        const panels = readPanels();
        const g = ensureGuild(panels, interaction.guildId);
        g[msg.id] = row;
        writePanels(panels);

        log("deployed", { guildId: interaction.guildId, serverId, messageId: msg.id, by: interaction.user.id });

        return interaction.reply({ content: "WheelKits panel deployed.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        logErr("deploy error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });

    // /kits-config wheelkit-add
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "kits-config") return;
        const sub = interaction.options.getSubcommand(false);
        if (sub !== "wheelkit-add") return;

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

        const displayName = interaction.options.getString("name", true).trim();
        const cooldownHours = interaction.options.getInteger("cooldown", true);
        const emoteRaw = interaction.options.getString("emote", true).trim();

        // Resolve the friendly name from the emote store (for display in the panel)
        const emotes = readEmotes();
        const emoteName = Object.entries(emotes).find(([, v]) => v === emoteRaw)?.[0] || emoteRaw;

        const cfg = readWheelkitsCfg();
        if (!cfg[interaction.guildId]) cfg[interaction.guildId] = {};
        if (!cfg[interaction.guildId][serverId]) cfg[interaction.guildId][serverId] = { wheelkits: [] };
        if (!Array.isArray(cfg[interaction.guildId][serverId].wheelkits)) {
          cfg[interaction.guildId][serverId].wheelkits = [];
        }

        const arr = cfg[interaction.guildId][serverId].wheelkits;
        const idx = arr.findIndex((k) => norm(k?.name) === norm(displayName));
        const entry = {
          name: displayName,
          cooldownHours,
          emote: emoteRaw,
          emoteName,
          addedBy: interaction.user.id,
          addedAt: Date.now(),
        };

        if (idx !== -1) {
          arr[idx] = { ...arr[idx], ...entry };
        } else {
          arr.push(entry);
        }

        writeJsonSafe(WHEELKITS_CFG_PATH, cfg);
        log("wheelkit-add", { guildId: interaction.guildId, serverId, displayName, emoteRaw });

        client.emit("wheelkits:refreshPanels", { guildId: interaction.guildId, serverId });

        return interaction.reply({
          content: `Saved wheelkit **${displayName}** with emote **${emoteName}** (${cooldownHours}h cooldown).`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (e) {
        logErr("wheelkit-add error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        }
      }
    });

    // /kits-config wheelkit-remove
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "kits-config") return;
        const sub = interaction.options.getSubcommand(false);
        if (sub !== "wheelkit-remove") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }
        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
        }

        const serverId = interaction.options.getString("server", true);
        const nameInput = interaction.options.getString("name", true);
        const needle = norm(nameInput);

        const cfg = readWheelkitsCfg();
        const arr = cfg?.[interaction.guildId]?.[serverId]?.wheelkits;
        if (!Array.isArray(arr)) {
          return interaction.reply({ content: "No wheelkits configured for that server.", flags: MessageFlags.Ephemeral });
        }

        const before = arr.length;
        cfg[interaction.guildId][serverId].wheelkits = arr.filter((k) => norm(k?.name) !== needle);
        const after = cfg[interaction.guildId][serverId].wheelkits.length;

        writeJsonSafe(WHEELKITS_CFG_PATH, cfg);
        log("wheelkit-remove", { guildId: interaction.guildId, serverId, nameInput, removed: before - after });

        client.emit("wheelkits:refreshPanels", { guildId: interaction.guildId, serverId });

        return interaction.reply({
          content: before === after ? "No wheelkit matched that name." : `Removed **${before - after}** wheelkit(s).`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (e) {
        logErr("wheelkit-remove error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        }
      }
    });

        // panel buttons (only deployer can use)
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isButton()) return;
        if (interaction.customId !== "wheelkits_toggle" && interaction.customId !== "wheelkits_wipe_cooldowns") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        const messageId = interaction.message?.id;
        if (!messageId) return;

        const panels = readPanels();
        const row = panels?.[interaction.guildId]?.[messageId];
        if (!row) {
          return interaction.reply({ content: "This wheelkits panel isn’t registered.", flags: MessageFlags.Ephemeral });
        }

        if (interaction.user.id !== row.setBy) {
          return interaction.reply({
            content: "Only the person who deployed this panel can use it.",
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        if (interaction.customId === "wheelkits_toggle") {
          row.status = row.status === "enabled" ? "disabled" : "enabled";
          row.updatedAt = Date.now();

          panels[interaction.guildId][messageId] = row;
          writePanels(panels);

          await updatePanelMessage(interaction.guild, messageId, row);

          return interaction.editReply({
            content: `WheelKits are now **${row.status.toUpperCase()}**.`,
          });
        }

        if (interaction.customId === "wheelkits_wipe_cooldowns") {
          // ✅ make wipe robust for both possible shapes:
          // A) { guildId: { serverId: ... } }
          // B) { serverId: ... }
          const all = readCooldowns();
          const gid = interaction.guildId;
          const sid = row.serverId;

          let wiped = 0;

          if (all && typeof all === "object") {
            if (all?.[gid] && typeof all[gid] === "object" && sid in all[gid]) {
              delete all[gid][sid];
              wiped++;
            }

            if (sid in all) {
              delete all[sid];
              wiped++;
            }
          }

          // always write so it actually persists (even if it was already empty)
          writeCooldowns(all);

          log("wipe_cooldowns", { guildId: gid, serverId: sid, messageId, by: interaction.user.id, wiped });

          await updatePanelMessage(interaction.guild, messageId, row);

          return interaction.editReply({ content: "✅ WheelKits cooldowns wiped for this server." });
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