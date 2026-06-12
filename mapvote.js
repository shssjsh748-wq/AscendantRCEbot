const fs = require("fs");
const path = require("path");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  TextDisplayBuilder,
} = require("discord.js");

const { listServers, getServer } = require("../rce");
const { readRoles } = require("../modules/roles");

const MAPS_PATH = path.join(__dirname, "..", "data", "maps.json");
const ACCENT = 0x95a5a6;

function ensureMapsFile() {
  try {
    if (!fs.existsSync(MAPS_PATH)) {
      fs.writeFileSync(
        MAPS_PATH,
        JSON.stringify({ servers: {}, meta: { nextMapId: 1 } }, null, 2),
        "utf8"
      );
    }
  } catch {}
}

function readMaps() {
  try {
    ensureMapsFile();
    const raw = JSON.parse(fs.readFileSync(MAPS_PATH, "utf8"));
    if (!raw.servers) raw.servers = {};
    if (!raw.meta) raw.meta = { nextMapId: 1 };
    return raw;
  } catch {
    return { servers: {}, meta: { nextMapId: 1 } };
  }
}

function writeMaps(data) {
  fs.writeFileSync(MAPS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function ensureServerSlot(data, guildId, serverId) {
  if (!data.servers[guildId]) data.servers[guildId] = {};
  if (!data.servers[guildId][serverId]) {
    data.servers[guildId][serverId] = {
      maps: [],
      prioritised: [],
      lastWinningMapIds: [],
      activeVote: null,
    };
  }
  return data.servers[guildId][serverId];
}

function isOwner(interaction) {
  const roles = readRoles();
  if (!roles?.ownerRoleId) return false;
  return Boolean(interaction.member?.roles?.cache?.has(roles.ownerRoleId));
}

function getServerDisplay(serverId) {
  const s = typeof getServer === "function" ? getServer(serverId) : null;
  return s?.displayName || s?.identifier || serverId || "Unknown";
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildVoteButtons(voteId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mapvote:${voteId}:1`)
      .setLabel("Map 1")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mapvote:${voteId}:2`)
      .setLabel("Map 2")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mapvote:${voteId}:3`)
      .setLabel("Map 3")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mapvote:${voteId}:4`)
      .setLabel("Map 4")
      .setStyle(ButtonStyle.Success)
  );
}

function buildVoteComponents(roleId, serverDisplay, vote) {
  const totalVotes = Object.keys(vote.votes || {}).length;
  const endsUnix = Math.floor(vote.endsAt / 1000);

  const components = [
    new TextDisplayBuilder().setContent(
      `<@&${roleId}>! Map voting live on **${serverDisplay}** 🗺️ - **${totalVotes} Votes** | Ends <t:${endsUnix}:R>`
    ),
  ];

  for (const option of vote.options) {
    const count = Object.values(vote.votes || {}).filter((x) => Number(x) === Number(option.slot)).length;

    components.push(
      new ContainerBuilder()
        .setAccentColor(ACCENT)
        .addTextDisplayComponents((t) =>
          t.setContent(`**Map ${option.slot}** - ${count} votes`)
        )
        .addMediaGalleryComponents((g) =>
          g.addItems((i) => i.setURL(option.imageUrl))
        )
    );
  }

  return components;
}

function buildConcludedComponents(roleId, serverDisplay, winningOption) {
  return [
    new TextDisplayBuilder().setContent(
      `<@&${roleId}>! Map vote concluded for **${serverDisplay}** 🗺️\n\n🏆 The winning map is **Map ${winningOption.slot}**`
    ),
    new MediaGalleryBuilder().addItems((i) => i.setURL(winningOption.imageUrl)),
  ];
}
async function refreshVoteMessage(client, guildId, serverId) {
  const data = readMaps();
  const slot = ensureServerSlot(data, guildId, serverId);
  const vote = slot.activeVote;
  if (!vote || !vote.messageId) return;

  const channel = await client.channels.fetch(vote.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(vote.messageId).catch(() => null);
  if (!msg) return;

  await msg.edit({
    flags: MessageFlags.IsComponentsV2,
    components: buildVoteComponents(vote.roleId, getServerDisplay(serverId), vote),
  }).catch(() => {});
}
async function finishVote(client, guildId, serverId) {
  const data = readMaps();
  const slot = ensureServerSlot(data, guildId, serverId);
  const vote = slot.activeVote;
  if (!vote || vote.ended) return;

  vote.ended = true;

  const counts = vote.options.map((o) => ({
    ...o,
    votes: Object.values(vote.votes || {}).filter((x) => Number(x) === Number(o.slot)).length,
  }));

  counts.sort((a, b) => b.votes - a.votes || a.slot - b.slot);
  const winner = counts[0];
  if (!winner) return;

  if (!Array.isArray(slot.lastWinningMapIds)) slot.lastWinningMapIds = [];
  if (!slot.lastWinningMapIds.includes(winner.mapId)) slot.lastWinningMapIds.push(winner.mapId);

  if (slot.lastWinningMapIds.length > 3) {
    slot.lastWinningMapIds = slot.lastWinningMapIds.slice(-3);
  }

  slot.prioritised = [];

  writeMaps(data);

  try {
    const channel = await client.channels.fetch(vote.channelId).catch(() => null);
    if (!channel) return;

    await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: buildConcludedComponents(vote.roleId, getServerDisplay(serverId), winner),
    }).catch(() => {});
  } catch (e) {
    console.error("[mapvote] finishVote send error:", e);
  }

  try {
  if (vote.buttonMessageId) {
    const buttonMsg = await channel.messages.fetch(vote.buttonMessageId).catch(() => null);
    if (buttonMsg) {
      await buttonMsg.edit({ components: [] }).catch(() => {});
    }
  }
} catch {}
  slot.activeVote = null;
  writeMaps(data);
}

