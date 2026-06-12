const fs = require("fs");
const path = require("path");

const { ContainerBuilder, MessageFlags, EmbedBuilder } = require("discord.js");

const { listServers, getServer } = require("../rce");
const { sendConfiguredLog } = require("./rcelogs");

const KITS_CFG_PATH = path.join(__dirname, "..", "data", "kits_config.json");
const COOLDOWNS_PATH = path.join(__dirname, "..", "data", "kits_cooldowns.json");
const BOT_STATS_PATH = path.join(__dirname, "..", "data", "bot_stats.json");
const { readLinks } = require("../shared/links");
const LINK_FILES = [
  path.join(__dirname, "..", "data", "linking.json"),
  path.join(__dirname, "..", "data", "linked.json"),
  path.join(__dirname, "..", "data", "accounts.json"),
];

function log(...a) {
  console.log("[kitsclaim]", ...a);
}
function logErr(...a) {
  console.error("[kitsclaim]", ...a);
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

function incrementKitsClaimed() {
  const data = readJsonSafe(BOT_STATS_PATH, {
    kitsClaimed: 0,
    players: {},
    updatedAt: 0,
  });

  data.kitsClaimed = Number(data.kitsClaimed || 0) + 1;
  data.updatedAt = Date.now();

  writeJsonSafe(BOT_STATS_PATH, data);
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function safeName(s, max = 64) {
  return String(s || "").trim().slice(0, max) || "Unknown";
}

function readKitsCfg() {
  return readJsonSafe(KITS_CFG_PATH, {});
}
function getKitsForServer(guildId, serverId) {
  const all = readKitsCfg();
  const kits = all?.[guildId]?.[serverId]?.kits;
  return Array.isArray(kits) ? kits : [];
}

function readCooldowns() {
  return readJsonSafe(COOLDOWNS_PATH, {});
}
function writeCooldowns(data) {
  writeJsonSafe(COOLDOWNS_PATH, data);
}
function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function kitKeyFromCfgEntry(k) {
  return norm(k?.name || k?.ingameKit || "");
}

function userHasKitAccess(member, kitCfg) {
  const roleId = kitCfg?.roleId;
  if (!roleId) return true;
  return Boolean(member?.roles?.cache?.has(roleId));
}

function extractLinkedPlayerName(guildId, userId) {
  // FIRST: shared global-data
  const shared = readLinks();
  const directGuild = shared?.[guildId]?.[userId];
  const direct = shared?.[userId];
  const sharedCandidates = [directGuild, direct].filter(Boolean);

  for (const c of sharedCandidates) {
    if (typeof c === "string") return c;
    if (typeof c?.gamertag === "string") return c.gamertag;
    if (typeof c?.gt === "string") return c.gt;
    if (typeof c?.xbox === "string") return c.xbox;
    if (typeof c?.playerName === "string") return c.playerName;
    if (typeof c?.player === "string") return c.player;
    if (typeof c?.name === "string") return c.name;
  }

  // FALLBACK: old files
  for (const file of LINK_FILES) {
    if (!fs.existsSync(file)) continue;

    const data = readJsonSafe(file, {});
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
  }

  return null;
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function isKitGiveSuccess(resp) {
  const s = String(resp || "").toLowerCase();
  if (s.includes("[kitmanager]") && s.includes("successfully gave")) return true;
  if (s.includes("[servervar]") && s.includes("server giving") && s.includes(" kit ")) return true;
  return false;
}

function isUnknownPlayer(resp) {
  const s = String(resp || "").toLowerCase();
  if (s.includes("unknown player")) return true;
  if (s.includes("cannot give") && s.includes("unknown")) return true;
  return false;
}

function formatCooldown(msLeft) {
  msLeft = Math.max(0, Number(msLeft) || 0);

  const totalSeconds = Math.ceil(msLeft / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    const dec = Math.round((totalSeconds / 3600) * 10) / 10;
    return `${dec} Hours`;
  }
  if (m > 0) return `${m}m`;
  return `${s} seconds`;
}

function resolveServerDisplay(serverId) {
  try {
    const s = typeof getServer === "function" ? getServer(serverId) : null;
    return (s?.displayName || s?.identifier || serverId || "Unknown").toString().trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

function buildKitClaimLogEmbed({
  interaction,
  serverDisplay,
  playerName,
  kitDisplay,
  success,
  reason,
}) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Kit Claim Log")
    .addFields(
      { name: "Status", value: success ? "✅ Success" : "❌ Failed", inline: true },
      { name: "Reason", value: safeName(reason || (success ? "Claim successful" : "Claim failed"), 200), inline: true },
      { name: "User", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Gamertag", value: `\`${safeName(playerName || "Unknown", 100)}\``, inline: true },
      { name: "Kit", value: `\`${safeName(kitDisplay || "Unknown", 100)}\``, inline: true },
      { name: "Server", value: `\`${safeName(serverDisplay || "Unknown", 100)}\``, inline: true }
    )
    .setTimestamp();
}

async function sendKitLog(client, interaction, serverId, { playerName, kitDisplay, success, reason }) {
  const serverDisplay = resolveServerDisplay(serverId);
  await sendConfiguredLog(client, interaction.guildId, serverId, "kits", {
    embeds: [
      buildKitClaimLogEmbed({
        interaction,
        serverDisplay,
        playerName,
        kitDisplay,
        success,
        reason,
      }),
    ],
  });
}

function kitsPrefix() {
  return "<color=red><b>[KITS]</color>";
}
function chatSuccess(playerName, kitDisplayName) {
  return `say ${kitsPrefix()} ${playerName}! You have successfully claimed <color=red>${kitDisplayName},</color>.`;
}
function chatCooldown(playerName, kitDisplayName, msLeft) {
  const nice = formatCooldown(msLeft);
  return `say ${kitsPrefix()} ${playerName}! You have already claimed <color=red>${kitDisplayName},</color> you can claim it again in ${nice}.`;
}

function v2Card({ accent, titleLine, bodyLines = [], footerLine = "", extraFooterSeparator = false }) {
  const c = new ContainerBuilder().setAccentColor(accent);

  c.addTextDisplayComponents((t) => t.setContent(`### ${titleLine}`));
  c.addSeparatorComponents((s) => s);
  c.addTextDisplayComponents((t) => t.setContent(bodyLines.join("\n")));

  if (footerLine) {
    c.addSeparatorComponents((s) => s);
    c.addTextDisplayComponents((t) => t.setContent(footerLine));
    if (extraFooterSeparator) c.addSeparatorComponents((s) => s);
  }

  return c;
}

function v2Success({ username, kitDisplay, accountName, serverDisplay }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "✅ Kit Claimed",
    bodyLines: [
      `**${safeName(username, 64)}** your kit has been sent successfully.`,
      "",
      `• Kit: **${safeName(kitDisplay, 100)}**`,
      `• Account: **${safeName(accountName, 64)}**`,
      `• Server: **${safeName(serverDisplay, 100)}**`,
    ],
    footerLine: "You can claim again once your cooldown expires.",
  });
}

function v2NotLinked({ username }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "❌ Access Denied",
    bodyLines: [
      `**${safeName(username, 64)}** you can’t claim kits right now.`,
      "",
      "• Your Discord is not linked to an in-game account.",
      "• Use the Account Linking panel to link first.",
      "If you think this is wrong, contact staff.",
    ],
  });
}

function v2MissingRole({ username, kitDisplay, roleId }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "❌ Access Denied",
    bodyLines: [
      `**${safeName(username, 64)}** you can’t claim this kit right now.`,
      "",
      `• Kit: **${safeName(kitDisplay, 100)}**`,
      roleId ? `• Required role: <@&${roleId}>` : "• Missing required role.",
      "If you think this is wrong, contact staff.",
    ],
  });
}

