// modules/clanleave.js
const fs = require("fs");
const path = require("path");

const { EmbedBuilder, MessageFlags } = require("discord.js");
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

function findUsersClan(serverMap, userId) {
  for (const [roleId, clan] of Object.entries(serverMap || {})) {
    if (Array.isArray(clan?.members) && clan.members.includes(userId)) {
      return { roleId, clan };
    }
  }
  return null;
}

function makeLeaveEmbed({ color, userId, clanRoleId, clanName }) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `**<@${userId}> left the clan**`,
        `> Left <@&${clanRoleId}>`,
        `- **Clan:** ${clanName}`,
      ].join("\n")
    );
}

module.exports = {
  name: "clanleave",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // autocomplete for /clan leave server
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "leave") return;

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

        // /clan leave
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "leave") return;

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

          const found = findUsersClan(serverMap, interaction.user.id);
          if (!found) {
            return interaction.reply({ content: "You are not in a clan on this server.", flags: MessageFlags.Ephemeral });
          }

          const { roleId: clanRoleId, clan } = found;

          // leader can't leave their own clan (until disband/transfer exists)
          if (clan?.leaderId === interaction.user.id) {
            return interaction.reply({
              content: "You are the clan leader. Use `/clan disband` or `/clan transfer`.",
              flags: MessageFlags.Ephemeral,
            });
          }

          // remove role
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await member.roles.remove(clanRoleId).catch(() => {});

          // update clans.json
          clan.members = Array.isArray(clan.members) ? clan.members : [];
          clan.members = clan.members.filter((id) => id !== interaction.user.id);

          serverMap[clanRoleId] = clan;
          all[interaction.guildId] = all[interaction.guildId] || {};
          all[interaction.guildId][serverId] = serverMap;
          writeClans(all);

          await interaction.reply({
            content: `Left **${clan.name}**.`,
            flags: MessageFlags.Ephemeral,
          });

          // announce in clan channel
          const chanId = clan.channelId;
          const clanChannel = chanId ? await interaction.guild.channels.fetch(chanId).catch(() => null) : null;
          if (clanChannel) {
            const color = ROLE_COLORS[clan.colorKey] ?? 0xffffff;
            await clanChannel.send({
              embeds: [
                makeLeaveEmbed({
                  color,
                  userId: interaction.user.id,
                  clanRoleId,
                  clanName: clan.name || "Unknown",
                }),
              ],
            });
          }

          console.log("[clan leave]", { guildId: interaction.guildId, serverId, userId: interaction.user.id, clanRoleId });
        }
      } catch (e) {
        console.error("[clanleave] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};