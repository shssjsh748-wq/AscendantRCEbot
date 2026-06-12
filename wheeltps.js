// modules/wheeltps.js
const fs = require("fs");
const path = require("path");

const { MessageFlags, PermissionFlagsBits } = require("discord.js");
const { listServers } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const WHEELTPS_CFG_PATH = path.join(__dirname, "wheeltps_config.json");

function log(...a) { console.log("[wheeltps]", ...a); }
function logErr(...a) { console.error("[wheeltps]", ...a); }

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
  return readJsonSafe(ROLES_PATH, { ownerRoleId: null, adminRoleId: null });
}
function isOwner(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasAdmin);
}

function readCfg() { return readJsonSafe(WHEELTPS_CFG_PATH, {}); }
function writeCfg(data) { writeJsonSafe(WHEELTPS_CFG_PATH, data); }

function norm(s) { return String(s || "").trim().toLowerCase(); }

function ensureSlot(cfg, guildId, serverId, direction) {
  if (!cfg[guildId]) cfg[guildId] = {};
  if (!cfg[guildId][serverId]) cfg[guildId][serverId] = {};
  if (!cfg[guildId][serverId][direction]) cfg[guildId][serverId][direction] = { enabled: false };
  return cfg[guildId][serverId][direction];
}

module.exports = {
  name: "wheeltps",

  init(client) {
    // Autocomplete: server option
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "wheel-tps") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const q = norm(focused.value);
        const choices = listServers()
          .map((s) => ({ name: (s.displayName || s.identifier).slice(0, 100), value: s.identifier }))
          .filter((c) => !q || c.name.toLowerCase().includes(q))
          .slice(0, 25);

        await interaction.respond(choices).catch(() => {});
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // /wheel-tps config + /wheel-tps status
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "wheel-tps") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }
        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();
        const serverId = interaction.options.getString("server", true);
        const exists = listServers().some((s) => s.identifier === serverId);
        if (!exists) {
          return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
        }

        const cfg = readCfg();

        if (sub === "config") {
          const direction = interaction.options.getString("emote", true);
          const name = interaction.options.getString("name", true).trim();
          const combatlock = interaction.options.getString("combatlock", true);
          const cooldown = interaction.options.getInteger("cooldown", true);
          const coordsMode = interaction.options.getString("coords", true);

          const slot = ensureSlot(cfg, interaction.guildId, serverId, direction);
          slot.name = name;
          slot.combatlock = combatlock === "on";
          slot.cooldownMinutes = cooldown;
          slot.coordsMode = coordsMode;
          if (!slot.coords) slot.coords = null;

          writeCfg(cfg);
          log("config saved", { guildId: interaction.guildId, serverId, direction, name });

          const coordsNote = coordsMode === "auto"
            ? "\n> Coordinates set to **Auto** — the destination will be captured from the player's position when they next use this slot."
            : "\n> Coordinates set to **Manual** — use `/wheel-tps set-coords` when available to enter XYZ.";

          return interaction.reply({
            content: [
              `Wheel teleport **${direction}** configured on **${serverId}**:`,
              `> Name: **${name}** | Cooldown: **${cooldown}m** | Combat lock: **${combatlock === "on" ? "On" : "Off"}**`,
              coordsNote,
            ].join("\n"),
            flags: MessageFlags.Ephemeral,
          });
        }

        if (sub === "status") {
          const direction = interaction.options.getString("emote", true);
          const type = interaction.options.getString("type", true);
          const enable = type === "enable";

          const directions = direction === "all" ? ["north", "south", "west"] : [direction];
          for (const dir of directions) {
            const slot = ensureSlot(cfg, interaction.guildId, serverId, dir);
            slot.enabled = enable;
          }

          writeCfg(cfg);
          log("status updated", { guildId: interaction.guildId, serverId, direction, enable });

          return interaction.reply({
            content: `Wheel teleport **${direction}** is now **${enable ? "enabled" : "disabled"}** on **${serverId}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        logErr("command error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        }
      }
    });
  },
};
