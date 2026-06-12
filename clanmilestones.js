// modules/clanmilestones.js
const fs = require("fs");
const path = require("path");

const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");
const { listServers, getServer } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const CLANS_PATH = path.join(__dirname, "clans.json");
const MILESTONES_PATH = path.join(__dirname, "clan_milestones.json");

function log(...args) {
  console.log("[clanmilestones]", ...args);
}
function logErr(...args) {
  console.error("[clanmilestones]", ...args);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logErr("readJsonSafe failed:", file, e?.message || e);
    return fallback;
  }
}
function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    logErr("writeJsonSafe failed:", file, e?.message || e);
  }
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, { consoleRoleId: null, adminRoleId: null, ownerRoleId: null });
}

function isOwnerLike(interaction) {
  const r = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = r.ownerRoleId && cache?.has(r.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasDiscordAdmin);
}

function resolveDisplayName(serverId) {
  const s = getServer(serverId);
  return (s?.displayName || s?.identifier || serverId).trim();
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
function writeMilestones(data) {
  writeJsonSafe(MILESTONES_PATH, data);
}

function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function sortedMilestonesFor(mAll, guildId, serverId) {
  const list = mAll?.[guildId]?.[serverId]?.milestones;
  if (!Array.isArray(list)) return [];
  return [...list]
    .filter((m) => Number.isFinite(m?.members) && typeof m?.roleId === "string")
    .sort((a, b) => a.members - b.members);
}

function highestReachedMilestone(milestones, count) {
  let out = null;
  for (const m of milestones) {
    if (count >= m.members) out = m;
    else break;
  }
  return out;
}

function nextMilestone(milestones, count) {
  return milestones.find((m) => m.members > count) || null;
}

function buildAchievedEmbed({ achievedRoleId, next, away }) {
  const lines = [`🎉 **Clan milestone achieved!**`, ``, `You have earned <@&${achievedRoleId}>`, ``];

  if (next) {
    lines.push(`Next milestone at **${next.members}** members (**${away}** away)`);
  } else {
    lines.push(`🏆 **This is the final milestone!**`);
  }

  return new EmbedBuilder().setColor(0x95a5a6).setDescription(lines.join("\n")).setTimestamp(new Date());
}

/* ================= CORE LOGIC ================= */

/**
 * Applies milestone roles to CURRENT clan-role members using live data.
 * Also announces ONLY when a NEW highest milestone is reached vs lastAppliedMilestoneMembers.
 */
async function applyMilestonesForClan({ guild, serverId, clanRoleId, reason = "unknown" }) {
  const allClans = readClans();
  const serverMap = allClans?.[guild.id]?.[serverId];
  const clan = serverMap?.[clanRoleId];

  if (!clan) {
    log("apply: clan not found in json", { guildId: guild.id, serverId, clanRoleId, reason });
    return;
  }

  const mAll = readMilestones();
  const milestones = sortedMilestonesFor(mAll, guild.id, serverId);

  if (!milestones.length) {
    log("apply: no milestones configured", { guildId: guild.id, serverId, clanRoleId, reason });
    return;
  }

  const clanRole = await guild.roles.fetch(clanRoleId).catch(() => null);
  if (!clanRole) {
    log("apply: clan role missing", { guildId: guild.id, serverId, clanRoleId, reason });
    return;
  }

  const members = [...clanRole.members.values()];
  const count = members.length;

  // sync members list back to json (optional but keeps data sane)
  clan.members = members.map((m) => m.id);
  serverMap[clanRoleId] = clan;
  allClans[guild.id] = allClans[guild.id] || {};
  allClans[guild.id][serverId] = serverMap;
  writeClans(allClans);

  const achieved = highestReachedMilestone(milestones, count);
  const lastApplied = Number(clan.lastAppliedMilestoneMembers || 0);

  log("apply: start", {
    guildId: guild.id,
    serverId,
    clanRoleId,
    count,
    achievedMembers: achieved?.members ?? null,
    lastApplied,
    reason,
  });

  // apply/remove roles based on count
  for (const m of milestones) {
    const milestoneRole = await guild.roles.fetch(m.roleId).catch(() => null);
    if (!milestoneRole) {
      log("apply: milestone role missing (skip)", { roleId: m.roleId, members: m.members });
      continue;
    }

    const reached = count >= m.members;

    for (const member of members) {
      if (reached) {
        if (!member.roles.cache.has(m.roleId)) {
          await member.roles.add(m.roleId).catch((e) => {
            logErr("role add failed", {
              userId: member.id,
              roleId: m.roleId,
              clanRoleId,
              serverId,
              err: e?.message || e,
            });
          });
        }
      } else {
        if (member.roles.cache.has(m.roleId)) {
          await member.roles.remove(m.roleId).catch((e) => {
            logErr("role remove failed", {
              userId: member.id,
              roleId: m.roleId,
              clanRoleId,
              serverId,
              err: e?.message || e,
            });
          });
        }
      }
    }
  }

  // announce ONLY when we cross into a higher milestone than before
  if (achieved && achieved.members > lastApplied) {
    const next = nextMilestone(milestones, count);
    const away = next ? next.members - count : 0;

    const clanChannelId = clan.channelId;
    const clanChannel = clanChannelId ? await guild.channels.fetch(clanChannelId).catch(() => null) : null;

    if (clanChannel && clanChannel.isTextBased()) {
      await clanChannel
        .send({
          embeds: [buildAchievedEmbed({ achievedRoleId: achieved.roleId, next, away })],
        })
        .catch((e) => logErr("announce send failed", e?.message || e));
    } else {
      log("announce skipped: clan channel missing/not text", { clanChannelId });
    }

    // store last applied milestone so we don't spam
    clan.lastAppliedMilestoneMembers = achieved.members;
    serverMap[clanRoleId] = clan;
    allClans[guild.id][serverId] = serverMap;
    writeClans(allClans);

    log("apply: announced new milestone", {
      guildId: guild.id,
      serverId,
      clanRoleId,
      achievedMembers: achieved.members,
      achievedRoleId: achieved.roleId,
    });
  }

  log("apply: done", { guildId: guild.id, serverId, clanRoleId, count, reason });
}

/**
 * Removes ALL milestone roles from members of the clan role.
 * Call this before deleting the clan role if you want guaranteed cleanup.
 */
async function removeAllMilestoneRoles({ guild, serverId, clanRoleId, reason = "deleted" }) {
  const mAll = readMilestones();
  const milestones = sortedMilestonesFor(mAll, guild.id, serverId);
  if (!milestones.length) {
    log("cleanup: no milestones", { guildId: guild.id, serverId, clanRoleId, reason });
    return;
  }

  const clanRole = await guild.roles.fetch(clanRoleId).catch(() => null);
  if (!clanRole) {
    log("cleanup: clan role missing (nothing to remove)", { guildId: guild.id, serverId, clanRoleId, reason });
    return;
  }

  const members = [...clanRole.members.values()];
  log("cleanup: start", { guildId: guild.id, serverId, clanRoleId, members: members.length, reason });

  for (const member of members) {
    for (const m of milestones) {
      if (member.roles.cache.has(m.roleId)) {
        await member.roles.remove(m.roleId).catch((e) => {
          logErr("cleanup role remove failed", {
            userId: member.id,
            roleId: m.roleId,
            clanRoleId,
            serverId,
            err: e?.message || e,
          });
        });
      }
    }
  }

  log("cleanup: done", { guildId: guild.id, serverId, clanRoleId, reason });
}

/* ================= MODULE ================= */

module.exports = {
  name: "clanmilestones",

  init(client) {


    // Allow other modules to force-apply milestones immediately
    client.on("clan:refreshMilestones", async (payload) => {
      try {
        const { guild, serverId, clanRoleId, reason } = payload || {};
        if (!guild || !serverId || !clanRoleId) return;
        await applyMilestonesForClan({ guild, serverId, clanRoleId, reason: reason || "event" });
      } catch (e) {
        logErr("refresh error:", e?.message || e);
      }
    });

    // Cleanup hook (you must emit this BEFORE deleting the clan role for best results)
    client.on("clan:deleted", async (payload) => {
      try {
        const { guild, serverId, clanRoleId, reason } = payload || {};
        if (!guild || !serverId || !clanRoleId) return;
        await removeAllMilestoneRoles({ guild, serverId, clanRoleId, reason: reason || "deleted" });
      } catch (e) {
        logErr("deleted cleanup error:", e?.message || e);
      }
    });

    // ✅ AUTOCOMPLETE for /clan add-milestone and /clan wipe-milestones
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "clan") return;

        const sub = interaction.options.getSubcommand();
        if (sub !== "add-milestone" && sub !== "wipe-milestones") return;

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
      } catch {}
    });

    // Commands
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "clan") return;

        const sub = interaction.options.getSubcommand();

        // /clan add-milestone
        if (sub === "add-milestone") {
          if (!interaction.inGuild())
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });

          if (!isOwnerLike(interaction))
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });

          const serverId = interaction.options.getString("server", true);
          const members = interaction.options.getInteger("members", true);
          const role = interaction.options.getRole("role", true);

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists)
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });

          const mAll = readMilestones();
          const obj = ensure(mAll, interaction.guildId, serverId);
          if (!Array.isArray(obj.milestones)) obj.milestones = [];

          const entry = { members, roleId: role.id, setAt: Date.now(), setBy: interaction.user.id };
          const idx = obj.milestones.findIndex((m) => m.members === members);

          if (idx !== -1) obj.milestones[idx] = entry;
          else obj.milestones.push(entry);

          obj.milestones.sort((a, b) => a.members - b.members);
          writeMilestones(mAll);

          log("milestone added", { guildId: interaction.guildId, serverId, members, roleId: role.id });

          const display = resolveDisplayName(serverId);

          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x95a5a6)
                .setDescription(
                  [`**Milestone Added**`, `> Server: **${display}**`, `- Members: **${members}**`, `- Role: <@&${role.id}>`].join(
                    "\n"
                  )
                ),
            ],
            flags: MessageFlags.Ephemeral,
          });

          // apply immediately across all clans on that server
          const allClans = readClans();
          const serverMap = allClans?.[interaction.guildId]?.[serverId];
          if (serverMap) {
            for (const clanRoleId of Object.keys(serverMap)) {
              await applyMilestonesForClan({
                guild: interaction.guild,
                serverId,
                clanRoleId,
                reason: "add-milestone",
              });
            }
          }

          return;
        }

        // /clan wipe-milestones
        if (sub === "wipe-milestones") {
          if (!interaction.inGuild())
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });

          if (!isOwnerLike(interaction))
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });

          const serverId = interaction.options.getString("server", true);

          const exists = listServers().some((s) => s.identifier === serverId);
          if (!exists)
            return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });

          const mAll = readMilestones();
          if (mAll?.[interaction.guildId]?.[serverId]) {
            delete mAll[interaction.guildId][serverId];
            writeMilestones(mAll);
          }

          log("milestones wiped", { guildId: interaction.guildId, serverId });

          const display = resolveDisplayName(serverId);

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x95a5a6)
                .setDescription([`**Milestones Wiped**`, `> Server: **${display}**`].join("\n")),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        logErr("interaction error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};