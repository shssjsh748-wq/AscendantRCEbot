// modules/clanjoin.js
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

const { listServers } = require("./rce");

const CLANS_PATH = path.join(__dirname, "clans.json");
const MILESTONES_PATH = path.join(__dirname, "clan_milestones.json");

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

const pendingJoin = new Map(); // userId -> { guildId, serverId, createdAt }

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

function readMilestones() {
  return readJsonSafe(MILESTONES_PATH, {});
}

function getServerClanMap(all, guildId, serverId) {
  return all?.[guildId]?.[serverId] || null;
}

function memberAlreadyInClan(serverMap, userId) {
  if (!serverMap) return false;
  const clans = Object.values(serverMap);
  if (clans.length === 0) return false;
  return clans.some((c) => Array.isArray(c?.members) && c.members.includes(userId));
}

function findClanByCode(serverMap, codeInput) {
  const code = String(codeInput || "").trim().toLowerCase();
  if (!code) return null;

  for (const [roleId, clan] of Object.entries(serverMap || {})) {
    const stored = String(clan?.code || "").trim().toLowerCase();
    if (stored && stored === code) return { roleId, clan };
  }
  return null;
}

function sortedMilestonesFor(mAll, guildId, serverId) {
  const list = mAll?.[guildId]?.[serverId]?.milestones;
  if (!Array.isArray(list)) return [];
  return [...list]
    .filter((m) => Number.isFinite(m?.members) && typeof m?.roleId === "string")
    .sort((a, b) => a.members - b.members);
}

function nextMilestoneInfo(milestones, count) {
  const next = milestones.find((m) => m.members > count) || null;
  if (!next) return { next: null, away: 0 };
  return { next, away: next.members - count };
}

function makeJoinModal() {
  const modal = new ModalBuilder().setCustomId("clan_join_modal").setTitle("Join a Clan");

  const code = new TextInputBuilder()
    .setCustomId("code")
    .setLabel("Enter Clan Join Code")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(code));
  return modal;
}

function makeWelcomeEmbed({ color, newUserId, clanRoleId, awayText }) {
  const lines = [`**Welcome <@${newUserId}> to the clan!**`, `> Joined <@&${clanRoleId}>`];
  if (awayText) lines.push(awayText);

  return new EmbedBuilder().setColor(0x95a5a6).setDescription(lines.join("\n"));
}

async function getAccurateClanMemberCount(guild, clanRoleId, newUserId) {
  // role.members is cache-based and can lag on the exact update tick.
  // So we "force include" the joining member if cache hasn’t updated yet.
  const role = await guild.roles.fetch(clanRoleId).catch(() => null);
  let count = role?.members?.size ?? 0;

  if (role && newUserId && !role.members.has(newUserId)) count += 1;
  return count;
}

