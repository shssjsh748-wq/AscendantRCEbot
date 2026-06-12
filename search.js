// modules/search.js
// /search player server:<server> user:<discord user>
// /search clan   server:<server> role:<clan role>

const fs = require("fs");
const path = require("path");
const { EmbedBuilder, MessageFlags } = require("discord.js");

const rceMod = require("./rce");
const { listServers } = rceMod;
const { readPlaytime } = require("./playtime");
const CLANS_PATH = path.join(__dirname, "clans.json");
const { readLinks } = require("./links");
const { readKills } = require("./kills");
// linking files (same idea as tp.js)
const LINKING_CANDIDATES = [
  path.join(__dirname, "linking.json"),
  path.join(__dirname, "linked.json"),
  path.join(__dirname, "link_config.json"),
];

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safe(s, max = 200) {
  return String(s ?? "").trim().slice(0, max);
}
function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function redErrEmbed(desc) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(safe(desc, 4000));
}

function fmtKD(k, d) {
  const kills = Number(k || 0);
  const deaths = Number(d || 0);
  if (deaths <= 0) return kills > 0 ? `${kills}.00` : "0.00";
  return (kills / deaths).toFixed(2);
}

function formatDuration(totalSeconds) {
  let s = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const mins = Math.floor(s / 60);
  s -= mins * 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (mins || hours || days) parts.push(`${mins}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ---------- linking resolver (discord -> in-game name) ----------
function findLinkedIgnFromObject(obj, guildId, discordId) {
  if (!obj) return null;

  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const pickFromObj = (o) => {
    if (!o || typeof o !== "object") return null;
    const ign =
      o.gamertag ||
      o.gamerTag ||
      o.Gamertag ||
      o.ign ||
      o.IGN ||
      o.name ||
      o.inGameName ||
      o.ingame ||
      o.player;
    return pick(ign);
  };

  // shape A: { guildId: { discordId: { ign/gamertag } } }
  const a = obj?.[guildId]?.[discordId];
  if (typeof a === "string") return pick(a);
  const aObj = pickFromObj(a);
  if (aObj) return aObj;

  // shape B: { discordId: { ign/gamertag } }
  const b = obj?.[discordId];
  if (typeof b === "string") return pick(b);
  const bObj = pickFromObj(b);
  if (bObj) return bObj;

  // shape C: { guildId: { links: { discordId: ign/gamertag } } }
  const c = obj?.[guildId]?.links?.[discordId];
  if (typeof c === "string") return pick(c);
  const cObj = pickFromObj(c);
  if (cObj) return cObj;

  // shape D: { links: { guildId: { discordId: ign/gamertag } } }
  const d = obj?.links?.[guildId]?.[discordId];
  if (typeof d === "string") return pick(d);
  const dObj = pickFromObj(d);
  if (dObj) return dObj;

  return null;
}

function resolveLinkedIgn(guildId, discordId) {
  try {
    const linking = require("./linking");
    if (typeof linking?.getLinkedIgn === "function") {
      const ign = linking.getLinkedIgn(guildId, discordId);
      if (ign) return String(ign).trim();
    }
    if (typeof linking?.getLinkedIGN === "function") {
      const ign = linking.getLinkedIGN(guildId, discordId);
      if (ign) return String(ign).trim();
    }
  } catch {}

  // ✅ ADD HERE
  const sharedLinks = readLinks();
  const sharedIgn = findLinkedIgnFromObject(sharedLinks, guildId, discordId);
  if (sharedIgn) return sharedIgn;

  for (const fp of LINKING_CANDIDATES) {
    if (!fs.existsSync(fp)) continue;
    const data = readJsonSafe(fp, null);
    const ign = findLinkedIgnFromObject(data, guildId, discordId);
    if (ign) return ign;
  }

  return null;
}

// ---------- stats helpers ----------
function getServerDisplay(serverId) {
  const s = listServers().find((x) => x.identifier === serverId);
  return (s?.displayName || s?.identifier || serverId || "Unknown").trim();
}

function getPlayerStats(serverId, ign) {
const killsAll = readKills();
const playAll = readPlaytime();

  const srv = killsAll?.[serverId] || {};
  const players = srv?.players || {};
  const key = norm(ign);

  const entry = players?.[key] || null;
  const kills = Number(entry?.kills || 0);
  const deaths = Number(entry?.deaths || 0);
  const highestKillstreak = Number(entry?.highestKillstreak || 0);

  // rank by kills desc
  const arr = Object.values(players).map((p) => ({
    name: String(p?.name || ""),
    kills: Number(p?.kills || 0),
    deaths: Number(p?.deaths || 0),
  }));
  arr.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || a.name.localeCompare(b.name));
  const rank = Math.max(1, arr.findIndex((p) => norm(p.name) === key) + 1 || arr.length + 1);

  const playSrv = playAll?.[serverId] || {};
  const pt = playSrv?.players?.[key];
  const seconds = Number(pt?.seconds || 0);

  return { kills, deaths, kd: fmtKD(kills, deaths), highestKillstreak, seconds, rank };
}

function getClanFromRole(guildId, serverId, roleId) {
  const clansAll = readJsonSafe(CLANS_PATH, {});
  return clansAll?.[guildId]?.[serverId]?.[roleId] || null;
}

function aggregateClanStats(guildId, serverId, clan) {
const killsAll = readKills();
  const playAll = readPlaytime();

  const srv = killsAll?.[serverId] || {};
  const players = srv?.players || {};
  const playSrv = playAll?.[serverId] || {};
  const playPlayers = playSrv?.players || {};

  let kills = 0;
  let deaths = 0;
  let highestKillstreak = 0;
  let seconds = 0;

  const members = Array.isArray(clan?.members) ? clan.members : [];

  for (const discordId of members) {
    const ign = resolveLinkedIgn(guildId, discordId);
    if (!ign) continue;

    const key = norm(ign);
    const p = players?.[key];
    kills += Number(p?.kills || 0);
    deaths += Number(p?.deaths || 0);
    highestKillstreak = Math.max(highestKillstreak, Number(p?.highestKillstreak || 0));

    const pt = playPlayers?.[key];
    seconds += Number(pt?.seconds || 0);
  }

  return { kills, deaths, kd: fmtKD(kills, deaths), highestKillstreak, seconds };
}

function getClanRank(guildId, serverId, currentRoleId) {
  const clansAll = readJsonSafe(CLANS_PATH, {});
  const serverObj = clansAll?.[guildId]?.[serverId] || {};
  const clans = Object.values(serverObj);

  const rows = clans
    .filter((c) => c?.roleId)
    .map((c) => {
      const stats = aggregateClanStats(guildId, serverId, c);
      return { roleId: String(c.roleId), kills: stats.kills, deaths: stats.deaths, name: String(c.name || "") };
    });

  rows.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || a.name.localeCompare(b.name));
  const idx = rows.findIndex((r) => r.roleId === String(currentRoleId));
  return idx === -1 ? rows.length + 1 : idx + 1;
}

module.exports = {
  name: "search",

  init(client) {


    // autocomplete server
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "search") return;

        const focused = interaction.options.getFocused(true);
        if (!focused || focused.name !== "server") return;

        const q = norm(focused.value);
        const servers = listServers();

        const choices = servers
          .map((s) => ({
            name: (s.displayName || s.identifier).slice(0, 100),
            value: s.identifier,
          }))
          .filter((c) => norm(c.name).includes(q))
          .slice(0, 25);

        await interaction.respond(choices).catch(() => {});
      } catch {}
    });

    // command
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "search") return;

        if (!interaction.inGuild()) {
          return interaction
            .reply({ embeds: [redErrEmbed("Use this in a server.")], flags: MessageFlags.Ephemeral })
            .catch(() => {});
        }

        const sub = interaction.options.getSubcommand(false);
        const serverId = interaction.options.getString("server", true);
        const serverDisplay = getServerDisplay(serverId);

        // ---------- /search player ----------
        if (sub === "player") {
          const user = interaction.options.getUser("user", true);
          const ign = resolveLinkedIgn(interaction.guildId, user.id);

          if (!ign) {
            return interaction
              .reply({
                embeds: [redErrEmbed("That user must be linked to an in-game account.")],
                flags: MessageFlags.Ephemeral,
              })
              .catch(() => {});
          }

          const stats = getPlayerStats(serverId, ign);

          const embed = new EmbedBuilder()
            .setColor(0x95a5a6)
            .setAuthor({
              name: safe(ign, 60),
              iconURL: user.displayAvatarURL({ size: 128 }),
            })
            // no thumbnail = no server logo top-right
            .addFields(
              {
                name: "Overview",
                value: `• Server: **${serverDisplay}**\n• Overall Rank: **#${stats.rank}**`,
                inline: true,
              },
              {
                name: "Combat",
                value: `• Kills: **${stats.kills}** | Deaths: **${stats.deaths}** | KD: **${stats.kd}**\n• Highest KS: **${stats.highestKillstreak}**`,
                inline: true,
              },
              {
                name: "Time",
                value: `• Playtime: **${formatDuration(stats.seconds)}**`,
                inline: true,
              }
            )
            .setFooter({
              text: `Player Search • ${ign}`,
              iconURL: user.displayAvatarURL({ size: 64 }),
            });

          return interaction
            .reply({
              content: `${user}`, // ping works here
              allowedMentions: { users: [user.id] },
              embeds: [embed],
            })
            .catch(() => {});
        }

        // ---------- /search clan ----------
        if (sub === "clan") {
          const role = interaction.options.getRole("role", true);
          const clan = getClanFromRole(interaction.guildId, serverId, role.id);

          if (!clan) {
            return interaction
              .reply({
                embeds: [redErrEmbed("That role is not a clan for this server.")],
                flags: MessageFlags.Ephemeral,
              })
              .catch(() => {});
          }

          const stats = aggregateClanStats(interaction.guildId, serverId, clan);
          const rank = getClanRank(interaction.guildId, serverId, role.id);

          const clanName = safe(clan.name || role.name, 80);

          const embed = new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle(clanName)
            .addFields(
              {
                name: "Overview",
                value: `• Server: **${serverDisplay}**\n• Overall Clan Rank: **#${rank}**`,
                inline: true,
              },
              {
                name: "Combat",
                value: `• Kills: **${stats.kills}** | Deaths: **${stats.deaths}** | KD: **${stats.kd}**\n• Highest KS: **${stats.highestKillstreak}**`,
                inline: true,
              },
              {
                name: "Time",
                value: `• Playtime: **${formatDuration(stats.seconds)}**`,
                inline: true,
              }
            )
            .setFooter({
              text: `Clan Search • ${serverDisplay} • ${clanName}`,
            });

          return interaction.reply({ embeds: [embed] }).catch(() => {});
        }

        return interaction
          .reply({ embeds: [redErrEmbed("Unknown subcommand.")], flags: MessageFlags.Ephemeral })
          .catch(() => {});
      } catch (e) {
        console.error("[search] error:", e);
        try {
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [redErrEmbed("Error. Check console.")], flags: MessageFlags.Ephemeral });
          }
        } catch {}
      }
    });
  },
};