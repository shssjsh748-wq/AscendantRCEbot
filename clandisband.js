// modules/clandisband.js
const fs = require("fs");
const path = require("path");

const {
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require("discord.js");

const { listServers } = require("./rce");

const CLANS_PATH = path.join(__dirname, "clans.json");

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
    if (String(clan?.leaderId) === String(leaderId)) return { clanRoleId: roleId, clan };
  }
  return null;
}

function resolveDisplayName(serverId) {
  const s = listServers().find((x) => x.identifier === serverId);
  return (s?.displayName || s?.identifier || serverId).trim();
}

function makeEmbed(colorKey, lines) {
  const color = ROLE_COLORS[colorKey] ?? 0xffffff;
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(lines.join("\n"));
}

function confirmRow(customIdBase) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdBase}:yes`)
      .setLabel("Confirm Disband")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${customIdBase}:no`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

module.exports = {
  name: "clandisband",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // autocomplete for /clan disband server
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "disband") return;

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

        // /clan disband -> confirm buttons
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "disband") return;

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
            return interaction.reply({ content: "Leader only.", flags: MessageFlags.Ephemeral });
          }

          const { clanRoleId, clan } = found;

const token = `${interaction.guildId}|${serverId}|${clanRoleId}|${interaction.user.id}`;

const embed = new EmbedBuilder()
  .setColor(0x95a5a6)
  .setDescription(
    [
      `### :warning: Confirm clan disband`,
      `This will permanently delete your clan.`,
      `This action cannot be undone.`,
    ].join("\n")
  )
  .addFields(
    { name: "Clan", value: `<@&${clanRoleId}>`, inline: true },
    { name: "Server", value: `${resolveDisplayName(serverId)}`, inline: true },
    { name: "Leader", value: `<@${interaction.user.id}>`, inline: true }
  )
  .setFooter({ text: "Press Confirm Disband to continue." });

          return interaction.reply({
            embeds: [embed],
            components: [confirmRow(`clandisband|${token}`)],
            flags: MessageFlags.Ephemeral,
          });
        }

        // Buttons
        if (interaction.isButton()) {
          if (!interaction.customId.startsWith("clandisband|")) return;

          const parts = interaction.customId.split(":");
          const base = parts[0]; // clandisband|token
          const choice = parts[1]; // yes/no

          const token = base.slice("clandisband|".length);
          const [guildId, serverId, clanRoleId, leaderId] = token.split("|");

          if (!interaction.inGuild() || interaction.guildId !== guildId) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          if (interaction.user.id !== leaderId) {
            return interaction.reply({ content: "That confirm isn't yours.", flags: MessageFlags.Ephemeral });
          }

          if (choice === "no") {
            return interaction.update({
              content: "Cancelled.",
              embeds: [],
              components: [],
            });
          }

          // yes -> delete clan
          const all = readClans();
          const serverMap = getServerClanMap(all, interaction.guildId, serverId);

          const clan = serverMap?.[clanRoleId];
          if (!clan) {
            return interaction.update({
              content: "Clan already removed.",
              embeds: [],
              components: [],
            });
          }

          if (String(clan.leaderId) !== interaction.user.id) {
            return interaction.update({
              content: "Leader only.",
              embeds: [],
              components: [],
            });
          }

          const colorKey = clan.colorKey;
          const clanName = clan.name;
          const channelId = clan.channelId;

          // try: announce in clan channel before deleting it
          const clanChannel = channelId
            ? await interaction.guild.channels.fetch(channelId).catch(() => null)
            : null;

          if (clanChannel && clanChannel.type === ChannelType.GuildText) {
            const bye = makeEmbed(colorKey, [
              `**Clan Disbanded**`,
              `> :white_check_mark: This clan has been disbanded by <@${interaction.user.id}>`,
              `- **Clan:** <@&${clanRoleId}>`,
            ]);
            await clanChannel.send({ embeds: [bye] }).catch(() => {});
          }

          // delete channel
          if (clanChannel) {
            await clanChannel.delete(`Clan disbanded: ${clanName}`).catch(() => {});
          }

          // delete role
          const role = await interaction.guild.roles.fetch(clanRoleId).catch(() => null);
          if (role) {
            await role.delete(`Clan disbanded: ${clanName}`).catch(() => {});
          }

          // remove from clans.json
          delete serverMap[clanRoleId];
          all[interaction.guildId] = all[interaction.guildId] || {};
          all[interaction.guildId][serverId] = serverMap;
          writeClans(all);

          return interaction.update({
            embeds: [done],
            components: [],
          });
        }
      } catch (e) {
        console.error("[clandisband] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};