async function sendClanJoinWelcome({
  client,
  guild,
  guildId,
  serverId,
  clanRoleId,
  userId,
}) {
  const all = readClans();
  const serverMap = getServerClanMap(all, guildId, serverId);
  const clan = serverMap?.[clanRoleId];
  if (!clan) return false;

  const mAll = readMilestones();
  const milestones = sortedMilestonesFor(mAll, guildId, serverId);

  let awayText = null;
  if (milestones.length > 0) {
    const memberCount = await getAccurateClanMemberCount(guild, clanRoleId, userId);
    const { next, away } = nextMilestoneInfo(milestones, memberCount);

    if (next) {
      awayText = `> You are **${away}** members away from your next milestone: <@&${next.roleId}>`;
    } else {
      awayText = `> Your clan has reached the highest milestone.`;
    }
  }

  const clanChannel = clan.channelId
    ? await guild.channels.fetch(clan.channelId).catch(() => null)
    : null;

  if (!clanChannel) return false;

  const color = ROLE_COLORS[clan.colorKey] ?? 0xffffff;

  await clanChannel.send({
    embeds: [makeWelcomeEmbed({ color, newUserId: userId, clanRoleId, awayText })],
  }).catch(() => null);

  client.emit("clan:refreshMilestones", {
    guild,
    guildId,
    serverId,
    clanRoleId,
  });

  return true;
}
module.exports = {
  name: "clanjoin",
  sendClanJoinWelcome,

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // autocomplete for /clan join server
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "join") return;

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

        // /clan join -> open modal
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "clan") return;
          if (interaction.options.getSubcommand() !== "join") return;

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

          if (memberAlreadyInClan(serverMap, interaction.user.id)) {
            return interaction.reply({
              content: "You are already in a clan on this server.",
              flags: MessageFlags.Ephemeral,
            });
          }

          pendingJoin.set(interaction.user.id, { guildId: interaction.guildId, serverId, createdAt: Date.now() });
          return interaction.showModal(makeJoinModal());
        }

        // modal submit -> perform join
        if (interaction.isModalSubmit() && interaction.customId === "clan_join_modal") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          const pending = pendingJoin.get(interaction.user.id);
          if (!pending || pending.guildId !== interaction.guildId) {
            return interaction.reply({ content: "Join request expired.", flags: MessageFlags.Ephemeral });
          }

          // expire after 2 mins
          if (Date.now() - pending.createdAt > 120_000) {
            pendingJoin.delete(interaction.user.id);
            return interaction.reply({ content: "Join request expired.", flags: MessageFlags.Ephemeral });
          }

          const serverId = pending.serverId;
          const code = interaction.fields.getTextInputValue("code").trim();

          const all = readClans();
          const serverMap = getServerClanMap(all, interaction.guildId, serverId);

          if (!serverMap || Object.keys(serverMap).length === 0) {
            pendingJoin.delete(interaction.user.id);
            return interaction.reply({ content: "No clans exist on this server yet.", flags: MessageFlags.Ephemeral });
          }

          if (memberAlreadyInClan(serverMap, interaction.user.id)) {
            pendingJoin.delete(interaction.user.id);
            return interaction.reply({ content: "You are already in a clan on this server.", flags: MessageFlags.Ephemeral });
          }

          const found = findClanByCode(serverMap, code);
          if (!found) {
            // keep pending so they can re-open / re-try quickly? nah, delete it.
            pendingJoin.delete(interaction.user.id);
            return interaction.reply({ content: "Wrong clan code.", flags: MessageFlags.Ephemeral });
          }

          const { roleId: clanRoleId, clan } = found;

          // add clan role
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await member.roles.add(clanRoleId).catch(() => {});

          // update clans.json members list (best-effort tracking; milestones use live role count)
          if (!Array.isArray(clan.members)) clan.members = [];
          if (!clan.members.includes(interaction.user.id)) clan.members.push(interaction.user.id);

          serverMap[clanRoleId] = clan;
          all[interaction.guildId] = all[interaction.guildId] || {};
          all[interaction.guildId][serverId] = serverMap;
          writeClans(all);

          // compute milestone text for welcome (ACCURATE count)
          const mAll = readMilestones();
          const milestones = sortedMilestonesFor(mAll, interaction.guildId, serverId);

          let awayText = null;
          if (milestones.length > 0) {
            const memberCount = await getAccurateClanMemberCount(interaction.guild, clanRoleId, interaction.user.id);
            const { next, away } = nextMilestoneInfo(milestones, memberCount);

            if (next) {
              awayText = `> You are **${away}** members away from your next milestone: <@&${next.roleId}>`;
            } else {
              // no next milestone means we’re at/above the last milestone
              awayText = `> Your clan has reached the highest milestone.`;
            }
          }

          // reply to user
          await interaction.reply({
            content: `Joined **${clan.name}**.`,
            flags: MessageFlags.Ephemeral,
          });

          // send welcome in clan channel
          const clanChannel = clan.channelId
            ? await interaction.guild.channels.fetch(clan.channelId).catch(() => null)
            : null;

          if (clanChannel) {
            const color = ROLE_COLORS[clan.colorKey] ?? 0xffffff;
            await clanChannel.send({
              embeds: [makeWelcomeEmbed({ color, newUserId: interaction.user.id, clanRoleId, awayText })],
            });
          }

          // tell milestones module to re-apply right now (if you wired this event)
          client.emit("clan:refreshMilestones", {
            guild: interaction.guild,
            guildId: interaction.guildId,
            serverId,
            clanRoleId,
          });

          pendingJoin.delete(interaction.user.id);
        }
      } catch (e) {
        console.error("[clanjoin] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};