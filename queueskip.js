const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { listServers, getServer, rce } = require("../rce");

const DATA_PATH = path.join(__dirname, "..", "data", "queueskip_data.json");
const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");
const { readLinks } = require("../shared/links");

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function safeName(s, max = 100) {
  return String(s || "").trim().slice(0, max) || "Unknown";
}

function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function getServerDisplay(serverId) {
  try {
    const s = typeof getServer === "function" ? getServer(serverId) : null;
    return String(s?.displayName || s?.identifier || serverId || "Unknown").trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

function findServerIdentifierFromText(serverText) {
  const needle = norm(serverText);
  if (!needle) return null;

  const servers = listServers();
  for (const s of servers) {
    const a = norm(s?.displayName);
    const b = norm(s?.identifier);
    if (a === needle || b === needle) return s.identifier;
  }

  for (const s of servers) {
    const a = norm(s?.displayName);
    const b = norm(s?.identifier);
    if (a.includes(needle) || needle.includes(a) || b.includes(needle) || needle.includes(b)) {
      return s.identifier;
    }
  }

  return null;
}

function getBalances() {
  return readJsonSafe(DATA_PATH, {});
}

function saveBalances(data) {
  writeJsonSafe(DATA_PATH, data);
}

function getBalance(guildId, serverId, userId) {
  const data = getBalances();
  return Math.max(0, Number(data?.[guildId]?.[serverId]?.[userId] || 0));
}

function setBalance(guildId, serverId, userId, amount) {
  const data = getBalances();
  const slot = ensure(data, guildId, serverId);
  slot[userId] = Math.max(0, Number(amount) || 0);
  saveBalances(data);
  return slot[userId];
}

function addBalance(guildId, serverId, userId, amount) {
  const cur = getBalance(guildId, serverId, userId);
  return setBalance(guildId, serverId, userId, cur + Math.max(0, Number(amount) || 0));
}

function takeBalance(guildId, serverId, userId, amount) {
  const cur = getBalance(guildId, serverId, userId);
  return setBalance(guildId, serverId, userId, Math.max(0, cur - Math.max(0, Number(amount) || 0)));
}

function wipeServerBalances(guildId, serverId) {
  const data = getBalances();
  if (!data[guildId]) data[guildId] = {};
  data[guildId][serverId] = {};
  saveBalances(data);
}

function extractLinkedPlayerName(guildId, userId) {
  const data = readLinks();
  const directGuild = data?.[guildId]?.[userId];
  const direct = data?.[userId];
  const candidates = [directGuild, direct].filter(Boolean);

  for (const c of candidates) {
    if (typeof c === "string") return c;
    if (typeof c?.gamertag === "string") return c.gamertag;
    if (typeof c?.gt === "string") return c.gt;
    if (typeof c?.xbox === "string") return c.xbox;
    if (typeof c?.playerName === "string") return c.playerName;
    if (typeof c?.player === "string") return c.player;
    if (typeof c?.name === "string") return c.name;
  }

  return null;
}

function findLinkedDiscordByGamertag(guildId, gamertag) {
  const data = readLinks();
  const want = norm(gamertag);
  if (!want) return null;

  const guildBlock = data?.[guildId];
  if (guildBlock && typeof guildBlock === "object") {
    for (const [userId, value] of Object.entries(guildBlock)) {
      const tags = [
        typeof value === "string" ? value : null,
        value?.gamertag,
        value?.gt,
        value?.xbox,
        value?.playerName,
        value?.player,
        value?.name,
      ].filter(Boolean);

      if (tags.some((x) => norm(x) === want)) return userId;
    }
  }

  for (const [userId, value] of Object.entries(data)) {
    if (!/^\d+$/.test(userId)) continue;

    const tags = [
      typeof value === "string" ? value : null,
      value?.gamertag,
      value?.gt,
      value?.xbox,
      value?.playerName,
      value?.player,
      value?.name,
    ].filter(Boolean);

    if (tags.some((x) => norm(x) === want)) return userId;
  }

  return null;
}

function getRoleConfig() {
  return readJsonSafe(ROLES_PATH, {});
}

function isAdminOrOwner(member) {
  const roles = getRoleConfig();
  const adminRoleId = roles?.adminRoleId;
  const ownerRoleId = roles?.ownerRoleId;

  if (!member) return false;
  if (member.permissions?.has?.("Administrator")) return true;
  if (ownerRoleId && member.roles?.cache?.has(ownerRoleId)) return true;
  if (adminRoleId && member.roles?.cache?.has(adminRoleId)) return true;
  return false;
}

function whiteEmbed(description) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(description).setTimestamp();
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function parsePurchaseMessage(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const amountMatch = s.match(/\*\*(\d+)\s+Queue\s+Skip(?:s)?\*\*/i);
  const userMatch = s.match(/\bby\s+\*\*(.*?)\*\*/i);
  const serverMatch = s.match(/\bon\s+\*\*(.*?)\*\*/i);

  if (!amountMatch || !userMatch || !serverMatch) return null;

  return {
    amount: Math.max(1, Number(amountMatch[1]) || 1),
    gamertag: userMatch[1].trim(),
    serverText: serverMatch[1].trim(),
  };
}

module.exports = {
  name: "queueskip",

  init(client) {


    client.on("messageCreate", async (message) => {
      try {
        if (!message.inGuild()) return;
        if (!message.webhookId) return;

        const parsed = parsePurchaseMessage(message.content);
        if (!parsed) return;

        const { amount, gamertag, serverText } = parsed;
        const guildId = message.guildId;

        const userId = findLinkedDiscordByGamertag(guildId, gamertag);
        if (!userId) {
          return message.reply(`:x: No linked Discord found for **${safeName(gamertag, 64)}**`).catch(() => {});
        }

        const serverId = findServerIdentifierFromText(serverText);
        if (!serverId) {
          return message.reply(`:x: Could not find server **${safeName(serverText, 64)}**`).catch(() => {});
        }

        addBalance(guildId, serverId, userId, amount);

        return message.reply(`:white_check_mark: **${amount}** Queue Skip${amount === 1 ? "" : "s"} added to <@${userId}>`).catch(() => {});
      } catch (e) {
        console.error("[queueskip] webhook purchase error:", e);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "queueskip") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const q = norm(focused.value);
          const choices = listServers()
            .map((s) => ({
              name: safeName(s.displayName || s.identifier, 100),
              value: s.identifier,
            }))
            .filter((x) => norm(x.name).includes(q))
            .slice(0, 25);

          await interaction.respond(choices).catch(() => {});
          return;
        }
      } catch {}

      try {
        if (interaction.isButton()) {
          if (!interaction.customId.startsWith("queueskip_wipeall_confirm:")) return;

          const [, guildId, serverId, userId] = interaction.customId.split(":");
          if (interaction.user.id !== userId) {
            return interaction.reply({ content: "This confirm button is not for you." }).catch(() => {});
          }

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!isAdminOrOwner(member)) {
            return interaction.reply({ content: "You do not have permission." }).catch(() => {});
          }

          wipeServerBalances(guildId, serverId);

          return interaction.update({
            content: "",
            embeds: [
              whiteEmbed(`### Queue Skips Wiped\nAll queue skips for **${safeName(getServerDisplay(serverId))}** were removed.`),
            ],
            components: [],
          }).catch(() => {});
        }
      } catch {}

      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "queueskip") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server." }).catch(() => {});
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const member = await interaction.guild.members.fetch(userId).catch(() => null);

        if (sub === "balance") {
          const serverId = interaction.options.getString("server", true);
          const bal = getBalance(guildId, serverId, userId);
          const serverDisplay = getServerDisplay(serverId);

          return interaction.reply({
            embeds: [
              whiteEmbed(`### Queue Skip Balance\nYou have **${bal}** queue skips for **${safeName(serverDisplay)}**`),
            ],
          }).catch(() => {});
        }

        if (sub === "give") {
          if (!isAdminOrOwner(member)) {
            return interaction.reply({ content: "You do not have permission." }).catch(() => {});
          }

          const serverId = interaction.options.getString("server", true);
          const target = interaction.options.getUser("user", true);
          const amount = Math.max(1, interaction.options.getInteger("amount", true));

          const next = addBalance(guildId, serverId, target.id, amount);
          return interaction.reply({
            embeds: [
              whiteEmbed(`### Queue Skips Added\n<@${target.id}> was given **${amount}** queue skips for **${safeName(getServerDisplay(serverId))}**.\nThey now have **${next}**.`),
            ],
          }).catch(() => {});
        }

        if (sub === "remove") {
          if (!isAdminOrOwner(member)) {
            return interaction.reply({ content: "You do not have permission." }).catch(() => {});
          }

          const serverId = interaction.options.getString("server", true);
          const target = interaction.options.getUser("user", true);
          const amount = Math.max(1, interaction.options.getInteger("amount", true));

          const before = getBalance(guildId, serverId, target.id);
          const next = takeBalance(guildId, serverId, target.id, amount);
          const removed = Math.min(before, amount);

          return interaction.reply({
            embeds: [
              whiteEmbed(`### Queue Skips Removed\nRemoved **${removed}** queue skips from <@${target.id}> on **${safeName(getServerDisplay(serverId))}**.\nThey now have **${next}**.`),
            ],
          }).catch(() => {});
        }

        if (sub === "transfer") {
          const serverId = interaction.options.getString("server", true);
          const target = interaction.options.getUser("user", true);
          const amount = Math.max(1, interaction.options.getInteger("amount", true));

          if (target.id === userId) {
            return interaction.reply({ content: "You cannot transfer to yourself." }).catch(() => {});
          }

          const mine = getBalance(guildId, serverId, userId);
          if (mine < amount) {
            return interaction.reply({
              content: `:x: You only have **${mine}** Queue Skips!`,
            }).catch(() => {});
          }

          takeBalance(guildId, serverId, userId, amount);
          const targetNext = addBalance(guildId, serverId, target.id, amount);
          const mineNext = getBalance(guildId, serverId, userId);

          return interaction.reply({
            embeds: [
              whiteEmbed(`### Queue Skips Transferred\nYou sent **${amount}** queue skips to <@${target.id}> on **${safeName(getServerDisplay(serverId))}**.\nYou now have **${mineNext}**. They now have **${targetNext}**.`),
            ],
          }).catch(() => {});
        }

        if (sub === "wipeall") {
          if (!isAdminOrOwner(member)) {
            return interaction.reply({ content: "You do not have permission." }).catch(() => {});
          }

          const serverId = interaction.options.getString("server", true);

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`queueskip_wipeall_confirm:${guildId}:${serverId}:${userId}`)
              .setLabel("Confirm Wipe")
              .setStyle(ButtonStyle.Danger)
          );

          return interaction.reply({
            content: `Are you sure you want to wipe all queue skips for **${safeName(getServerDisplay(serverId))}**?`,
            components: [row],
          }).catch(() => {});
        }

        if (sub === "use") {
          const serverId = interaction.options.getString("server", true);
          const serverDisplay = getServerDisplay(serverId);
          const bal = getBalance(guildId, serverId, userId);

          if (bal <= 0) {
            return interaction.reply({
              content: `:x: You have **0** Queue Skips!`,
            }).catch(() => {});
          }

          await interaction.reply({ content: "Checking for skips..." }).catch(() => {});
          await interaction.editReply({ content: "Finding in game name..." }).catch(() => {});

          const ign = extractLinkedPlayerName(guildId, userId);
          if (!ign) {
            return interaction.editReply({ content: ":x: No linked in-game name found." }).catch(() => {});
          }

          await interaction.editReply({ content: `Found **${safeName(ign, 64)}**...` }).catch(() => {});
          await interaction.editReply({ content: "Applying Queue Skip...." }).catch(() => {});

          const cmd = `global.skipqueue "${escapeQuotes(ign)}"`;
          console.log("[queueskip] sending:", serverId, cmd);

          try {
            await rce.sendCommand(serverId, cmd);
          } catch {
            return interaction.editReply({
              content: ":x: Failed to send queue skip command.",
            }).catch(() => {});
          }

          const remaining = takeBalance(guildId, serverId, userId, 1);

          return interaction.editReply({
            content: "",
            embeds: [
              whiteEmbed(
                `### Queue Skip Successfully Applied\n**${safeName(ign, 64)}**, your queue skip has been used on **${safeName(serverDisplay)}**.\nYou now have **${remaining}** remaining.`
              ),
            ],
          }).catch(() => {});
        }
      } catch (e) {
        console.error("[queueskip] error:", e);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "Error. Check console." });
          } else {
            await interaction.reply({ content: "Error. Check console." });
          }
        } catch {}
      }
    });
  },
};
