const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

const { listServers } = require("./rce");

const LEADERBOARD_PATH = path.join(__dirname, "eventleaderboards.json");
const ROLES_PATH = path.join(__dirname, "roles.json");
const HUBS_PATH = path.join(__dirname, "eventleaderboard_hubs.json");

const EVENT_NAMES = ["KOTH", "NUKETOWN", "MAZE", "CAPTURE ZONE"];

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readLeaderboardsAll() {
  return readJsonSafe(LEADERBOARD_PATH, {});
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, { adminRoleId: null, ownerRoleId: null });
}

function readHubs() {
  return readJsonSafe(HUBS_PATH, {});
}
function writeHubs(data) {
  fs.writeFileSync(HUBS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function saveHubMessage(guildId, channelId, messageId) {
  const all = readHubs();
  all[guildId] = { channelId, messageId, updatedAt: Date.now() };
  writeHubs(all);
}

async function refreshLeaderboardHub(client, guildId) {
  const hubs = readHubs();
  const hub = hubs?.[guildId];
  if (!hub?.channelId || !hub?.messageId) return false;

  const channel = await client.channels.fetch(hub.channelId).catch(() => null);
  if (!channel) return false;

  const msg = await channel.messages.fetch(hub.messageId).catch(() => null);
  if (!msg) return false;

  await msg.edit({
    embeds: [buildHubEmbed(guildId)],
    components: buildServerButtons(),
  }).catch(() => null);

  return true;
}

function isAdminOrOwner(member) {
  const cfg = readRoles();
  const adminRoleId = cfg?.adminRoleId;
  const ownerRoleId = cfg?.ownerRoleId;

  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (adminRoleId && member?.roles?.cache?.has(adminRoleId)) return true;
  if (ownerRoleId && member?.roles?.cache?.has(ownerRoleId)) return true;
  return false;
}

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply({ content });
    return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {}
}

function getServerDisplay(serverId) {
  const found = listServers().find((s) => s.identifier === serverId);
  return (found?.displayName || found?.identifier || serverId).trim();
}

function getGuildGlobalSummary(guildId) {
  const all = readLeaderboardsAll();
  const byGuild = all?.[guildId] || {};

  let totalPoints = 0;
  let totalEventKills = 0;
  const clanTotals = {};

  for (const serverId of Object.keys(byGuild)) {
    const serverEntry = byGuild[serverId] || {};
    const totals = serverEntry.totals || {};
    const byClan = totals.byClan || {};

    totalEventKills += Number(totals.totalEventKills || 0);

    for (const [roleId, stats] of Object.entries(byClan)) {
      const pts = Number(stats?.points || 0);
      totalPoints += pts;
      clanTotals[roleId] = Number(clanTotals[roleId] || 0) + pts;
    }
  }

  let topClanRoleId = null;
  let topClanPoints = 0;

  for (const [roleId, pts] of Object.entries(clanTotals)) {
    if (pts > topClanPoints) {
      topClanPoints = pts;
      topClanRoleId = roleId;
    }
  }

  return { totalPoints, totalEventKills, topClanRoleId, topClanPoints };
}

function buildHubEmbed(guildId) {
  const { totalPoints, totalEventKills, topClanRoleId, topClanPoints } = getGuildGlobalSummary(guildId);

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Event Leaderboard Hub")
    .setDescription(
      [
        "Select a server below to view its event leaderboards.",
        "",
        "Click the corresponding button to see KOTH, Scrims, Nuketown, Snowroam, Launch, and Maze standings.",
      ].join("\n")
    )
    .addFields(
      { name: "Total Points", value: String(totalPoints), inline: true },
      { name: "Top Clan", value: topClanRoleId ? `<@&${topClanRoleId}> (${topClanPoints})` : "No data yet", inline: true },
      { name: "Total Event Kills", value: String(totalEventKills), inline: true }
    );
}

function buildServerButtons() {
  const servers = listServers().slice(0, 25);
  const rows = [];

  for (let i = 0; i < servers.length; i += 5) {
    const chunk = servers.slice(i, i + 5);

    rows.push(
      new ActionRowBuilder().addComponents(
        ...chunk.map((s) =>
          new ButtonBuilder()
            .setCustomId(`eventlb_view|${s.identifier}`)
            .setLabel(`${(s.displayName || s.identifier).slice(0, 70)} Events`)
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }

  return rows;
}

function buildPlacementLine(index, roleId, points) {
  if (index === 0) return `🥇 <@&${roleId}> - **${points} pts**`;
  if (index === 1) return `🥈 <@&${roleId}> - **${points} pts**`;
  if (index === 2) return `🥉 <@&${roleId}> - **${points} pts**`;
  return `${index + 1}. <@&${roleId}> - **${points} pts**`;
}

function buildEventEmbed(serverDisplay, serverEntry, eventName) {
  const byClan = serverEntry?.events?.[eventName]?.byClan || {};

  const rows = Object.entries(byClan)
    .map(([roleId, stats]) => ({
      roleId,
      points: Number(stats?.points || 0),
      kills: Number(stats?.kills || 0),
    }))
    .filter((x) => x.points > 0)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.kills - a.kills;
    });

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(eventName)
    .setFooter({ text: serverDisplay });

  if (!rows.length) {
    embed.setDescription("No data yet.");
    return embed;
  }

  const top = rows.slice(0, 15);
  const lines = top.map((row, idx) => buildPlacementLine(idx, row.roleId, row.points));

  if (rows.length > top.length) {
    lines.push("", `*...and ${rows.length - top.length} more*`);
  }

  embed.setDescription(lines.join("\n"));
  return embed;
}

module.exports = {
  name: "eventleaderboard",
  refreshLeaderboardHub,

  init(client) {
    readJsonSafe(LEADERBOARD_PATH, {});
    readJsonSafe(ROLES_PATH, { adminRoleId: null, ownerRoleId: null });
    readJsonSafe(HUBS_PATH, {});

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "setup-leaderboard") return;
          if (!interaction.inGuild()) return replyEphemeral(interaction, "Use this in a server.");
          if (!isAdminOrOwner(interaction.member)) return replyEphemeral(interaction, "No permission.");

          const channel = interaction.options.getChannel("channel", true);
          const okChan =
            channel &&
            (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);

          if (!okChan) return replyEphemeral(interaction, "Pick a text or announcement channel.");

          const msg = await channel.send({
  embeds: [buildHubEmbed(interaction.guildId)],
  components: buildServerButtons(),
});

saveHubMessage(interaction.guildId, channel.id, msg.id);

return replyEphemeral(interaction, "✅ Leaderboard hub deployed.");
        }

        if (interaction.isButton()) {
          if (!interaction.customId.startsWith("eventlb_view|")) return;

          const serverId = interaction.customId.split("|")[1];
          const all = readLeaderboardsAll();
          const serverEntry = all?.[interaction.guildId]?.[serverId] || {};
          const serverDisplay = getServerDisplay(serverId);

          const embeds = EVENT_NAMES.map((name) => buildEventEmbed(serverDisplay, serverEntry, name));

          return interaction.reply({
            embeds,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        console.error("[eventleaderboard] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};