module.exports = {
  name: "mapvote",

  init(client) {
    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          const focused = interaction.options.getFocused(true);

          if (focused.name === "server") {
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
        }

        if (interaction.isButton()) {
          if (!interaction.customId.startsWith("mapvote:")) return;

          const [, voteId, slotStr] = interaction.customId.split(":");
          const chosenSlot = Number(slotStr);

          const data = readMaps();
          const guildSlot = data.servers[interaction.guildId] || {};
          let foundServerId = null;
          let vote = null;
          let serverSlot = null;

          for (const [serverId, s] of Object.entries(guildSlot)) {
            if (s?.activeVote?.id === voteId) {
              foundServerId = serverId;
              vote = s.activeVote;
              serverSlot = s;
              break;
            }
          }

          if (!vote || !serverSlot || !foundServerId) {
            return interaction.reply({ content: "This vote is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          if (Date.now() >= vote.endsAt) {
            await finishVote(client, interaction.guildId, foundServerId);
            return interaction.reply({ content: "This vote already ended.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          const current = vote.votes?.[interaction.user.id];
          if (Number(current) === chosenSlot) {
            return interaction.reply({ content: "You cant vote the same map twice!", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          if (!vote.votes) vote.votes = {};
vote.votes[interaction.user.id] = chosenSlot;
writeMaps(data);

await refreshVoteMessage(client, interaction.guildId, foundServerId);

return interaction.reply({
            content: current
              ? `Map ${chosenSlot} - Your vote has been changed.`
              : `Map ${chosenSlot} - Your vote has been recorded.`,
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "mapvote") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const sub = interaction.options.getSubcommand();
        if (sub !== "start") return;

        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner role only.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const duration = interaction.options.getInteger("duration", true);
        const channel = interaction.options.getChannel("channel", true);
        const role = interaction.options.getRole("role", true);

        if (!listServers().some((s) => s.identifier === serverId)) {
          return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        ) {
          return interaction.reply({ content: "Pick a text channel.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const data = readMaps();
        const slot = ensureServerSlot(data, interaction.guildId, serverId);

        if (slot.activeVote) {
          return interaction.reply({ content: "A map vote is already active for this server.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const allMaps = Array.isArray(slot.maps) ? slot.maps : [];
        if (allMaps.length < 4) {
          return interaction.reply({ content: "You need at least 4 maps saved for this server.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const prioritisedIds = Array.isArray(slot.prioritised) ? slot.prioritised : [];
        const prioritisedMaps = allMaps.filter((m) => prioritisedIds.includes(m.id));

        const bannedWinnerIds = Array.isArray(slot.lastWinningMapIds) ? slot.lastWinningMapIds : [];
        const normalPool = allMaps.filter((m) => !bannedWinnerIds.includes(m.id) && !prioritisedIds.includes(m.id));

        const picked = [];
        for (const m of prioritisedMaps) {
          if (picked.length < 4) picked.push(m);
        }

        const fill = shuffle(normalPool);
        for (const m of fill) {
          if (picked.length >= 4) break;
          if (!picked.find((x) => x.id === m.id)) picked.push(m);
        }

        if (picked.length < 4) {
          const fallback = shuffle(allMaps.filter((m) => !picked.find((x) => x.id === m.id)));
          for (const m of fallback) {
            if (picked.length >= 4) break;
            picked.push(m);
          }
        }

        if (picked.length < 4) {
          return interaction.reply({ content: "Not enough valid maps to build the vote.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const voteId = `${Date.now()}_${Math.floor(Math.random() * 999999)}`;
        const vote = {
          id: voteId,
          startedAt: Date.now(),
          endsAt: Date.now() + duration * 60 * 1000,
          channelId: channel.id,
          roleId: role.id,
          votes: {},
          options: picked.slice(0, 4).map((m, i) => ({
            slot: i + 1,
            mapId: m.id,
            imageUrl: m.imageUrl,
          })),
          ended: false,
        };

 const voteMessage = await channel.send({
  flags: MessageFlags.IsComponentsV2,
  components: buildVoteComponents(role.id, getServerDisplay(serverId), vote),
}).catch(() => null);

const buttonMessage = await channel.send({
  components: [buildVoteButtons(voteId)],
}).catch(() => null);

if (voteMessage) vote.messageId = voteMessage.id;
if (buttonMessage) vote.buttonMessageId = buttonMessage.id;

slot.activeVote = vote;
writeMaps(data);

        setTimeout(() => {
          finishVote(client, interaction.guildId, serverId).catch?.(() => {});
        }, duration * 60 * 1000);

        return interaction.reply({
          content: `Map vote started in ${channel}.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      } catch (e) {
        console.error("[mapvote] error:", e);
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }).catch(() => {});
          } else {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        }
      }
    });
  },
};