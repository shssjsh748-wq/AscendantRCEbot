// modules/wheelkitsclaim.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { EmbedBuilder } = require("discord.js");
const { RCEEvent } = require("rce.js");

const rceMod = require("./rce");
const { sendConfiguredLog } = require("./rcelogs");

const WHEELKITS_CFG_PATH = path.join(__dirname, "wheelkits_config.json");
const COOLDOWNS_PATH = path.join(__dirname, "wheelkits_cooldowns.json");

function log(...a) {
  console.log("[wheelkitsclaim]", ...a);
}
function logErr(...a) {
  console.error("[wheelkitsclaim]", ...a);
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

function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function safe(s, max = 100) {
  return String(s || "").trim().slice(0, max) || "Unknown";
}

function readWheelkitsCfg() {
  return readJsonSafe(WHEELKITS_CFG_PATH, {});
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

function fmtRemaining(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const totalSec = Math.ceil(ms / 1000);

  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const hoursDec = ms / 3600000;
  const shortH = `${hoursDec.toFixed(2)}h`;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (h === 0 && m === 0) parts.push(`${s}s`);
  const nice = parts.join(" ");

  return { shortH, nice };
}

async function sendRceCommand(serverId, command) {
  if (typeof rceMod?.sendCommand === "function") return rceMod.sendCommand(serverId, command);

  if (typeof rceMod?.getServer === "function") {
    const s = rceMod.getServer(serverId);
    if (s && typeof s.sendCommand === "function") return s.sendCommand(command);
  }

  const maybe = rceMod?.rce || rceMod?.manager || rceMod?.default;

  if (maybe && typeof maybe.sendCommand === "function") return maybe.sendCommand(serverId, command);
  if (maybe && typeof maybe.getServer === "function") {
    const s = maybe.getServer(serverId);
    if (s && typeof s.sendCommand === "function") return s.sendCommand(command);
  }

  throw new Error("sendCommand not available from ../rce exports");
}

function findWheelkitByQuickChat(serverId, quickChatRaw) {
  const all = readWheelkitsCfg();
  const msg = String(quickChatRaw ?? "").trim();
  if (!msg) return null;

  for (const [guildId, g] of Object.entries(all || {})) {
    const slot = g?.[serverId];
    const kits = Array.isArray(slot?.wheelkits) ? slot.wheelkits : [];
    for (const k of kits) {
      const raw = String(k?.emote ?? "").trim();
      if (!raw) continue;

      if (msg === raw || msg.includes(raw)) {
        return { guildId, kit: k };
      }
    }
  }

  return null;
}

function playerKeyFromPayload(payload) {
  const p = payload?.player || {};
  const key =
    p?.steamId ||
    p?.steamID ||
    p?.steamid ||
    p?.id ||
    p?.userId ||
    p?.userid ||
    p?.ign;
  return safe(String(key || "unknown"), 80);
}

const lastAttempt = new Map();
const inFlight = new Set();

function tooSoon(key, ms = 2500) {
  const now = Date.now();
  const last = lastAttempt.get(key) || 0;
  if (now - last < ms) return true;
  lastAttempt.set(key, now);
  return false;
}

function kitDisplayName(kit) {
  return safe(kit?.name || "Kit", 100);
}

function kitIngameName(kit) {
  return safe(kit?.ingameKit || kit?.name || "kit", 100);
}

function cooldownMs(kit) {
  const h = Number(kit?.cooldownHours);
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.floor(h * 3600000);
}

function sayMsgClaimed(playerName, displayName) {
  return `say <b><color=red>[KITS]</color> ${playerName}! You have succesfully claimed <color=red>${displayName}</color>.`;
}

function sayMsgCooldown(playerName, displayName, remainingMs) {
  const { nice } = fmtRemaining(remainingMs);
  return `say <b><color=red>[KITS]</color> ${playerName}! You have already claimed <color=red>${displayName}</color>, You can claim it again in ${nice}.`;
}

function buildWheelkitLogEmbed({
  playerIgn,
  kitName,
  success,
  reason,
  serverId,
  response,
}) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Wheel Kit Log")
    .addFields(
      { name: "Status", value: success ? "✅ Success" : "❌ Failed", inline: true },
      { name: "Player", value: `\`${safe(playerIgn, 100)}\``, inline: true },
      { name: "Kit", value: `\`${safe(kitName, 100)}\``, inline: true },
      { name: "Server", value: `\`${safe(serverId, 100)}\``, inline: true },
      { name: "Reason", value: safe(reason || "None", 300) }
    )
    .setTimestamp();

  if (response) {
    embed.addFields({
      name: "Response",
      value: `\`${safe(response, 800)}\``,
    });
  }

  return embed;
}

async function sendWheelkitLog(client, guildId, serverId, embed) {
  if (!guildId || !serverId) return;
  await sendConfiguredLog(client, guildId, serverId, "wheelkits", { embeds: [embed] }).catch(() => {});
}

module.exports = {
  name: "wheelkitsclaim",

  init(client) {


    const emitter =
      (typeof rceMod?.on === "function" && rceMod) ||
      (typeof rceMod?.rce?.on === "function" && rceMod.rce) ||
      (typeof rceMod?.manager?.on === "function" && rceMod.manager) ||
      null;

    if (!emitter) {
      logErr("No RCE emitter found (../rce does not expose .on). QuickChat listener NOT attached.");
      return;
    }

    emitter.on(RCEEvent.QuickChat, async (payload) => {
      try {
        const serverId = payload?.server?.identifier;
        if (!serverId) return;

        const quickChat = payload?.message;
        const match = findWheelkitByQuickChat(serverId, quickChat);
        if (!match) return;

        const { guildId, kit } = match;

        const playerIgn = safe(payload?.player?.ign || payload?.player?.name || "Player", 60);
        const pKey = playerKeyFromPayload(payload);

        const spamKey = `${serverId}:${pKey}:${norm(kitDisplayName(kit))}`;
        if (tooSoon(spamKey, 2500)) return;

        if (inFlight.has(spamKey)) return;
        inFlight.add(spamKey);

        try {
          const cdMs = cooldownMs(kit);
          const now = Date.now();

          const allCd = readCooldowns();
          const slot = ensure(allCd, serverId, pKey);
          const kName = kitDisplayName(kit);
          const last = Number(slot[kName] || 0);

          if (cdMs > 0 && last && now - last < cdMs) {
            const remaining = cdMs - (now - last);

            await sendRceCommand(serverId, sayMsgCooldown(playerIgn, kName, remaining)).catch((e) => {
              logErr("say cooldown failed:", e?.message || e);
            });

            await sendWheelkitLog(
              client,
              guildId,
              serverId,
              buildWheelkitLogEmbed({
                playerIgn,
                kitName: kName,
                success: false,
                reason: `Cooldown active (${fmtRemaining(remaining).nice} left)`,
                serverId,
              })
            );

            return;
          }

          const ingame = kitIngameName(kit);

          let giveResp = null;
          try {
            giveResp = await sendRceCommand(serverId, `kit givetoplayer "${ingame}" "${playerIgn}"`);
          } catch (e) {
            logErr("kit givetoplayer failed:", e?.message || e);
            await sendWheelkitLog(
              client,
              guildId,
              serverId,
              buildWheelkitLogEmbed({
                playerIgn,
                kitName: kName,
                success: false,
                reason: "kit givetoplayer failed",
                serverId,
                response: String(e?.message || e || ""),
              })
            );
            return;
          }

          slot[kName] = now;
          writeCooldowns(allCd);

          await sendRceCommand(serverId, sayMsgClaimed(playerIgn, kName)).catch((e) => {
            logErr("say success failed:", e?.message || e);
          });

          await sendWheelkitLog(
            client,
            guildId,
            serverId,
            buildWheelkitLogEmbed({
              playerIgn,
              kitName: kName,
              success: true,
              reason: "Wheel kit claimed successfully",
              serverId,
              response: String(giveResp || ""),
            })
          );
        } finally {
          inFlight.delete(spamKey);
        }
      } catch (e) {
        logErr("QuickChat handler error:", e?.message || e);

        try {
          const serverId = payload?.server?.identifier;
          const quickChat = payload?.message;
          const match = serverId ? findWheelkitByQuickChat(serverId, quickChat) : null;
          if (match?.guildId && serverId) {
            const playerIgn = safe(payload?.player?.ign || payload?.player?.name || "Player", 60);
            const kitName = kitDisplayName(match.kit);

            await sendWheelkitLog(
              client,
              match.guildId,
              serverId,
              buildWheelkitLogEmbed({
                playerIgn,
                kitName,
                success: false,
                reason: `Handler error: ${String(e?.message || e).slice(0, 200)}`,
                serverId,
              })
            );
          }
        } catch {}
      }
    });

    log("QuickChat listener attached.");
  },
};
