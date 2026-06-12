const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
} = require("discord.js");

const { listServers, getServer, rce } = require("./rce");

const CFG_PATH = path.join(__dirname, "poptracker_config.json");
const POLL_MS = 5000;

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

function getRoleConfig() {
  return readJsonSafe(path.join(__dirname, "roles.json"), {});
}

function isOwner(member) {
  const roles = getRoleConfig();
  const ownerRoleId = roles?.ownerRoleId;
  if (!member) return false;
  if (member.permissions?.has?.("Administrator")) return true;
  if (ownerRoleId && member.roles?.cache?.has(ownerRoleId)) return true;
  return false;
}

function getCfg() {
  return readJsonSafe(CFG_PATH, {});
}

function saveCfg(data) {
  writeJsonSafe(CFG_PATH, data);
}

function getServerDisplay(serverId) {
  try {
    const s = getServer(serverId);
    return String(s?.displayName || s?.identifier || serverId || "Unknown").trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

function getGuildServersCfg(guildId) {
  const all = getCfg();
  return all?.[guildId] || {};
}

function setServerChannel(guildId, serverId, channel) {
  const all = getCfg();
  const slot = ensure(all, guildId, serverId);
  slot.channelId = channel.id;
  slot.baseName = stripSuffix(channel.name);
  slot.updatedAt = Date.now();
  saveCfg(all);
}

function removeServerChannel(guildId, serverId) {
  const all = getCfg();
  if (all?.[guildId]?.[serverId]) {
    delete all[guildId][serverId];
    saveCfg(all);
  }
}

function stripSuffix(name) {
  return String(name || "").replace(/🌐\d+🕒\d+$/u, "").trim();
}

function parseServerInfoResponse(response) {
  const text = String(response ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const jsonSlice = text.slice(start, end + 1).replace(/\\n/g, "\n");
  try {
    return JSON.parse(jsonSlice);
  } catch {
    try {
      return JSON.parse(jsonSlice.replace(/\n/g, ""));
    } catch {
      return null;
    }
  }
}

function buildMainEmbed(guildId, guild) {
  const cfg = getGuildServersCfg(guildId);
  const lines = [];

  for (const [serverId, entry] of Object.entries(cfg)) {
    const ch = guild.channels.cache.get(entry.channelId);
    if (!ch) continue;
    lines.push(`**${safeName(getServerDisplay(serverId))}** • ${ch}`);
  }

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      `### Population Tracker - Channels\n${
        lines.length ? lines.join("\n") : "No pop channels configured yet."
      }`
    )
    .setTimestamp();
}

function buildMainRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("poptracker_add")
      .setLabel("Add Pop Channel")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("poptracker_remove")
      .setLabel("Remove Pop Channel")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("poptracker_edit")
      .setLabel("Edit Pop Channel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function serverOptions() {
  return listServers()
    .map((s) => ({
      label: safeName(s.displayName || s.identifier, 100),
      value: s.identifier,
    }))
    .slice(0, 25);
}

function configuredServerOptions(guildId) {
  const cfg = getGuildServersCfg(guildId);
  return Object.keys(cfg)
    .map((serverId) => ({
      label: safeName(getServerDisplay(serverId), 100),
      value: serverId,
    }))
    .slice(0, 25);
}

async function refreshPanel(message) {
  try {
    await message.edit({
      embeds: [buildMainEmbed(message.guildId, message.guild)],
      components: [buildMainRow()],
    });
  } catch {}
}

module.exports = {
  name: "poptracker",

  init(client) {


    let running = false;

    async function tick() {
      if (running) return;
      running = true;

      try {
        const cfg = getCfg();

        for (const [guildId, guildCfg] of Object.entries(cfg)) {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) continue;

          for (const [serverId, entry] of Object.entries(guildCfg || {})) {
            try {
              const channel = guild.channels.cache.get(entry.channelId) || await guild.channels.fetch(entry.channelId).catch(() => null);
              if (!channel || typeof channel.setName !== "function") continue;

              const raw = await rce.sendCommand(serverId, "serverinfo").catch(() => null);
              const info = parseServerInfoResponse(raw);
              if (!info) continue;

              const players = Number(info?.Players || 0);
              const joining = Number(info?.Joining || 0);

              const baseName = stripSuffix(entry.baseName || channel.name || "server");
              const nextName = `${baseName}🌐${players}🕒${joining}`;

              if (channel.name !== nextName) {
                await channel.setName(nextName).catch(() => {});
              }

              const all = getCfg();
              if (all?.[guildId]?.[serverId]) {
                all[guildId][serverId].baseName = baseName;
                all[guildId][serverId].lastPlayers = players;
                all[guildId][serverId].lastJoining = joining;
                all[guildId][serverId].updatedAt = Date.now();
                saveCfg(all);
              }
            } catch (e) {
              console.log("[poptracker] update failed:", serverId, e?.message || e);
            }
          }
        }
      } finally {
        running = false;
      }
    }

    setInterval(tick, POLL_MS);
    tick();

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "setup-poptracker") return;

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

          return interaction.respond(choices).catch(() => {});
        }

        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "setup-poptracker") return;
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server." }).catch(() => {});
          }

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!isOwner(member)) {
            return interaction.reply({ content: "You do not have permission." }).catch(() => {});
          }

          return interaction.reply({
            embeds: [buildMainEmbed(interaction.guildId, interaction.guild)],
            components: [buildMainRow()],
          }).catch(() => {});
        }

        if (interaction.isButton()) {
          if (!interaction.customId.startsWith("poptracker_")) return;

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!isOwner(member)) {
            return interaction.reply({ content: "You do not have permission.", ephemeral: true }).catch(() => {});
          }

          if (interaction.customId === "poptracker_add") {
            const options = serverOptions();
            if (!options.length) {
              return interaction.reply({ content: "No servers configured.", ephemeral: true }).catch(() => {});
            }

            const row = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId("poptracker_add_server")
                .setPlaceholder("Select a server")
                .addOptions(options)
            );

            return interaction.reply({
              content: "Select a server.",
              components: [row],
              ephemeral: true,
            }).catch(() => {});
          }

          if (interaction.customId === "poptracker_remove") {
            const options = configuredServerOptions(interaction.guildId);
            if (!options.length) {
              return interaction.reply({ content: "No configured pop channels to remove.", ephemeral: true }).catch(() => {});
            }

            const row = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId("poptracker_remove_server")
                .setPlaceholder("Select a server")
                .addOptions(options)
            );

            return interaction.reply({
              content: "Select a server to remove.",
              components: [row],
              ephemeral: true,
            }).catch(() => {});
          }

          if (interaction.customId === "poptracker_edit") {
            const options = configuredServerOptions(interaction.guildId);
            if (!options.length) {
              return interaction.reply({ content: "No configured pop channels to edit.", ephemeral: true }).catch(() => {});
            }

            const row = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId("poptracker_edit_server")
                .setPlaceholder("Select a server")
                .addOptions(options)
            );

            return interaction.reply({
              content: "Select a server to edit.",
              components: [row],
              ephemeral: true,
            }).catch(() => {});
          }
        }

        if (interaction.isStringSelectMenu()) {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!isOwner(member)) {
            return interaction.reply({ content: "You do not have permission.", ephemeral: true }).catch(() => {});
          }

          if (interaction.customId === "poptracker_add_server") {
            const serverId = interaction.values[0];
            const row = new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId(`poptracker_add_channel:${serverId}`)
                .setPlaceholder("Select a channel")
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.GuildVoice,
                  ChannelType.GuildAnnouncement,
                  ChannelType.GuildForum,
                  ChannelType.GuildStageVoice
                )
            );

            return interaction.update({
              content: `Selected **${safeName(getServerDisplay(serverId))}**. Now select a channel.`,
              components: [row],
            }).catch(() => {});
          }

          if (interaction.customId === "poptracker_remove_server") {
            const serverId = interaction.values[0];
            removeServerChannel(interaction.guildId, serverId);

            await interaction.update({
              content: `Removed pop tracker for **${safeName(getServerDisplay(serverId))}**.`,
              components: [],
            }).catch(() => {});

            const parentMsg = await interaction.channel.messages.fetch(interaction.message.reference?.messageId || interaction.message.id).catch(() => null);
            if (parentMsg) await refreshPanel(parentMsg);
            return;
          }

          if (interaction.customId === "poptracker_edit_server") {
            const serverId = interaction.values[0];
            const row = new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId(`poptracker_edit_channel:${serverId}`)
                .setPlaceholder("Select a new channel")
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.GuildVoice,
                  ChannelType.GuildAnnouncement,
                  ChannelType.GuildForum,
                  ChannelType.GuildStageVoice
                )
            );

            return interaction.update({
              content: `Editing **${safeName(getServerDisplay(serverId))}**. Now select a channel.`,
              components: [row],
            }).catch(() => {});
          }
        }

        if (interaction.isChannelSelectMenu()) {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!isOwner(member)) {
            return interaction.reply({ content: "You do not have permission.", ephemeral: true }).catch(() => {});
          }

          if (interaction.customId.startsWith("poptracker_add_channel:")) {
            const serverId = interaction.customId.split(":")[1];
            const channelId = interaction.values[0];
            const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!channel) {
              return interaction.update({ content: "Channel not found.", components: [] }).catch(() => {});
            }

            setServerChannel(interaction.guildId, serverId, channel);
            await interaction.update({
              content: `Added **${safeName(getServerDisplay(serverId))}** → ${channel}.`,
              components: [],
            }).catch(() => {});

            const raw = await rce.sendCommand(serverId, "serverinfo").catch(() => null);
            const info = parseServerInfoResponse(raw);
            if (info && typeof channel.setName === "function") {
              const players = Number(info?.Players || 0);
              const joining = Number(info?.Joining || 0);
              const baseName = stripSuffix(channel.name);
              await channel.setName(`${baseName}🌐${players}🕒${joining}`).catch(() => {});
            }
            return;
          }

          if (interaction.customId.startsWith("poptracker_edit_channel:")) {
            const serverId = interaction.customId.split(":")[1];
            const channelId = interaction.values[0];
            const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!channel) {
              return interaction.update({ content: "Channel not found.", components: [] }).catch(() => {});
            }

            setServerChannel(interaction.guildId, serverId, channel);
            await interaction.update({
              content: `Updated **${safeName(getServerDisplay(serverId))}** → ${channel}.`,
              components: [],
            }).catch(() => {});

            const raw = await rce.sendCommand(serverId, "serverinfo").catch(() => null);
            const info = parseServerInfoResponse(raw);
            if (info && typeof channel.setName === "function") {
              const players = Number(info?.Players || 0);
              const joining = Number(info?.Joining || 0);
              const baseName = stripSuffix(channel.name);
              await channel.setName(`${baseName}🌐${players}🕒${joining}`).catch(() => {});
            }
            return;
          }
        }
      } catch (e) {
        console.error("[poptracker] error:", e);
      }
    });

    console.log("[poptracker] polling every 5s");
  },
};
