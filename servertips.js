const fs = require("fs");
const path = require("path");
const { MessageFlags, EmbedBuilder } = require("discord.js");
const { RCEEvent } = require("rce.js");
const { listServers, getServer } = require("../rce");

const CFG_PATH = path.join(__dirname, "..", "data", "zonetext.json");
const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");

function log(...a) {
  console.log("[zonetext/servertips]", ...a);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log("readJsonSafe failed:", e?.message || e);
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    log("writeJsonSafe failed:", e?.message || e);
  }
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, {
    consoleRoleId: null,
    adminRoleId: null,
    ownerRoleId: null,
  });
}

function hasAccess(member) {
  const roles = readRoles();
  const adminRoleId = roles?.adminRoleId || null;
  const ownerRoleId = roles?.ownerRoleId || null;

  if (!member?.roles?.cache) return false;

  return Boolean(
    (adminRoleId && member.roles.cache.has(adminRoleId)) ||
    (ownerRoleId && member.roles.cache.has(ownerRoleId))
  );
}

function getCfg() {
  return readJsonSafe(CFG_PATH, {});
}

function isTipsEnabled(serverId) {
  const cfg = getCfg();
  return cfg?.[serverId]?.tips?.enabled === true;
}

function setTipsEnabled(serverId, enabled) {
  const cfg = getCfg();
  if (!cfg[serverId]) cfg[serverId] = {};
  if (!cfg[serverId].tips) cfg[serverId].tips = {};
  cfg[serverId].tips.enabled = Boolean(enabled);
  writeJsonSafe(CFG_PATH, cfg);
}

function resolveServerDisplay(serverId) {
  try {
    const s = getServer(serverId);
    return String(s?.displayName || s?.identifier || serverId || "Unknown").trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

function parsePrintPosResponse(resp) {
  const text = String(resp || "");
  const match = text.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);

  if (!match) return null;

  return {
    x: Number(match[1]).toFixed(2),
    y: Number(match[2]).toFixed(2),
    z: Number(match[3]).toFixed(2),
  };
}

function quickChatMatches(message) {
  return norm(message) === "d11_quick_chat_questions_slot_4";
}

function buildZoneText(playerName) {
  return `<align="center"><br><size=200%>Hey <#A900FF>${playerName}</color>, Below is some useful server tips!<br><size=150%><color=#FFE300><u>Quick Chat Hooks!<br></color></u><size=130%> Hourly Kit → I Need Wood<br> Daily Kit → I Need Water<br> Bandit Teleport → North<br> Outpost Teleport → South<br> ZORP (Offline Protection) → Can I Build Around Here<br><size=150%><color=#FFE300><u>Server Links!<br></color></u><size=100%>Website (Store, Economy, Leaderboards) → <#A900FF>hy<#BA33FF>pe<#CB66FF>sr<#DD99FF>ce<#EECCFF>.c<#FFFFFF>om</color><br>Discord → <#A900FF>di<#B31CFF>sc<#BC39FF>or<#C655FF>d.<#CF71FF>gg<#D98EFF>/h<#E2AAFF>yp<#ECC6FF>es<#F5E3FF>RC<#F5E3FF>E`;
}

function buildCreateCommand(playerName, x, y, z) {
  const zoneText = buildZoneText(playerName);
  return `createcustomzone "${escapeQuotes(zoneText)}" (${x},${y},${z}) 45 sphere 5`;
}

function buildDeleteCommand(playerName) {
  const zoneText = buildZoneText(playerName);
  return `deletecustomzone "${escapeQuotes(zoneText)}"`;
}

function successEmbed(serverDisplay, status) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Zone Text Updated")
    .addFields(
      { name: "Server", value: `\`${serverDisplay}\``, inline: true },
      { name: "Set", value: "`Tips`", inline: true },
      { name: "Status", value: status === "on" ? "`On`" : "`Off`", inline: true }
    )
    .setTimestamp();
}

module.exports = {
  name: "servertips",

  init(client, rce) {
    const quickChatCooldown = new Map();

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "zonetext") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const q = norm(focused.value);
          const choices = listServers()
            .map((s) => ({
              name: String(s.displayName || s.identifier).slice(0, 100),
              value: s.identifier,
            }))
            .filter((c) => norm(c.name).includes(q))
            .slice(0, 25);

          await interaction.respond(choices).catch(() => {});
          return;
        }

        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "zonetext") return;

        if (!interaction.inGuild()) {
          return interaction.reply({
            content: "Use this in a server.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        const member =
          interaction.member ||
          (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

        if (!hasAccess(member)) {
          return interaction.reply({
            content: ":x: You do not have permission to use this command.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const setName = interaction.options.getString("set", true);
        const status = interaction.options.getString("status", true);

        if (setName !== "tips") {
          return interaction.reply({
            content: ":x: Invalid set selected.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }

        setTipsEnabled(serverId, status === "on");

        return interaction.reply({
          embeds: [successEmbed(resolveServerDisplay(serverId), status)],
        }).catch(() => {});
      } catch (e) {
        console.error("[zonetext/servertips] interaction error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({
              content: "Error. Check console.",
              flags: MessageFlags.Ephemeral,
            });
          } catch {}
        }
      }
    });

    rce.on(RCEEvent.QuickChat, async (payload) => {
      try {
        const serverId = payload?.server?.identifier;
        const playerName = String(payload?.player?.ign || "").trim();
        const message = String(payload?.message || "").trim();

        if (!serverId || !playerName) return;
        if (!quickChatMatches(message)) return;
        if (!isTipsEnabled(serverId)) return;

        const key = `${serverId}:${playerName.toLowerCase()}`;
        const now = Date.now();
        const last = quickChatCooldown.get(key) || 0;
        if (now - last < 1000) return;
        quickChatCooldown.set(key, now);

        let printPosResp = null;
        try {
          printPosResp = await rce.sendCommand(serverId, `printpos "${escapeQuotes(playerName)}"`);
        } catch (e) {
          log("printpos failed:", serverId, playerName, e?.message || e);
          return;
        }

        const coords = parsePrintPosResponse(printPosResp);
        if (!coords) {
          log("no coords returned:", serverId, playerName, printPosResp);
          return;
        }

        const createCmd = buildCreateCommand(playerName, coords.x, coords.y, coords.z);
        const deleteCmd = buildDeleteCommand(playerName);

        await rce.sendCommand(serverId, createCmd).catch((e) => {
          log("createcustomzone failed:", serverId, playerName, e?.message || e);
        });

        await rce.sendCommand(serverId, deleteCmd).catch((e) => {
          log("deletecustomzone failed:", serverId, playerName, e?.message || e);
        });
      } catch (e) {
        log("quickchat handler error:", e?.message || e);
      }
    });

    // ensure config entries exist for current servers
    const cfg = getCfg();
    let changed = false;

    for (const s of listServers()) {
      const serverId = s?.identifier;
      if (!serverId) continue;
      if (!cfg[serverId]) {
        cfg[serverId] = {};
        changed = true;
      }
      if (!cfg[serverId].tips) {
        cfg[serverId].tips = { enabled: false };
        changed = true;
      }
    }

    if (changed) writeJsonSafe(CFG_PATH, cfg);
  },
};