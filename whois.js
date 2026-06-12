// modules/whois.js — /whois
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { listServers } = require("../rce");
const { readLinks } = require("../shared/links");
const { readKills } = require("../shared/kills");
const { readPlaytime } = require("../shared/playtime");

function log(...a) { console.log("[whois]", ...a); }
function logErr(...a) { console.error("[whois]", ...a); }

function norm(s) { return String(s || "").trim().toLowerCase(); }

function grey() { return new EmbedBuilder().setColor(0x95a5a6).setTimestamp(); }

function formatPlaytime(seconds) {
  if (!seconds || seconds < 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getKDStats(gamertag) {
  const kills_data = readKills();
  const key = norm(gamertag);
  let kills = 0;
  let deaths = 0;

  for (const serverData of Object.values(kills_data)) {
    const players = serverData?.players || {};
    // Try exact lowercase match first
    if (players[key]) {
      kills  += players[key].kills  || 0;
      deaths += players[key].deaths || 0;
      continue;
    }
    // Fallback: scan all keys for partial match (handles capitalisation differences)
    for (const [k, v] of Object.entries(players)) {
      if (k === key || norm(v?.name) === key) {
        kills  += v?.kills  || 0;
        deaths += v?.deaths || 0;
        break;
      }
    }
  }

  const kd = deaths === 0 ? kills.toFixed(2) : (kills / deaths).toFixed(2);
  return { kills, deaths, kd };
}

function getPlaytimeSeconds(gamertag) {
  const playtime_data = readPlaytime();
  const key = norm(gamertag);
  let total = 0;

  for (const serverData of Object.values(playtime_data)) {
    const players = serverData?.players || {};
    if (players[key]) {
      total += players[key].seconds || 0;
      continue;
    }
    for (const [k, v] of Object.entries(players)) {
      if (k === key || norm(v?.name) === key) {
        total += v?.seconds || 0;
        break;
      }
    }
  }

  return total;
}

module.exports = {
  name: "whois",

  init(client) {
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "whois") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const targetUser = interaction.options.getUser("user", true);
        const links = readLinks();
        const entry  = links[targetUser.id];

        if (!entry?.gamertag) {
          return interaction.editReply({
            content: `❌ **${targetUser.tag}** has not linked their account.`,
          });
        }

        const { gamertag, linkedAt, aliases = [] } = entry;

        const { kills, deaths, kd } = getKDStats(gamertag);
        const playtimeSeconds = getPlaytimeSeconds(gamertag);
        const playtime = formatPlaytime(playtimeSeconds);

        const linkedDate = linkedAt
          ? `<t:${Math.floor(linkedAt / 1000)}:D>`
          : "Unknown";

        const aliasDisplay = aliases.length > 0
          ? aliases.join(", ")
          : "None";

        const embed = grey()
          .setTitle(`Whois — ${targetUser.tag}`)
          .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: "Gamertag",    value: gamertag,    inline: true },
            { name: "Linked",      value: linkedDate,  inline: true },
            { name: "\u200b",      value: "\u200b",    inline: true },
            { name: "Playtime",    value: playtime,    inline: true },
            { name: "Kills",       value: String(kills),   inline: true },
            { name: "Deaths",      value: String(deaths),  inline: true },
            { name: "K/D",         value: String(kd),      inline: true },
            { name: "\u200b",      value: "\u200b",    inline: true },
            { name: "\u200b",      value: "\u200b",    inline: true },
            { name: "Past Aliases", value: aliasDisplay, inline: false }
          );

        log("whois lookup:", targetUser.tag, "→", gamertag);
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        logErr("command error:", e?.message || e);
        if (interaction.deferred) {
          try { await interaction.editReply({ content: "Error. Check console." }); } catch {}
        } else if (interaction.isRepliable() && !interaction.replied) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        }
      }
    });
  },
};
