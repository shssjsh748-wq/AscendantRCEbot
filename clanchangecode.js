const fs = require("fs");
const path = require("path");

const {
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

const { listServers } = require("../rce");

const CLANS_PATH = path.join(__dirname, "..", "data", "clans.json");

const ROLE_COLORS = {
  RED: 0xed4245,
  ORANGE: 0xfaa61a,
  YELLOW: 0xfee75c,
  GREEN: 0x57f287,
  BLUE: 0x5865f2,
  PURPLE: 0x9b59b6,
  PINK: 0xeb459e,
  WHITE: 0xffffff,
  BLACK: 0x000001,
};

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

function readClans() {
  return readJsonSafe(CLANS_PATH, {});
}
function writeClans(data) {
  writeJsonSafe(CLANS_PATH, data);
}

function getServerClanMap(all, guildId, serverId) {
  return all?.[guildId]?.[serverId] || null;
}

function findLeaderClan(serverMap, leaderId) {
  if (!serverMap) return null;
  for (const [roleId, clan] of Object.entries(serverMap)) {
    if (String(clan?.leaderId) === String(leaderId)) return { roleId, clan };
  }
  return null;
}

function makeModal(customId) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle("New Clan Code");

  const codeIn = new TextInputBuilder()
    .setCustomId("code")
    .setLabel("Enter your new clan code")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(codeIn));
  return modal;
}

function makePublicEmbed({ colorKey, userId, clanRoleId }) {
  const color = ROLE_COLORS[colorKey] ?? 0xffffff;

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `**New Clan Code!**`,
        `> :key: <@${userId}> has changed <@&${clanRoleId}>'s clan code!`,
        ``,
        `• Members will need the **new code** to join.`,
        `• If you shared the old code, delete it.`,
        `• Keep your code private to avoid random joins.`,
      ].join("\n")
    );
}

module.exports = {
  name: "clanchangecode",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // autocomplete server for /clan change-code
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "change-code") return;

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

        // /clan change-code -> modal
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "change-code") return;

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists) {
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
          }

          const all = readClans();
          const serverMap = getServerClanMap(all, interaction.guildId, serverId);

          if (!serverMap || Object.keys(serverMap).length === 0) {
            return interaction.reply({ content: "No clans exist on this server yet.", flags: MessageFlags.Ephemeral });
          }

          const found = findLeaderClan(serverMap, interaction.user.id);
          if (!found) {
            return interaction.reply({ content: "Leader only. You don't own a clan on this server.", flags: MessageFlags.Ephemeral });
          }

          const customId = `clan_change_code:${serverId}`;
          return interaction.showModal(makeModal(customId));
        }

        // modal submit
        if (interaction.isModalSubmit()) {
          if (!interaction.customId.startsWith("clan_change_code:")) return;

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.customId.split(":")[1];
          const newCode = interaction.fields.getTextInputValue("code").trim();

          if (!newCode) {
            return interaction.reply({ content: "Code can't be empty.", flags: MessageFlags.Ephemeral });
          }

          const all = readClans();
          const serverMap = getServerClanMap(all, interaction.guildId, serverId);

          if (!serverMap || Object.keys(serverMap).length === 0) {
            return interaction.reply({ content: "No clans exist on this server yet.", flags: MessageFlags.Ephemeral });
          }

          const found = findLeaderClan(serverMap, interaction.user.id);
          if (!found) {
            return interaction.reply({ content: "Leader only.", flags: MessageFlags.Ephemeral });
          }

          const { roleId, clan } = found;

          // update code
          clan.code = newCode;
          clan.codeUpdatedAt = Date.now();
          clan.codeUpdatedBy = interaction.user.id;

          serverMap[roleId] = clan;
          all[interaction.guildId] = all[interaction.guildId] || {};
          all[interaction.guildId][serverId] = serverMap;
          writeClans(all);

          // public embed in the channel the modal was used from
          await interaction.reply({
            content: "Updated.",
            flags: MessageFlags.Ephemeral,
          });

          const publicEmbed = makePublicEmbed({
            colorKey: clan.colorKey,
            userId: interaction.user.id,
            clanRoleId: roleId,
          });

          // announce in clan channel if it exists, else in current channel
          const clanChannel = clan.channelId ? await interaction.guild.channels.fetch(clan.channelId).catch(() => null) : null;
          if (clanChannel) {
            await clanChannel.send({ embeds: [publicEmbed] }).catch(() => {});
          } else {
            await interaction.channel.send({ embeds: [publicEmbed] }).catch(() => {});
          }

          console.log("[clan change-code]", {
            guildId: interaction.guildId,
            serverId,
            clanRoleId: roleId,
            by: interaction.user.id,
          });
        }
      } catch (e) {
        console.error("[clanchangecode] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};