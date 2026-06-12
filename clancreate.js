// modules/clancreate.js  (UPDATED: code is collected via modal + milestone refresh emit)
const fs = require("fs");
const path = require("path");

const {
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { listServers, getServer } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const CLANS_CFG_PATH = path.join(__dirname, "clans_config.json");
const CLANS_PATH = path.join(__dirname, "clans.json");
const REQ_PATH = path.join(__dirname, "clan_requests.json");

const pendingCreate = new Map(); // userId -> { serverId, clanName, tag, colorKey, originChannelId, createdAt }
const pendingEdit = new Map(); // userId -> { serverId, createdAt }

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

function readRoles() {
  return readJsonSafe(ROLES_PATH, { consoleRoleId: null, adminRoleId: null, ownerRoleId: null });
}

function canApprove(interaction) {
  const r = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasAdminRole = r.adminRoleId && cache?.has(r.adminRoleId);
  const hasOwnerRole = r.ownerRoleId && cache?.has(r.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasAdminRole || hasDiscordAdmin);
}

function resolveDisplayName(serverId) {
  const s = getServer(serverId);
  return (s?.displayName || s?.identifier || serverId).trim();
}

function getClansCfg(guildId, serverId) {
  const cfgAll = readJsonSafe(CLANS_CFG_PATH, {});
  return cfgAll?.[guildId]?.[serverId] || null;
}

function readClans() {
  return readJsonSafe(CLANS_PATH, {});
}
function writeClans(data) {
  writeJsonSafe(CLANS_PATH, data);
}

function readReqs() {
  return readJsonSafe(REQ_PATH, {});
}
function writeReqs(data) {
  writeJsonSafe(REQ_PATH, data);
}

function ensureGuildServer(obj, guildId, serverId) {
  if (!obj[guildId]) obj[guildId] = {};
  if (!obj[guildId][serverId]) obj[guildId][serverId] = {};
  return obj[guildId][serverId];
}

function sanitizeNameForChannel(name) {
  return (
    String(name || "clan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 90) || "clan"
  );
}

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

function niceColorName(key) {
  return String(key || "").charAt(0) + String(key || "").slice(1).toLowerCase();
}

function makePublicCreatedEmbed({ userId, clanName, tag, colorKey, serverDisplay, channelId, clanRoleId, createdAt }) {
  const color = ROLE_COLORS[colorKey] ?? 0x57f287;

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `### :white_check_mark: Clan created successfully`,
        `Your clan **${clanName}** [${tag}] has been created!`,
        `Members can join via \`/clan join\``,
      ].join("\n")
    )
    .addFields(
      { name: "Clan Channel", value: `<#${channelId}>`, inline: true },
      { name: "Clan Role", value: `<@&${clanRoleId}>`, inline: true },
      { name: "Server", value: `${serverDisplay}`, inline: true }
    )
    .setTimestamp(createdAt);
  }

function makeTeamWelcomeEmbed({ colorKey, clanRoleId, leaderId, clanName, tag, createdAt }) {
  const color = ROLE_COLORS[colorKey] ?? 0xffffff;
  const ts = Math.floor(createdAt / 1000);

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        `## :tada: Welcome to ${clanName}`,
        `This is your clan's private channel. Here are some commands to get started:`,
        `### :clipboard: Management Commands`,
        `• \`/clan kick\` - Remove members`,
        `• \`/clan edit\` - Edit clan details`,
        `• \`/clan transfer\` - Transfer clan ownership`,
        `• \`/clan disband\` - Disband the clan`,
        `### :link: Member Commands`,
        `• \`/clan leave\``,
        `### :bulb: Useful Tips`,
        `• Get your clan in fast to redeem leader kits`,
        `• Add our roster bot to automatically add your team into the clan`,
        `• Keep your clan active to avoid auto-deletion`,
      ].join("\n")
    )
    .addFields(
      { name: "Clan Tag", value: `\`${tag}\``, inline: true },
      { name: "Owner", value: `<@${leaderId}>`, inline: true },
      { name: "Created", value: `<t:${ts}:R>`, inline: true }
    )
    .setTimestamp(createdAt);
}

