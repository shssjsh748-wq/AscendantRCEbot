// events/eventhome.js
const fs = require("fs");
const path = require("path");
const { ContainerBuilder, MessageFlags, ButtonBuilder, ButtonStyle } = require("discord.js");
const { listServers } = require("../rce");
const { readLinks } = require("../shared/links");
const CLANS_PATH = path.join(__dirname, "..", "data", "clans.json");
const HOMES_PATH = path.join(__dirname, "..", "data", "eventhomes.json");

const activePanels = new Map(); // messageId -> { ownerId,guildId,serverId,clanRoleId,playerName }

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
function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}
function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}
function parsePrintPos(resp) {
  const t = String(resp ?? "");
  const m = t.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function getLinkedGamertag(userId, guildId) {
  const data = readLinks();

  const a = data?.[guildId]?.[userId] || data?.[userId];
  if (!a) return null;

  if (typeof a === "string") return a;
  if (typeof a?.gamertag === "string") return a.gamertag;
  if (typeof a?.gt === "string") return a.gt;
  if (typeof a?.xbox === "string") return a.xbox;
  if (typeof a?.playerName === "string") return a.playerName;
  if (typeof a?.player === "string") return a.player;
  if (typeof a?.name === "string") return a.name;

  return null;
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

function readHome(guildId, serverId, clanRoleId) {
  const all = readJsonSafe(HOMES_PATH, {});
  const h = all?.[guildId]?.[serverId]?.[clanRoleId]?.home;
  if (!h) return null;
  return { x: h.x, y: h.y, z: h.z };
}
function writeHome(guildId, serverId, clanRoleId, home, userId) {
  const all = readJsonSafe(HOMES_PATH, {});
  ensure(all, guildId, serverId, clanRoleId);
  all[guildId][serverId][clanRoleId] = {
    home,
    setAt: Date.now(),
    setBy: userId,
  };
  writeJsonSafe(HOMES_PATH, all);
}

function buildPanel(state) {
  const c = new ContainerBuilder().setAccentColor(0x95a5a6);

  const home = readHome(state.guildId, state.serverId, state.clanRoleId);
  const homeText = home ? `**${home.x}, ${home.y}, ${home.z}**` : "**Not set**";

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        "***EVENT HOME***",
        "Click this button to set your event home",
        "This is required to join events! Make sure your in your base.",
        `Current home: ${homeText}`,
      ].join("\n")
    )
  );

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder().setCustomId("eventhome_set").setLabel("Set Home").setStyle(ButtonStyle.Success)
    )
  );

  return c;
}

module.exports = {
  name: "eventhome",

  init(client, rce) {
    readJsonSafe(HOMES_PATH, {});
    readJsonSafe(CLANS_PATH, {});

    client.on("interactionCreate", async (interaction) => {
      // AUTOCOMPLETE
      if (interaction.isAutocomplete()) {
        if (interaction.commandName !== "event-sethome") return;

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

        return interaction.respond(choices).catch(() => {});
      }

      // COMMAND
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "event-sethome") return;
        if (!interaction.inGuild()) return interaction.reply({ content: "Use this in a server.", ephemeral: true }).catch(() => {});

        const serverId = interaction.options.getString("server", true);
        const serverExists = listServers().some((s) => s.identifier === serverId);
        if (!serverExists) return interaction.reply({ content: "Server not found.", ephemeral: true }).catch(() => {});

        const playerName = getLinkedGamertag(interaction.user.id, interaction.guildId);
        if (!playerName) return interaction.reply({ content: "You must be linked.", ephemeral: true }).catch(() => {});

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: "Could not fetch member.", ephemeral: true }).catch(() => {});

        const clan = getClanForMember(interaction.guildId, serverId, member);
        if (!clan) return interaction.reply({ content: "You must be in a clan.", ephemeral: true }).catch(() => {});

        await interaction.deferReply().catch(() => {});

        const state = {
          ownerId: interaction.user.id,
          guildId: interaction.guildId,
          serverId,
          clanRoleId: clan.roleId,
          playerName,
        };

        const payload = {
          flags: MessageFlags.IsComponentsV2,
          components: [buildPanel(state)],
        };

        await interaction.editReply(payload).catch(() => {});
        const msg = await interaction.fetchReply().catch(() => null);
        if (msg?.id) activePanels.set(msg.id, state);
        return;
      }

      // BUTTON
      if (!interaction.isButton()) return;
      if (interaction.customId !== "eventhome_set") return;

      const state = activePanels.get(interaction.message?.id);
      if (!state) return;

      if (interaction.user.id !== state.ownerId) {
        return interaction.reply({ content: "Only the panel owner can use this.", ephemeral: true }).catch(() => {});
      }

      await interaction.reply({ content: "Setting home...", ephemeral: true }).catch(() => {});

      const resp = await rce
        .sendCommand(state.serverId, `printpos "${escapeQuotes(state.playerName)}"`)
        .catch(() => null);

      const pos = parsePrintPos(resp);
      if (!pos) return interaction.editReply({ content: "Could not read your position. Be in-game." }).catch(() => {});

      writeHome(state.guildId, state.serverId, state.clanRoleId, pos, state.ownerId);

      await interaction.message
        .edit({
          flags: MessageFlags.IsComponentsV2,
          components: [buildPanel(state)],
        })
        .catch(() => {});

      return interaction.editReply({ content: "✅ Home set." }).catch(() => {});
    });
  },
};