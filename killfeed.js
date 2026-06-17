const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const { RCEEvent } = require("rce.js");
const { listServers, getServer } = require("./rce");
const { readRoles } = require("./roles");

const CONFIG_PATH = path.join(__dirname, "killfeed_config.json");
const FEED_PATH = path.join(__dirname, "killfeed.json");
const BANS_PATH = path.join(__dirname, "killfeedbans.json");
const REPLACE_PATH = path.join(__dirname, "killfeednamereplace.json");

function ensureFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
  } catch {}
}

function readJson(file, fallback) {
  try {
    ensureFile(file, fallback);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readConfig() {
  return readJson(CONFIG_PATH, {});
}

function writeConfig(data) {
  writeJson(CONFIG_PATH, data);
}

function readFeedStore() {
  return readJson(FEED_PATH, {});
}

function writeFeedStore(data) {
  writeJson(FEED_PATH, data);
}

function readBans() {
  const raw = readJson(BANS_PATH, []);
  return Array.isArray(raw) ? raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
}

function readReplacements() {
  const raw = readJson(REPLACE_PATH, {});
  return raw && typeof raw === "object" ? raw : {};
}

function getServerDisplay(serverId) {
  const s = typeof getServer === "function" ? getServer(serverId) : null;
  return s?.displayName || s?.identifier || serverId || "Unknown";
}

function isOwner(interaction) {
  const roles = readRoles();
  if (!roles?.ownerRoleId) return false;
  return Boolean(interaction.member?.roles?.cache?.has(roles.ownerRoleId));
}

function formatClock(ts = Date.now()) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}.${String(secs).padStart(2, "0")}`;
}

function applyReplacement(name) {
  const replacements = readReplacements();
  const lower = String(name || "").trim().toLowerCase();

  for (const [from, to] of Object.entries(replacements)) {
    if (String(from).trim().toLowerCase() === lower) {
      return String(to || name).trim() || String(name || "Unknown");
    }
  }

  return String(name || "Unknown").trim() || "Unknown";
}

function isBannedName(name) {
  const bans = readBans();
  return bans.includes(String(name || "").trim().toLowerCase());
}

function ensureGuildServer(obj, guildId, serverId) {
  if (!obj[guildId]) obj[guildId] = {};
  if (!obj[guildId][serverId]) {
    obj[guildId][serverId] = {
      startedAt: Date.now(),
      kills: [],
    };
  }
  return obj[guildId][serverId];
}

async function flushKillfeedBatch(client, guildId, serverId) {
  const config = readConfig();
  const channelId = config?.[guildId]?.[serverId]?.killfeedChannelId;
  if (!channelId) return;

  const store = readFeedStore();
  const slot = ensureGuildServer(store, guildId, serverId);

  if (!Array.isArray(slot.kills) || slot.kills.length < 10) return;

  const batch = slot.kills.slice(0, 10);
  const desc = batch
    .map((k) => `[${k.elapsed}] \`${k.killer}🩸 ➝ ${k.victim}💀\``)
    .join("\n");

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`Recent kills - ${getServerDisplay(serverId)}`)
      .setDescription(desc)
      .setFooter({
        text: `Vertex | Latest 10 Kills`,
      })
      .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error("[killfeed] flush send error:", e);
  }

  slot.kills = slot.kills.slice(10);
  slot.startedAt = Date.now();
  writeFeedStore(store);
}

module.exports = {
  name: "killfeed",

  init(client, rce) {
    ensureFile(CONFIG_PATH, {});
    ensureFile(FEED_PATH, {});
    ensureFile(BANS_PATH, []);
    ensureFile(REPLACE_PATH, {});

    if (!client.__killfeedRceBound) {
      client.__killfeedRceBound = true;

      rce.on(RCEEvent.PlayerKill, async (payload) => {
        try {
          const serverId = payload?.server?.identifier;
          const killerRaw = String(payload?.killer?.name || "Unknown").trim();
          const victimRaw = String(payload?.victim?.name || "Unknown").trim();

          if (!serverId) return;

          if (isBannedName(killerRaw) || isBannedName(victimRaw)) return;

          const killer = applyReplacement(killerRaw);
          const victim = applyReplacement(victimRaw);

          if (isBannedName(killer) || isBannedName(victim)) return;

          const config = readConfig();
          const guildEntries = Object.entries(config).filter(
            ([, guildCfg]) => guildCfg && guildCfg[serverId] && guildCfg[serverId].killfeedChannelId
          );

          if (!guildEntries.length) return;

          for (const [guildId] of guildEntries) {
            const store = readFeedStore();
            const slot = ensureGuildServer(store, guildId, serverId);

            if (!slot.startedAt) slot.startedAt = Date.now();

            slot.kills.push({
              killer,
              victim,
              at: Date.now(),
              elapsed: formatElapsed(Date.now() - slot.startedAt),
            });

            writeFeedStore(store);

            if (slot.kills.length >= 10) {
              await flushKillfeedBatch(client, guildId, serverId);
            }
          }
        } catch (e) {
          console.error("[killfeed] PlayerKill error:", e);
        }
      });
    }

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "configure-feeds") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const q = String(focused.value || "").toLowerCase();
          const choices = listServers()
            .map((s) => ({
              name: String(s.displayName || s.identifier).slice(0, 100),
              value: s.identifier,
            }))
            .filter((x) => x.name.toLowerCase().includes(q))
            .slice(0, 25);

          return interaction.respond(choices).catch(() => {});
        }

        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "configure-feeds") return;

        if (!interaction.inGuild()) {
          return interaction.reply({
            content: "Use this in a server.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        if (!isOwner(interaction)) {
          return interaction.reply({
            content: "Owner role only.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const killfeedChannel = interaction.options.getChannel("killfeed", true);

        if (!listServers().some((s) => s.identifier === serverId)) {
          return interaction.reply({
            content: "Server not found.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        const cfg = readConfig();
        if (!cfg[interaction.guildId]) cfg[interaction.guildId] = {};
        if (!cfg[interaction.guildId][serverId]) cfg[interaction.guildId][serverId] = {};

        cfg[interaction.guildId][serverId].killfeedChannelId = killfeedChannel.id;
        writeConfig(cfg);

        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("Killfeed Configured")
              .setDescription(
                `Server: **${getServerDisplay(serverId)}**\nKillfeed: ${killfeedChannel}`
              )
              .setTimestamp(),
          ],
        }).catch(() => {});
      } catch (e) {
        console.error("[killfeed] interaction error:", e);
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({
              content: "Error. Check console.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          } else {
            await interaction.reply({
              content: "Error. Check console.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }
        }
      }
    });
  },
};