function v2Cooldown({ username, kitDisplay, nextAtMs }) {
  const unix = Math.floor(nextAtMs / 1000);
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "⏳ Cooldown Active",
    bodyLines: [
      `**${safeName(username, 64)}** you’ve already claimed this kit.`,
      "",
      `• Kit: **${safeName(kitDisplay, 100)}**`,
      `• Available: <t:${unix}:R>`,
      "Try again when the timer is up.",
    ],
  });
}

function v2PlayerOffline({ username, accountName }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "❌ Player Not Online",
    bodyLines: [
      `**${safeName(username, 64)}** I couldn’t find you in-game.`,
      "",
      `• Account: **${safeName(accountName, 64)}**`,
      "• Join the server and try again.",
      "• No cooldown was used.",
    ],
  });
}

function v2KitNotFound({ username, input }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "❌ Kit Not Found",
    bodyLines: [
      `**${safeName(username, 64)}** that kit isn’t configured.`,
      "",
      `• Input: **${safeName(input, 100)}**`,
      "• Check spelling or ask staff to add it in kits-config.",
    ],
  });
}

function v2ServerNotFound({ username, serverId }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "❌ Server Not Found",
    bodyLines: [
      `**${safeName(username, 64)}** I couldn’t find that server.`,
      "",
      `• Server: **${safeName(serverId, 100)}**`,
    ],
  });
}