function makeRequestEmbed({ userId, clanName, tag, colorKey, serverDisplay }) {
  const color = ROLE_COLORS[colorKey] ?? 0x57f287;
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
      [
        "**Clan Create Request**",
        `> Requested by <@${userId}>`,
        `- **Server:** ${serverDisplay}`,
        `- **Name:** ${clanName}`,
        `- **Tag:** ${tag}`,
        `- **Colour:** ${niceColorName(colorKey)}`,
        `- **Code:** *(Hidden)*`,
      ].join("\n")
    );
}

function requestButtons(reqId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`clanreq_accept|${reqId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`clanreq_decline|${reqId}`).setLabel("Decline").setStyle(ButtonStyle.Danger)
    ),
  ];
}

function makeCodeModal() {
  const modal = new ModalBuilder().setCustomId("clan_create_code_modal").setTitle("Clan Join Code");

  const code = new TextInputBuilder()
    .setCustomId("code")
    .setLabel("Enter a private clan join code")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(code));
  return modal;
}

function makeEditClanModal({ clanName, tag }) {
  const modal = new ModalBuilder()
    .setCustomId("clan_edit_modal")
    .setTitle("Edit Clan");

  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Clan name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(clanName || "").slice(0, 100));

  const tagInput = new TextInputBuilder()
    .setCustomId("tag")
    .setLabel("Clan tag (1-5 letters/numbers)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(5)
    .setValue(String(tag || "").slice(0, 5));

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(tagInput)
  );

  return modal;
}

function getLeaderClanRecord(guildId, serverId, leaderId) {
  const clansAll = readClans();
  const serverObj = clansAll?.[guildId]?.[serverId];
  if (!serverObj) return null;

  for (const [roleId, clan] of Object.entries(serverObj)) {
    if (clan?.leaderId === leaderId) {
      return { clansAll, serverObj, roleId, clan };
    }
  }

  return null;
}

const MAX_CLANS_PER_CATEGORY = 50;

function getClanCategoryBaseName(serverDisplay) {
  return `${serverDisplay} Clans`.slice(0, 90);
}

function getClanCategoryName(serverDisplay, index) {
  const base = getClanCategoryBaseName(serverDisplay);
  return index <= 1 ? base : `${base} [${index}]`.slice(0, 100);
}

function parseClanCategoryIndex(name, serverDisplay) {
  const base = getClanCategoryBaseName(serverDisplay);
  if (name === base) return 1;

  const match = name.match(/^(.+?) \[(\d+)\]$/);
  if (!match) return null;
  if (match[1] !== base) return null;

  return Number(match[2]) || null;
}

function getClanCategories(guild, serverDisplay) {
  return guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .map((c) => ({
      channel: c,
      index: parseClanCategoryIndex(c.name, serverDisplay),
    }))
    .filter((x) => x.index !== null)
    .sort((a, b) => a.index - b.index);
}

function countClanChannelsInCategory(guild, categoryId) {
  return guild.channels.cache.filter(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parentId === categoryId
  ).size;
}

async function ensureClansCategory(guild, serverDisplay) {
  const categories = getClanCategories(guild, serverDisplay);

  for (const entry of categories) {
    const used = countClanChannelsInCategory(guild, entry.channel.id);
    if (used < MAX_CLANS_PER_CATEGORY) {
      return entry.channel;
    }
  }

  const nextIndex = categories.length ? categories[categories.length - 1].index + 1 : 1;
  return guild.channels.create({
    name: getClanCategoryName(serverDisplay, nextIndex),
    type: ChannelType.GuildCategory,
  });
}

async function createClanObjects({ guild, serverId, serverDisplay, leaderMember, clanName, tag, colorKey, code }) {
  const color = ROLE_COLORS[colorKey] ?? 0x57f287;

  const createdAt = Date.now();

  const role = await guild.roles.create({
    name: clanName,
    color,
    mentionable: true,
    reason: `Clan created for ${serverDisplay}`,
  });

  await leaderMember.roles.add(role).catch(() => {});

  const category = await ensureClansCategory(guild, serverDisplay);

  const chanName = sanitizeNameForChannel(clanName);

  // ✅ allow adminRole + ownerRole to view clan channels
const r = readRoles();
const overwrites = [
  { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
  { id: role.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
];

if (r.adminRoleId && guild.roles.cache.has(r.adminRoleId)) {
  overwrites.push({
    id: r.adminRoleId,
    allow: ["ViewChannel", "ReadMessageHistory"],
  });
}

if (
  r.ownerRoleId &&
  r.ownerRoleId !== r.adminRoleId &&
  guild.roles.cache.has(r.ownerRoleId)
) {
  overwrites.push({
    id: r.ownerRoleId,
    allow: ["ViewChannel", "ReadMessageHistory"],
  });
}

  const channel = await guild.channels.create({
    name: chanName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    reason: `Clan channel for ${clanName}`,
  });

  await channel.send({
  content: `<@${leaderMember.id}>`,
  embeds: [
    makeTeamWelcomeEmbed({
      colorKey,
      clanRoleId: role.id,
      leaderId: leaderMember.id,
      clanName,
      tag,
      createdAt,
    }),
  ],
});

  const clansAll = readClans();
  const serverObj = ensureGuildServer(clansAll, guild.id, serverId);

  serverObj[role.id] = {
    serverId,
    serverDisplay,
    roleId: role.id,
    channelId: channel.id,
    leaderId: leaderMember.id,
    name: clanName,
    tag,
    colorKey,
    code,
    createdAt,
    members: [leaderMember.id],
  };

  writeClans(clansAll);

  return { role, channel };
}

function leaderAlreadyHasClan(guildId, serverId, leaderId) {
  const clansAll = readClans();
  const serverObj = clansAll?.[guildId]?.[serverId];
  if (!serverObj) return false;
  return Object.values(serverObj).some((c) => c?.leaderId === leaderId);
}

module.exports = {
  name: "clancreate",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // AUTOCOMPLETE (server)
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "clan") return;
          const sub = interaction.options.getSubcommand();
if (!["create", "edit"].includes(sub)) return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const servers = listServers();
          const q = String(focused.value || "").toLowerCase();

          const choices = servers
            .map((s) => ({ name: (s.displayName || s.identifier).slice(0, 100), value: s.identifier }))
            .filter((c) => c.name.toLowerCase().includes(q))
            .slice(0, 25);

          return interaction.respond(choices).catch(() => {});
        }

        // /clan create -> open modal for code
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "clan") return;
const sub = interaction.options.getSubcommand();

if (sub === "edit") {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
  }

  const serverId = interaction.options.getString("server", true);
  const exists = listServers().some((s) => s.identifier === serverId);
  if (!exists) {
    return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
  }

  const found = getLeaderClanRecord(interaction.guildId, serverId, interaction.user.id);
  if (!found) {
    return interaction.reply({
      content: "You do not own a clan on this server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  pendingEdit.set(interaction.user.id, {
    serverId,
    createdAt: Date.now(),
  });

  return interaction.showModal(
    makeEditClanModal({
      clanName: found.clan.name,
      tag: found.clan.tag,
    })
  );
}

if (sub !== "create") return;
          if (interaction.options.getSubcommand() !== "create") return;

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const clanName = interaction.options.getString("name", true).trim();
          const tagRaw = interaction.options.getString("tag", true).trim();
          const colorKey = interaction.options.getString("color", true);

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists) return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });

          const tag = tagRaw.toUpperCase();
if (!/^[A-Z0-9]{1,5}$/.test(tag)) {
  return interaction.reply({ content: "Tag must be 1-5 characters only.", flags: MessageFlags.Ephemeral });
}

          if (!ROLE_COLORS[colorKey]) {
            return interaction.reply({ content: "Invalid color.", flags: MessageFlags.Ephemeral });
          }

          if (leaderAlreadyHasClan(interaction.guildId, serverId, interaction.user.id)) {
            return interaction.reply({ content: "You already own a clan on this server.", flags: MessageFlags.Ephemeral });
          }

          const cfg = getClansCfg(interaction.guildId, serverId);
          if (!cfg || !cfg.type) {
            return interaction.reply({
              content: "Clans are not setup for this server. Use `/setup-clans` first.",
              flags: MessageFlags.Ephemeral,
            });
          }

          pendingCreate.set(interaction.user.id, {
            serverId,
            clanName,
            tag,
            colorKey,
            originChannelId: interaction.channelId,
            createdAt: Date.now(),
          });

          return interaction.showModal(makeCodeModal());
        }
if (interaction.isModalSubmit() && interaction.customId === "clan_edit_modal") {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
  }

  const pending = pendingEdit.get(interaction.user.id);
  if (!pending) {
    return interaction.reply({ content: "Edit request expired.", flags: MessageFlags.Ephemeral });
  }

  if (Date.now() - pending.createdAt > 120_000) {
    pendingEdit.delete(interaction.user.id);
    return interaction.reply({ content: "Edit request expired.", flags: MessageFlags.Ephemeral });
  }

  const newName = interaction.fields.getTextInputValue("name").trim();
  const newTag = interaction.fields.getTextInputValue("tag").trim().toUpperCase();

  if (!newName) {
    return interaction.reply({ content: "Clan name is required.", flags: MessageFlags.Ephemeral });
  }

  if (!/^[A-Z0-9]{1,5}$/.test(newTag)) {
    return interaction.reply({
      content: "Tag must be 1-5 letters or numbers only.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const found = getLeaderClanRecord(interaction.guildId, pending.serverId, interaction.user.id);
  pendingEdit.delete(interaction.user.id);

  if (!found) {
    return interaction.reply({
      content: "You do not own a clan on this server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const oldName = found.clan.name;

  const role = await interaction.guild.roles.fetch(found.clan.roleId).catch(() => null);
  const channel = await interaction.guild.channels.fetch(found.clan.channelId).catch(() => null);

  if (role) {
    await role.setName(newName, `Clan edited by ${interaction.user.tag}`).catch(() => {});
  }

  if (channel) {
    await channel.setName(sanitizeNameForChannel(newName), `Clan edited by ${interaction.user.tag}`).catch(() => {});
  }

  found.clan.name = newName;
  found.clan.tag = newTag;
  found.clan.updatedAt = Date.now();

  writeClans(found.clansAll);

  return interaction.reply({
    content: `Clan updated: **${oldName}** → **${newName}** [${newTag}]`,
    flags: MessageFlags.Ephemeral,
  });
}
        // modal submit -> run create / request
        if (interaction.isModalSubmit() && interaction.customId === "clan_create_code_modal") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          const pending = pendingCreate.get(interaction.user.id);
          if (!pending) return interaction.reply({ content: "Create request expired.", flags: MessageFlags.Ephemeral });

          if (Date.now() - pending.createdAt > 120_000) {
            pendingCreate.delete(interaction.user.id);
            return interaction.reply({ content: "Create request expired.", flags: MessageFlags.Ephemeral });
          }

          const code = interaction.fields.getTextInputValue("code").trim();
          if (!code) return interaction.reply({ content: "Code is required.", flags: MessageFlags.Ephemeral });

          const { serverId, clanName, tag, colorKey, originChannelId } = pending;
          pendingCreate.delete(interaction.user.id);

          const serverDisplay = resolveDisplayName(serverId);

          const cfg = getClansCfg(interaction.guildId, serverId);
          if (!cfg || !cfg.type) {
            return interaction.reply({
              content: "Clans are not setup for this server. Use `/setup-clans` first.",
              flags: MessageFlags.Ephemeral,
            });
          }

          // DEFAULT = instant
          if (cfg.type === "default") {
            const leaderMember = await interaction.guild.members.fetch(interaction.user.id);
            const { role, channel } = await createClanObjects({
              guild: interaction.guild,
              serverId,
              serverDisplay,
              leaderMember,
              clanName,
              tag,
              colorKey,
              code,
            });

            // ✅ milestone refresh so leader gets milestone roles immediately
            client.emit("clan:refreshMilestones", {
              guild: interaction.guild,
              guildId: interaction.guildId,
              serverId,
              clanRoleId: role.id,
            });

            await interaction.reply({
              embeds: [
                makePublicCreatedEmbed({
                  userId: interaction.user.id,
                  clanName,
                  tag,
                  colorKey,
                  serverDisplay,
                  channelId: channel.id,
                  clanRoleId: role.id,
                }),
              ],
            });
            return;
          }

          // ADVANCED = request
          if (cfg.type === "advanced") {
            if (!cfg.requestChannelId) {
              return interaction.reply({
                content: "Clan requests channel not set. Use `/setup-clanrequests` first.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const reqChannel = await interaction.guild.channels.fetch(cfg.requestChannelId).catch(() => null);
            if (!reqChannel) {
              return interaction.reply({
                content: "Clan requests channel is missing or I can't access it.",
                flags: MessageFlags.Ephemeral,
              });
            }

            const reqId = `${interaction.guildId}:${serverId}:${interaction.id}`;

            const reqs = readReqs();
            reqs[reqId] = {
              guildId: interaction.guildId,
              serverId,
              serverDisplay,
              userId: interaction.user.id,
              clanName,
              tag,
              colorKey,
              code,
              requestedAt: Date.now(),
              originChannelId,
            };
            writeReqs(reqs);

            const msg = await reqChannel.send({
              embeds: [makeRequestEmbed({ userId: interaction.user.id, clanName, tag, colorKey, serverDisplay })],
              components: requestButtons(reqId),
            });

            reqs[reqId].requestMessageId = msg.id;
            writeReqs(reqs);

            return interaction.reply({ content: "Clan request sent for approval.", flags: MessageFlags.Ephemeral });
          }

          return interaction.reply({ content: "Invalid clan setup type.", flags: MessageFlags.Ephemeral });
        }

        // Accept/Decline buttons
        if (interaction.isButton()) {
          const id = interaction.customId;
          if (!id.startsWith("clanreq_accept|") && !id.startsWith("clanreq_decline|")) return;

          if (!interaction.inGuild()) return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          if (!canApprove(interaction)) return interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });

          const reqId = id.slice(id.indexOf("|") + 1);
          const reqs = readReqs();
          const req = reqs[reqId];

          if (!req) return interaction.reply({ content: "Request expired.", flags: MessageFlags.Ephemeral });

          // decline
          if (id.startsWith("clanreq_decline|")) {
            delete reqs[reqId];
            writeReqs(reqs);
            await interaction.update({ content: "Declined.", embeds: interaction.message.embeds, components: [] });
            return;
          }

          // accept
          if (leaderAlreadyHasClan(req.guildId, req.serverId, req.userId)) {
            delete reqs[reqId];
            writeReqs(reqs);
            return interaction.update({
              content: "Declined (user already owns a clan).",
              embeds: interaction.message.embeds,
              components: [],
            });
          }

          const leaderMember = await interaction.guild.members.fetch(req.userId).catch(() => null);
          if (!leaderMember) {
            delete reqs[reqId];
            writeReqs(reqs);
            return interaction.update({
              content: "Declined (user not in server).",
              embeds: interaction.message.embeds,
              components: [],
            });
          }

          const { role, channel } = await createClanObjects({
            guild: interaction.guild,
            serverId: req.serverId,
            serverDisplay: req.serverDisplay,
            leaderMember,
            clanName: req.clanName,
            tag: req.tag,
            colorKey: req.colorKey,
            code: req.code,
          });

          // ✅ milestone refresh so leader gets milestone roles immediately
          client.emit("clan:refreshMilestones", {
            guild: interaction.guild,
            guildId: interaction.guildId,
            serverId: req.serverId,
            clanRoleId: role.id,
          });

          const origin = await interaction.guild.channels.fetch(req.originChannelId).catch(() => null);
          if (origin) {
            await origin.send({
              embeds: [
                makePublicCreatedEmbed({
                  userId: req.userId,
                  clanName: req.clanName,
                  tag: req.tag,
                  colorKey: req.colorKey,
                  serverDisplay: req.serverDisplay,
                  channelId: channel.id,
                  clanRoleId: role.id
                }),
              ],
            });
          }

          delete reqs[reqId];
          writeReqs(reqs);

          await interaction.update({ content: "Accepted.", embeds: interaction.message.embeds, components: [] });
          return;
        }
      } catch (e) {
        console.error("[clancreate] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};