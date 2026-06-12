// modules/clanstaff.js
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
} = require("discord.js");

const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");
const CLANS_PATH = path.join(__dirname, "..", "data", "clans.json");

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

function readClans() {
  return readJsonSafe(CLANS_PATH, {});
}
function writeClans(data) {
  writeJsonSafe(CLANS_PATH, data);
}

function getAllGuildClans(all, guildId) {
  return all?.[guildId] || {};
}

function isStaff(interaction) {
  const r = readRoles();
  const cache = interaction.member?.roles?.cache;

  const hasOwnerRole = r.ownerRoleId && cache?.has(r.ownerRoleId);
  const hasAdminRole = r.adminRoleId && cache?.has(r.adminRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

  return Boolean(hasOwnerRole || hasAdminRole || hasDiscordAdmin);
}

function isOwner(interaction) {
  const r = readRoles();
  const cache = interaction.member?.roles?.cache;

  const hasOwnerRole = r.ownerRoleId && cache?.has(r.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

  return Boolean(hasOwnerRole || hasDiscordAdmin);
}

function makeEmbed(color, lines) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(lines.join("\n"));
}

function findClanByRoleId(all, guildId, roleId) {
  const g = all?.[guildId];
  if (!g) return null;

  for (const [serverId, serverMap] of Object.entries(g)) {
    if (serverMap?.[roleId]) {
      return { serverId, clan: serverMap[roleId] };
    }
  }
  return null;
}

function memberAlreadyInAnyClan(serverMap, userId) {
  if (!serverMap) return false;
  return Object.values(serverMap).some((c) => Array.isArray(c?.members) && c.members.includes(userId));
}

function removeMemberFromClan(clan, userId) {
  if (!Array.isArray(clan.members)) clan.members = [];
  clan.members = clan.members.filter((id) => id !== userId);
  // leader safety (don’t auto change leader here)
  return clan;
}

async function safeDeleteChannel(guild, channelId) {
  if (!channelId) return;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return;
  await ch.delete().catch(() => {});
}

async function safeDeleteRole(guild, roleId) {
  if (!roleId) return;
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return;
  await role.delete().catch(() => {});
}

module.exports = {
  name: "clanstaff",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "clan") return;

        const sub = interaction.options.getSubcommand();

        // ---------- /clan force-add ----------
        if (sub === "force-add") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isStaff(interaction)) {
            return interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
          }

          const user = interaction.options.getUser("user", true);
          const clanRole = interaction.options.getRole("clan", true);

          const all = readClans();
          const found = findClanByRoleId(all, interaction.guildId, clanRole.id);
          if (!found) {
            return interaction.reply({ content: "That role is not a registered clan.", flags: MessageFlags.Ephemeral });
          }

          const { serverId, clan } = found;

          // must not already be in a clan on THIS server
          const serverMap = all?.[interaction.guildId]?.[serverId] || {};
          if (memberAlreadyInAnyClan(serverMap, user.id)) {
            return interaction.reply({ content: "User is already in a clan on this server.", flags: MessageFlags.Ephemeral });
          }

          // add discord role
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (!member) {
            return interaction.reply({ content: "User not found in this server.", flags: MessageFlags.Ephemeral });
          }
          await member.roles.add(clanRole.id).catch(() => {});

          // update clans.json
          if (!Array.isArray(clan.members)) clan.members = [];
          if (!clan.members.includes(user.id)) clan.members.push(user.id);
          all[interaction.guildId][serverId][clanRole.id] = clan;
          writeClans(all);

          const color = clan?.colorKey ? undefined : 0x57f287;
          return interaction.reply({
            embeds: [
              makeEmbed(0x57f287, [
                "**Clan Force Add**",
                `> :white_check_mark: Added <@${user.id}> to <@&${clanRole.id}>`,
                `- **Clan:** ${clan.name}`,
                `- **Server:** ${clan.serverDisplay || serverId}`,
              ]),
            ],
          });
        }

        // ---------- /clan force-remove ----------
        if (sub === "force-remove") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isStaff(interaction)) {
            return interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
          }

          const user = interaction.options.getUser("user", true);
          const clanRole = interaction.options.getRole("clan", true);

          const all = readClans();
          const found = findClanByRoleId(all, interaction.guildId, clanRole.id);
          if (!found) {
            return interaction.reply({ content: "That role is not a registered clan.", flags: MessageFlags.Ephemeral });
          }

          const { serverId, clan } = found;

          // remove discord role
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (member) await member.roles.remove(clanRole.id).catch(() => {});

          // update clans.json
          removeMemberFromClan(clan, user.id);
          all[interaction.guildId][serverId][clanRole.id] = clan;
          writeClans(all);

          return interaction.reply({
            embeds: [
              makeEmbed(0xed4245, [
                "**Clan Force Remove**",
                `> :white_check_mark: Removed <@${user.id}> from <@&${clanRole.id}>`,
                `- **Clan:** ${clan.name}`,
                `- **Server:** ${clan.serverDisplay || serverId}`,
              ]),
            ],
          });
        }

        // ---------- /clan remove ----------
        if (sub === "remove") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isStaff(interaction)) {
            return interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
          }

          const clanRole = interaction.options.getRole("clan", true);

          const all = readClans();
          const found = findClanByRoleId(all, interaction.guildId, clanRole.id);
          if (!found) {
            return interaction.reply({ content: "That role is not a registered clan.", flags: MessageFlags.Ephemeral });
          }

          const { serverId, clan } = found;

          // best-effort: remove role from members
          if (Array.isArray(clan.members) && clan.members.length) {
            for (const uid of clan.members) {
              const m = await interaction.guild.members.fetch(uid).catch(() => null);
              if (m) await m.roles.remove(clanRole.id).catch(() => {});
            }
          }

          // delete channel + role
          await safeDeleteChannel(interaction.guild, clan.channelId);
          await safeDeleteRole(interaction.guild, clan.roleId);

          // delete from json
          delete all[interaction.guildId]?.[serverId]?.[clanRole.id];
          writeClans(all);

          return interaction.reply({
            embeds: [
              makeEmbed(0xed4245, [
                "**Clan Removed**",
                `> :white_check_mark: Removed <@&${clanRole.id}>`,
                `- **Clan:** ${clan.name}`,
                `- **Server:** ${clan.serverDisplay || serverId}`,
              ]),
            ],
          });
        }

        // ---------- /clan wipe (OWNER ONLY + confirm buttons) ----------
        if (sub === "wipe") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`clanwipe_yes:${interaction.id}`)
              .setLabel("Confirm Wipe")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`clanwipe_no:${interaction.id}`)
              .setLabel("Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          return interaction.reply({
            embeds: [
              makeEmbed(0xed4245, [
                "**Clan Wipe**",
                `> :warning: This will delete **ALL clans** in this Discord`,
                `- Deletes clan roles`,
                `- Deletes clan channels`,
                `- Clears clans.json`,
                "",
                "**Are you sure?**",
              ]),
            ],
            components: [row],
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        console.error("[clanstaff] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });

    // wipe confirm buttons
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isButton()) return;

        if (!interaction.customId.startsWith("clanwipe_yes:") && !interaction.customId.startsWith("clanwipe_no:")) return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }
        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
        }

        const wantedId = interaction.customId.split(":")[1];
        // only the person who ran /clan wipe can confirm/cancel
        if (wantedId !== interaction.message.interaction?.id) {
          return interaction.reply({ content: "This confirmation isn’t yours.", flags: MessageFlags.Ephemeral });
        }

        // cancel
        if (interaction.customId.startsWith("clanwipe_no:")) {
          return interaction.update({
            content: "Cancelled.",
            embeds: [],
            components: [],
          });
        }

        // confirm wipe
        const all = readClans();
        const guildClans = getAllGuildClans(all, interaction.guildId);

        // delete every clan role/channel we know about
        for (const serverMap of Object.values(guildClans || {})) {
          for (const clan of Object.values(serverMap || {})) {
            await safeDeleteChannel(interaction.guild, clan.channelId);
            await safeDeleteRole(interaction.guild, clan.roleId);
          }
        }

        // clear json for this guild
        all[interaction.guildId] = {};
        writeClans(all);

        return interaction.update({
          embeds: [
            makeEmbed(0x57f287, [
              "**Clan Wipe Complete**",
              `> :white_check_mark: All clans have been wiped`,
            ]),
          ],
          components: [],
        });
      } catch (e) {
        console.error("[clanstaff wipe] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};