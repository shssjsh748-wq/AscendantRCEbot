const fs = require("fs");
const path = require("path");
const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const { listServers, getServer, rce } = require("../rce");

const CFG_PATH = path.join(__dirname, "..", "data", "outpost_config.json");
const CD_PATH = path.join(__dirname, "..", "data", "outpost_cooldowns.json");
const { readLinks } = require("../shared/links");
const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");
const COMBATLOCK_PATH = path.join(__dirname, "..", "data", "combatlock.json");

const pendingManual = new Map();

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}
function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}
function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function safeName(s, max = 100) {
  return String(s || "").trim().slice(0, max) || "Unknown";
}
function getRoleConfig() {
  return readJsonSafe(ROLES_PATH, {});
}
function isOwner(member) {
  const roles = getRoleConfig();
  const ownerRoleId = roles?.ownerRoleId;
  if (!member) return false;
  if (member.permissions?.has?.("Administrator")) return true;
  if (ownerRoleId && member.roles?.cache?.has(ownerRoleId)) return true;
  return false;
}
function whiteGreenEmbed(title, desc) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(`### ${title}\n\n${desc}`).setTimestamp();
}
function getServerDisplay(serverId) {
  try {
    const s = getServer(serverId);
    return String(s?.displayName || s?.identifier || serverId || "Unknown").trim();
  } catch {
    return String(serverId || "Unknown");
  }
}
function extractLinkedPlayerName(guildId, userId) {
  const data = readLinks();
  const directGuild = data?.[guildId]?.[userId];
  const direct = data?.[userId];
  const candidates = [directGuild, direct].filter(Boolean);

  for (const c of candidates) {
    if (typeof c === "string") return c;
    if (typeof c?.gamertag === "string") return c.gamertag;
    if (typeof c?.gt === "string") return c.gt;
    if (typeof c?.xbox === "string") return c.xbox;
    if (typeof c?.playerName === "string") return c.playerName;
    if (typeof c?.player === "string") return c.player;
    if (typeof c?.name === "string") return c.name;
  }
  return null;
}
function parseXYZ(text) {
  const m = String(text || "").match(/\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}
function getCfg() {
  return readJsonSafe(CFG_PATH, {});
}
function saveCfg(data) {
  writeJsonSafe(CFG_PATH, data);
}
function getCooldowns() {
  return readJsonSafe(CD_PATH, {});
}
function saveCooldowns(data) {
  writeJsonSafe(CD_PATH, data);
}
function getOutpostCfg(guildId, serverId) {
  return getCfg()?.[guildId]?.[serverId] || null;
}
function isCombatLocked(serverId, playerName) {
  const all = readJsonSafe(COMBATLOCK_PATH, {});
  const row = all?.[serverId]?.[norm(playerName)];
  if (!row) return false;
  return Number(row.until || 0) > Date.now();
}

module.exports = {
  name: "outpost",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (!["configure-outpost", "outpost"].includes(interaction.commandName)) return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const q = norm(focused.value);
          const choices = listServers()
            .map((s) => ({
              name: safeName(s.displayName || s.identifier, 100),
              value: s.identifier,
            }))
            .filter((x) => norm(x.name).includes(q))
            .slice(0, 25);

          return interaction.respond(choices).catch(() => {});
        }

        if (interaction.isModalSubmit()) {
          if (!interaction.customId.startsWith("configure_outpost_manual:")) return;

          const [, guildId, serverId, roleId, cooldown, combatlock, userId] = interaction.customId.split(":");
          if (interaction.user.id !== userId) return;

          const x = interaction.fields.getTextInputValue("x");
          const y = interaction.fields.getTextInputValue("y");
          const z = interaction.fields.getTextInputValue("z");

          const cfg = getCfg();
          const slot = ensure(cfg, guildId, serverId);
          slot.roleId = roleId;
          slot.cooldownMinutes = Number(cooldown) || 0;
          slot.combatlock = combatlock === "yes";
          slot.coords = { x: Number(x), y: Number(y), z: Number(z) };
          slot.updatedAt = Date.now();
          saveCfg(cfg);

          return interaction.reply({
            embeds: [
              whiteGreenEmbed(
                "Outpost Config Saved",
                `Saved outpost for **${safeName(getServerDisplay(serverId))}**.\nRole: <@&${roleId}>\nCooldown: **${slot.cooldownMinutes}** minute(s)\nCombat Lock: **${slot.combatlock ? "Yes" : "No"}**\nCoords: **(${slot.coords.x}, ${slot.coords.y}, ${slot.coords.z})**`
              ),
            ],
          }).catch(() => {});
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "configure-outpost") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server." }).catch(() => {});
          }

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!isOwner(member)) {
            return interaction.reply({ content: "You do not have permission." }).catch(() => {});
          }

          const guildId = interaction.guildId;
          const serverId = interaction.options.getString("server", true);
          const role = interaction.options.getRole("role", true);
          const cooldown = interaction.options.getInteger("cooldown", true);
          const combatlock = interaction.options.getString("combatlock", true);
          const location = interaction.options.getString("location", true);

          if (location === "manual") {
            const modal = new ModalBuilder()
              .setCustomId(`configure_outpost_manual:${guildId}:${serverId}:${role.id}:${cooldown}:${combatlock}:${interaction.user.id}`)
              .setTitle("Manual Outpost Coords");

            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("x").setLabel("X").setStyle(TextInputStyle.Short).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("y").setLabel("Y").setStyle(TextInputStyle.Short).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("z").setLabel("Z").setStyle(TextInputStyle.Short).setRequired(true)
              )
            );

            return interaction.showModal(modal).catch(() => {});
          }

          await interaction.deferReply().catch(() => {});
          const ign = extractLinkedPlayerName(guildId, interaction.user.id);
          if (!ign) {
            return interaction.editReply({ content: "No linked in-game account found." }).catch(() => {});
          }

          let posRaw;
          try {
            posRaw = await rce.sendCommand(serverId, `printpos "${ign}"`);
          } catch {
            return interaction.editReply({ content: "Failed to get your position." }).catch(() => {});
          }

          const coords = parseXYZ(posRaw);
          if (!coords) {
            return interaction.editReply({ content: "Could not read your position." }).catch(() => {});
          }

          const cfg = getCfg();
          const slot = ensure(cfg, guildId, serverId);
          slot.roleId = role.id;
          slot.cooldownMinutes = Number(cooldown) || 0;
          slot.combatlock = combatlock === "yes";
          slot.coords = coords;
          slot.updatedAt = Date.now();
          saveCfg(cfg);

          return interaction.editReply({
            embeds: [
              whiteGreenEmbed(
                "Outpost Config Saved",
                `Saved outpost for **${safeName(getServerDisplay(serverId))}**.\nRole: <@&${role.id}>\nCooldown: **${slot.cooldownMinutes}** minute(s)\nCombat Lock: **${slot.combatlock ? "Yes" : "No"}**\nCoords: **(${coords.x}, ${coords.y}, ${coords.z})**`
              ),
            ],
          }).catch(() => {});
        }

        if (interaction.commandName === "outpost") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server." }).catch(() => {});
          }

          const guildId = interaction.guildId;
          const serverId = interaction.options.getString("server", true);
          const cfg = getOutpostCfg(guildId, serverId);
          if (!cfg) return;

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const ign = extractLinkedPlayerName(guildId, interaction.user.id) || interaction.user.username;

          if (!member?.roles?.cache?.has(cfg.roleId)) {
            return interaction.reply({
              embeds: [whiteGreenEmbed("Denied Entry", `Sorry! **${safeName(ign, 64)}** doesnt have access to teleport to outpost!`)],
            }).catch(() => {});
          }

          if (cfg.combatlock && isCombatLocked(serverId, ign)) {
            return interaction.reply({
              embeds: [whiteGreenEmbed("Your in combat", `Cool down first! **${safeName(ign, 64)}** you were recently in combat.`)],
            }).catch(() => {});
          }

          const cds = getCooldowns();
          const nextAt = Number(cds?.[guildId]?.[serverId]?.[interaction.user.id]?.nextAt || 0);
          if (nextAt > Date.now()) {
            return interaction.reply({
              embeds: [whiteGreenEmbed("Your On Cooldown", `Hey **${safeName(ign, 64)}**, You cant come back so soon! come back <t:${Math.floor(nextAt / 1000)}:R>` )],
            }).catch(() => {});
          }

          await interaction.deferReply().catch(() => {});

          const { x, y, z } = cfg.coords || {};
          const cmd = `global.teleportpos (${x},${y},${z}) "${ign}"`;

          try {
            await rce.sendCommand(serverId, cmd);
          } catch {
            return interaction.editReply({ content: "Failed to teleport player." }).catch(() => {});
          }

          const cdMinutes = Number(cfg.cooldownMinutes || 0);
          if (cdMinutes > 0) {
            const slot = ensure(cds, guildId, serverId, interaction.user.id);
            slot.nextAt = Date.now() + cdMinutes * 60_000;
            slot.lastAt = Date.now();
            saveCooldowns(cds);
          }

          return interaction.editReply({
            embeds: [whiteGreenEmbed("Welcome to outpost", `Welcome to outpost **${safeName(ign, 64)}**! You have succesfully been teleported.`)],
          }).catch(() => {});
        }
      } catch (e) {
        console.error("[outpost] error:", e);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "Error. Check console." });
          } else {
            await interaction.reply({ content: "Error. Check console." });
          }
        } catch {}
      }
    });
  },
};