function v2GiveFailed({ username }) {
  return v2Card({
    accent: 0x95a5a6,
    titleLine: "❌ Claim Failed",
    bodyLines: [
      `**${safeName(username, 64)}** I couldn’t confirm the kit was delivered.`,
      "",
      "• Try again in a moment.",
      "• If it keeps failing, staff should check KITMANAGER logs.",
      "• No cooldown was used.",
    ],
  });
}

async function replyV2(interaction, container) {
  await interaction.editReply({
    content: "",
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  }).catch(() => {});
}

module.exports = {
  name: "kitsclaim",

  init(client, rce) {


    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "kits") return;
          const sub = interaction.options.getSubcommand(false);
          if (sub !== "claim") return;

          const focused = interaction.options.getFocused(true);

          if (focused.name === "server") {
            const q = norm(focused.value);
            const servers = listServers();

            const choices = servers
              .map((s) => ({
                name: (s.displayName || s.identifier).slice(0, 100),
                value: s.identifier,
              }))
              .filter((c) => c.name.toLowerCase().includes(q))
              .slice(0, 25);

            await interaction.respond(choices).catch(() => {});
            return;
          }

          if (focused.name === "kit") {
            const serverId = interaction.options.getString("server", false);
            if (!serverId) {
              await interaction.respond([]).catch(() => {});
              return;
            }

            const kits = getKitsForServer(interaction.guildId, serverId);
            const member = interaction.member;
            const q = norm(focused.value);

            const allowed = kits
              .filter((k) => userHasKitAccess(member, k))
              .map((k) => String(k?.name || k?.ingameKit || "").trim())
              .filter(Boolean);

            const unique = [...new Set(allowed)];

            const choices = unique
              .filter((name) => norm(name).includes(q))
              .slice(0, 25)
              .map((name) => ({ name: name.slice(0, 100), value: name.slice(0, 100) }));

            await interaction.respond(choices).catch(() => {});
            return;
          }
        }
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }

      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "kits") return;

        const sub = interaction.options.getSubcommand();
        if (sub !== "claim") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server." }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const kitInput = interaction.options.getString("kit", true);
        const userId = interaction.user.id;

        await interaction.deferReply().catch(() => {});

        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        const discordName = interaction.member?.displayName || interaction.user.username;
        const fallbackServerDisplay = resolveServerDisplay(serverId);

        const serverExists = listServers().some((s) => s.identifier === serverId);
        if (!serverExists) {
          await sendKitLog(client, interaction, serverId, {
            playerName: "Unknown",
            kitDisplay: kitInput,
            success: false,
            reason: "Server not found",
          });
          return replyV2(interaction, v2ServerNotFound({ username: discordName, serverId }));
        }

        if (!member) {
          await sendKitLog(client, interaction, serverId, {
            playerName: "Unknown",
            kitDisplay: kitInput,
            success: false,
            reason: "Could not fetch member data",
          });
          return interaction.editReply({ content: "Could not fetch your member data." }).catch(() => {});
        }

        const playerName = extractLinkedPlayerName(interaction.guildId, userId);
        if (!playerName) {
          await sendKitLog(client, interaction, serverId, {
            playerName: "Not linked",
            kitDisplay: kitInput,
            success: false,
            reason: "Discord account not linked",
          });
          return replyV2(interaction, v2NotLinked({ username: discordName }));
        }

        const kits = getKitsForServer(interaction.guildId, serverId);
        const needle = norm(kitInput);

        const kitCfg =
          kits.find((k) => kitKeyFromCfgEntry(k) === needle) ||
          kits.find((k) => norm(k?.name) === needle) ||
          kits.find((k) => norm(k?.ingameKit) === needle);

        if (!kitCfg) {
          await sendKitLog(client, interaction, serverId, {
            playerName,
            kitDisplay: kitInput,
            success: false,
            reason: "Kit not configured",
          });
          return replyV2(interaction, v2KitNotFound({ username: discordName, input: kitInput }));
        }

        const kitDisplay = safeName(kitCfg?.name || kitCfg?.ingameKit || "Kit", 100);
        const ingameKit = String(kitCfg?.ingameKit || "").trim();
        const requiredRoleId = kitCfg?.roleId || null;

        if (!userHasKitAccess(member, kitCfg)) {
          await sendKitLog(client, interaction, serverId, {
            playerName,
            kitDisplay,
            success: false,
            reason: "Missing required role",
          });
          return replyV2(interaction, v2MissingRole({ username: discordName, kitDisplay, roleId: requiredRoleId }));
        }

        const cooldownHours = Number(kitCfg?.cooldownHours);
        const cdMs = Number.isFinite(cooldownHours) && cooldownHours > 0 ? cooldownHours * 3600_000 : 0;

        const cAll = readCooldowns();
        const key = kitKeyFromCfgEntry(kitCfg);
        const nextAt = Number(cAll?.[interaction.guildId]?.[serverId]?.[userId]?.[key]?.nextAt || 0);

        if (cdMs > 0 && nextAt && Date.now() < nextAt) {
          const msLeft = nextAt - Date.now();
          const chatCmd = chatCooldown(safeName(playerName, 64), kitDisplay, msLeft);
          await rce.sendCommand(serverId, chatCmd).catch(() => {});
          await sendKitLog(client, interaction, serverId, {
            playerName,
            kitDisplay,
            success: false,
            reason: `Cooldown active (${formatCooldown(msLeft)} left)`,
          });
          return replyV2(interaction, v2Cooldown({ username: discordName, kitDisplay, nextAtMs: nextAt }));
        }

        if (!ingameKit) {
          await sendKitLog(client, interaction, serverId, {
            playerName,
            kitDisplay,
            success: false,
            reason: "In-game kit name missing in config",
          });
          return replyV2(interaction, v2GiveFailed({ username: discordName }));
        }

        const giveCmd = `kit givetoplayer "${escapeQuotes(ingameKit)}" "${escapeQuotes(playerName)}"`;

        log("claim start", {
          guildId: interaction.guildId,
          serverId,
          userId,
          kitDisplay,
          ingameKit,
          playerName,
        });

        const resp = await rce.sendCommand(serverId, giveCmd).catch((e) => {
          logErr("rce.sendCommand failed:", e?.message || e);
          return null;
        });

        if (isUnknownPlayer(resp)) {
          await sendKitLog(client, interaction, serverId, {
            playerName,
            kitDisplay,
            success: false,
            reason: "Player not online / unknown player",
          });
          return replyV2(interaction, v2PlayerOffline({ username: discordName, accountName: playerName }));
        }

        if (!isKitGiveSuccess(resp)) {
          log("claim failed - no success confirmation", {
            serverId,
            userId,
            kit: ingameKit,
            resp: String(resp || "").slice(0, 220),
          });

          await sendKitLog(client, interaction, serverId, {
            playerName,
            kitDisplay,
            success: false,
            reason: `No success confirmation from RCE (${String(resp || "").slice(0, 120) || "empty response"})`,
          });

          return replyV2(interaction, v2GiveFailed({ username: discordName }));
        }

        if (cdMs > 0) {
          const all = readCooldowns();
          const slot = ensure(all, interaction.guildId, serverId, userId);
          slot[key] = { nextAt: Date.now() + cdMs, lastAt: Date.now() };
          writeCooldowns(all);
        }

        incrementKitsClaimed();

        const chatCmd = chatSuccess(safeName(playerName, 64), kitDisplay);
        await rce.sendCommand(serverId, chatCmd).catch(() => {});

        await sendKitLog(client, interaction, serverId, {
          playerName,
          kitDisplay,
          success: true,
          reason: "Kit claimed successfully",
        });

        return replyV2(
          interaction,
          v2Success({
            username: discordName,
            kitDisplay,
            accountName: playerName,
            serverDisplay: fallbackServerDisplay,
          })
        );
      } catch (e) {
        logErr("command error:", e?.message || e);

        try {
          const serverId = interaction.options?.getString?.("server", false);
          const kitInput = interaction.options?.getString?.("kit", false);
          if (interaction.inGuild?.() && serverId) {
            await sendKitLog(client, interaction, serverId, {
              playerName: "Unknown",
              kitDisplay: kitInput || "Unknown",
              success: false,
              reason: `Unhandled error: ${String(e?.message || e).slice(0, 180)}`,
            });
          }
        } catch {}

        if (interaction.isRepliable()) {
          try {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: "Error. Check console." });
            } else {
              await interaction.reply({ content: "Error. Check console." });
            }
          } catch {}
        }
      }
    });
  },
};
