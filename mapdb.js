const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const { listServers, getServer } = require("../rce");
const { readRoles } = require("../modules/roles");

const MAPS_PATH = path.join(__dirname, "..", "data", "maps.json");
const ACCENT = 0x95a5a6;

function ensureMapsFile() {
  try {
    if (!fs.existsSync(MAPS_PATH)) {
      fs.writeFileSync(
        MAPS_PATH,
        JSON.stringify({ servers: {}, meta: { nextMapId: 1 } }, null, 2),
        "utf8"
      );
    }
  } catch {}
}

function readMaps() {
  try {
    ensureMapsFile();
    const raw = JSON.parse(fs.readFileSync(MAPS_PATH, "utf8"));
    if (!raw.servers) raw.servers = {};
    if (!raw.meta) raw.meta = { nextMapId: 1 };
    if (!raw.meta.nextMapId || raw.meta.nextMapId < 1) raw.meta.nextMapId = 1;
    return raw;
  } catch {
    return { servers: {}, meta: { nextMapId: 1 } };
  }
}

function writeMaps(data) {
  fs.writeFileSync(MAPS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function isOwner(interaction) {
  const roles = readRoles();
  if (!roles?.ownerRoleId) return false;
  return Boolean(interaction.member?.roles?.cache?.has(roles.ownerRoleId));
}

function getServerDisplay(serverId) {
  const s = typeof getServer === "function" ? getServer(serverId) : null;
  return s?.displayName || s?.identifier || serverId || "Unknown";
}

function ensureServerSlot(data, guildId, serverId) {
  if (!data.servers[guildId]) data.servers[guildId] = {};
  if (!data.servers[guildId][serverId]) {
    data.servers[guildId][serverId] = {
      maps: [],
      prioritised: [],
      lastWinningMapIds: [],
      activeVote: null,
    };
  }
  return data.servers[guildId][serverId];
}

function isValidHttpUrl(str) {
  try {
    const u = new URL(String(str || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function splitEmbeds(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  name: "mapdb",

  init(client) {
    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          const focused = interaction.options.getFocused(true);

          if (
            (interaction.commandName === "map" && focused.name === "server") ||
            (interaction.commandName === "maps" && focused.name === "server") ||
            (interaction.commandName === "mapvote" && focused.name === "server")
          ) {
            const q = String(focused.value || "").toLowerCase();
            const choices = listServers()
              .map((s) => ({
                name: String(s.displayName || s.identifier).slice(0, 100),
                value: s.identifier,
              }))
              .filter((x) => x.name.toLowerCase().includes(q))
              .slice(0, 25);

            return interaction.respond(choices).catch(() => {});
          }
        }

        if (!interaction.isChatInputCommand()) return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const isMapAdd = interaction.commandName === "map" && interaction.options.getSubcommand() === "add";
        const isMapsCmd = interaction.commandName === "maps";

        if (!isMapAdd && !isMapsCmd) return;

        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner role only.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const sub = isMapAdd ? "add" : interaction.options.getSubcommand();
        const serverId = interaction.options.getString("server", true);

        const serverExists = listServers().some((s) => s.identifier === serverId);
        if (!serverExists) {
          return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const data = readMaps();
        const slot = ensureServerSlot(data, interaction.guildId, serverId);

        if (sub === "add") {
          const mapUrl = interaction.options.getString("map", true).trim();

          if (!isValidHttpUrl(mapUrl)) {
            return interaction.reply({ content: "Invalid image URL.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          const id = data.meta.nextMapId++;
          slot.maps.push({
            id,
            imageUrl: mapUrl,
            createdAt: Date.now(),
          });

          writeMaps(data);

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(ACCENT)
                .setTitle(`Map ${id} Added`)
                .setDescription(`Server: **${getServerDisplay(serverId)}**`)
                .setImage(mapUrl),
            ],
          }).catch(() => {});
        }

        if (sub === "wipe") {
          const wiped = slot.maps.length;
          slot.maps = [];
          slot.prioritised = [];
          slot.lastWinningMapIds = [];
          slot.activeVote = null;
          writeMaps(data);

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(ACCENT)
                .setDescription(`✅ Wiped **${wiped}** maps for **${getServerDisplay(serverId)}**.`),
            ],
          }).catch(() => {});
        }

        if (sub === "prioritise") {
          const mapId = interaction.options.getInteger("map", true);
          const found = slot.maps.find((m) => Number(m.id) === Number(mapId));

          if (!found) {
            return interaction.reply({ content: "Map not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          if (!Array.isArray(slot.prioritised)) slot.prioritised = [];
          if (!slot.prioritised.includes(found.id)) slot.prioritised.push(found.id);

          writeMaps(data);

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(ACCENT)
                .setTitle(`Map ${found.id} Prioritised`)
                .setDescription(`It will be forced into the next map vote for **${getServerDisplay(serverId)}**.`)
                .setImage(found.imageUrl),
            ],
          }).catch(() => {});
        }

        if (sub === "view") {
          if (!slot.maps.length) {
            return interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setColor(ACCENT)
                  .setDescription(`No maps saved for **${getServerDisplay(serverId)}**.`),
              ],
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }

          const embeds = slot.maps.map((m) =>
            new EmbedBuilder()
              .setColor(ACCENT)
              .setTitle(`Map ${m.id}`)
              .setImage(m.imageUrl)
          );

          const chunks = splitEmbeds(embeds, 10);
          await interaction.reply({ embeds: chunks[0] }).catch(() => {});
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ embeds: chunks[i] }).catch(() => {});
          }
        }
      } catch (e) {
        console.error("[mapdb] error:", e);
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }).catch(() => {});
          } else {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        }
      }
    });
  },
};