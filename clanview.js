// modules/clanview.js
const fs = require("fs");
const path = require("path");

const { ContainerBuilder, MessageFlags } = require("discord.js");
const { listServers } = require("../rce");

const CLANS_PATH = path.join(__dirname, "..", "data", "clans.json");

function log(...args) {
  console.log("[clanview]", ...args);
}
function logErr(...args) {
  console.error("[clanview]", ...args);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logErr("readJsonSafe failed:", e?.message || e);
    return fallback;
  }
}

function readClans() {
  return readJsonSafe(CLANS_PATH, {});
}

function getServerClanMap(all, guildId, serverId) {
  return all?.[guildId]?.[serverId] || {};
}

function normalizeName(s) {
  return String(s || "").trim().toLowerCase();
}

function findClanByName(serverMap, inputName) {
  const needle = normalizeName(inputName);
  if (!needle) return null;

  for (const [roleId, clan] of Object.entries(serverMap)) {
    const name = normalizeName(clan?.name);
    if (name === needle) return { roleId, clan };
  }
  return null;
}

// 2 members per line: "- @A • @B"
function formatMembersTwoPerRow(memberIds) {
  const ids = Array.isArray(memberIds) ? memberIds : [];
  if (ids.length === 0) return ["- *(no members)*"];

  const out = [];
  for (let i = 0; i < ids.length; i += 2) {
    const a = `<@${ids[i]}>`;
    const b = ids[i + 1] ? ` • <@${ids[i + 1]}>` : "";
    out.push(`- ${a}${b}`);
  }
  return out;
}

// Split long member lists across multiple text display components so it "gets longer"
function splitByCharLimit(lines, maxChars = 3500) {
  const chunks = [];
  let cur = [];
  let curLen = 0;

  for (const line of lines) {
    const addLen = line.length + 1;
    if (curLen + addLen > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += addLen;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function buildClanViewContainer({ clanName, leaderId, members, memberCount }) {
  const header = `## **${clanName}**`;
  const leaderBlock = [`__Leader__`, `<@${leaderId}>`].join("\n");

  const memberLines = formatMembersTwoPerRow(members);

  // safety: don't spam huge clans (still shows a lot, but capped)
  const MAX_MEMBER_LINES = 160; // each line = 2 members, so ~320 members shown
  let shownLines = memberLines;
  let extraLines = 0;

  if (memberLines.length > MAX_MEMBER_LINES) {
    shownLines = memberLines.slice(0, MAX_MEMBER_LINES);
    extraLines = memberLines.length - MAX_MEMBER_LINES;
    shownLines.push(`- *(+${extraLines * 2} more members)*`);
  }

  const membersHeader = `__Members - ${memberCount}__`;

  // split across multiple text blocks so it can be longer than one block
  const memberChunks = splitByCharLimit([membersHeader, ...shownLines], 3500);

  const c = new ContainerBuilder()
    .setAccentColor(0x95a5a6) // green
    .addTextDisplayComponents((t) => t.setContent(header))
    .addSeparatorComponents((s) => s)
    .addTextDisplayComponents((t) => t.setContent(leaderBlock))
    .addSeparatorComponents((s) => s);

  for (const chunk of memberChunks) {
    c.addTextDisplayComponents((t) => t.setContent(chunk.join("\n")));
  }

  return c;
}

module.exports = {
  name: "clanview",

  init(client) {


    // AUTOCOMPLETE: server ONLY (NO clan autocomplete — user types it)
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "clan") return;
        if (interaction.options.getSubcommand() !== "view") return;

        const focused = interaction.options.getFocused(true);

        if (focused.name !== "server") {
          // no choices for clan input
          return interaction.respond([]).catch(() => {})
        }

        const servers = listServers();
        const q = normalizeName(focused.value);

        const choices = servers
          .map((s) => ({
            name: (s.displayName || s.identifier).slice(0, 100),
            value: s.identifier,
          }))
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 25);

        return interaction.respond(choices).catch(() => {})
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // /clan view
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "clan") return;
        if (interaction.options.getSubcommand() !== "view") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        const serverId = interaction.options.getString("server", true);
        const clanNameInput = interaction.options.getString("clan", true);

        const exists = listServers().some((s) => s.identifier === serverId);
        if (!exists) {
          return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
        }

        const all = readClans();
        const serverMap = getServerClanMap(all, interaction.guildId, serverId);

        if (!serverMap || Object.keys(serverMap).length === 0) {
          return interaction.reply({ content: "No clans exist on this server yet.", flags: MessageFlags.Ephemeral });
        }

        const found = findClanByName(serverMap, clanNameInput);
        if (!found) {
          return interaction.reply({
            content: "Clan not found. (Not case sensitive, but spelling must match.)",
            flags: MessageFlags.Ephemeral,
          });
        }

        const { roleId, clan } = found;

        // LIVE members from role (truth). fallback to json.
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        const members = role ? [...role.members.keys()] : Array.isArray(clan?.members) ? clan.members : [];
        const memberCount = role ? role.members.size : members.length;

        log("view", {
          guildId: interaction.guildId,
          serverId,
          clanRoleId: roleId,
          clanName: clan?.name,
          leaderId: clan?.leaderId,
          members: memberCount,
          source: role ? "role" : "json",
        });

        const container = buildClanViewContainer({
          clanName: clan?.name || clanNameInput,
          leaderId: clan?.leaderId || "0",
          members,
          memberCount,
        });

        return interaction.reply({
          components: [container],
          flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
      } catch (e) {
        logErr("command error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};