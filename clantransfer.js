// modules/clantransfer.js
const fs = require("fs");
const path = require("path");
const { EmbedBuilder, MessageFlags } = require("discord.js");
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

function findMemberClan(serverMap, userId) {
  if (!serverMap) return null;
  for (const [roleId, clan] of Object.entries(serverMap)) {
    if (Array.isArray(clan?.members) && clan.members.includes(userId)) {
      return { clanRoleId: roleId, clan };
    }
  }
  return null;
}

function makeClanEmbed({ colorKey, lines }) {
  const color = ROLE_COLORS[colorKey] ?? 0xffffff;
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(lines.join("\n"));
}

module.exports = {
  name: "clantransfer",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // autocomplete for /clan transfer server
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "transfer") return;

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

        // /clan transfer
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "transfer") return;

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const targetUser = interaction.options.getUser("user", true);
          const confirm = interaction.options.getString("confirm", true);

          if (confirm !== "yes") {
            return interaction.reply({ content: "Cancelled.", flags: MessageFlags.Ephemeral });
          }

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists) {
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
          }

          if (targetUser.id === interaction.user.id) {
            return interaction.reply({ content: "You can't transfer to yourself.", flags: MessageFlags.Ephemeral });
          }

          const all = readClans();
          const serverMap = getServerClanMap(all, interaction.guildId, serverId);

          if (!serverMap || Object.keys(serverMap).length === 0) {
            return interaction.reply({ content: "No clans exist on this server yet.", flags: MessageFlags.Ephemeral });
          }

          const found = findMemberClan(serverMap, interaction.user.id);
          if (!found) {
            return interaction.reply({ content: "You are not in a clan on this server.", flags: MessageFlags.Ephemeral });
          }

          const { clanRoleId, clan } = found;

          if (String(clan.leaderId) !== interaction.user.id) {
            return interaction.reply({ content: "Leader only.", flags: MessageFlags.Ephemeral });
          }

          // target must be in the clan
          const isInClan = Array.isArray(clan.members) && clan.members.includes(targetUser.id);
          if (!isInClan) {
            return interaction.reply({ content: "That user must be in your clan first.", flags: MessageFlags.Ephemeral });
          }

          // ensure target is in guild
          const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
          if (!targetMember) {
            return interaction.reply({ content: "That user is not in this server.", flags: MessageFlags.Ephemeral });
          }

          // transfer
          clan.leaderId = targetUser.id;
          serverMap[clanRoleId] = clan;

          all[interaction.guildId] = all[interaction.guildId] || {};
          all[interaction.guildId][serverId] = serverMap;
          writeClans(all);

          // announce in clan channel
          const chanId = clan.channelId;
          const clanChannel = chanId ? await interaction.guild.channels.fetch(chanId).catch(() => null) : null;

          const embed = makeClanEmbed({
            colorKey: clan.colorKey,
            lines: [
              `**Clan Leadership Updated**`,
              `> :white_check_mark: Leadership has been transferred for <@&${clanRoleId}>`,
              `- **Old Leader:** <@${interaction.user.id}>`,
              `- **New Leader:** <@${targetUser.id}>`,
            ],
          });

          if (clanChannel) await clanChannel.send({ embeds: [embed] });

          // reply
          return interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        console.error("[clantransfer] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};