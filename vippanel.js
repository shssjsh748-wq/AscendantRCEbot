// modules/vippanel.js — VIP panel with timed auto-removal
// Commands: /vip-panel deploy | config
// Button:   vip_claim:<serverId>:<days>
// RCE:      VipID "gamertag"  /  RemoveVip "gamertag"

const fs   = require("fs");
const path = require("path");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { listServers, rce } = require("../rce");
const { readLinks }        = require("../shared/links");

const ROLES_PATH      = path.join(__dirname, "..", "data", "roles.json");
const VIP_CONFIG_PATH = path.join(__dirname, "..", "data", "vip_config.json");
const VIP_ACTIVE_PATH = path.join(__dirname, "..", "data", "vip_active.json");

function log(...a)    { console.log("[vippanel]",   ...a); }
function logErr(...a) { console.error("[vippanel]", ...a); }

// ── Helpers ────────────────────────────────────────────────────────────────

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}

function writeJsonSafe(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { logErr("writeJsonSafe failed:", file, e?.message || e); }
}

const readRoles      = ()    => readJsonSafe(ROLES_PATH,      {});
const readVipConfig  = ()    => readJsonSafe(VIP_CONFIG_PATH, {});
const writeVipConfig = (d)   => writeJsonSafe(VIP_CONFIG_PATH, d);
const readVipActive  = ()    => readJsonSafe(VIP_ACTIVE_PATH, {});
const writeVipActive = (d)   => writeJsonSafe(VIP_ACTIVE_PATH, d);

function isAdminOrOwner(member) {
  if (!member) return false;
  const roles = readRoles();
  if (member.permissions?.has?.("Administrator")) return true;
  if (roles.ownerRoleId && member.roles?.cache?.has(roles.ownerRoleId)) return true;
  if (roles.adminRoleId && member.roles?.cache?.has(roles.adminRoleId)) return true;
  return false;
}

function getGamertag(discordId) {
  const links = readLinks();
  return links[discordId]?.gamertag || null;
}

function escapeQuotes(s) { return String(s || "").replace(/"/g, '\\"'); }

function getServerDisplay(serverId) {
  try {
    const s = listServers().find((x) => x.identifier === serverId);
    return String(s?.displayName || s?.identifier || serverId).trim();
  } catch { return String(serverId || "Unknown"); }
}

// ── Embed / component builders ──────────────────────────────────────────────

function buildVipEmbed(serverDisplay, days) {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("⭐ VIP Access")
    .setDescription(
      `Click the button below to claim **VIP** on **${serverDisplay}**.\n\n` +
      `> VIP lasts **${days} day${days !== 1 ? "s" : ""}** and is removed automatically when it expires.\n\n` +
      `*You must have your account linked to use this.*`
    )
    .setFooter({ text: `VIP duration: ${days} day${days !== 1 ? "s" : ""}` })
    .setTimestamp();
}

function buildVipRow(serverId, days) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vip_claim:${serverId}:${days}`)
      .setLabel("⭐ Get VIP")
      .setStyle(ButtonStyle.Primary)
  );
}

// ── VIP removal scheduler ───────────────────────────────────────────────────
// setTimeout is capped at ~24.8 days (32-bit ms limit).
// VIPs beyond that are handled by the setInterval checker instead.

const pendingRemovals = new Map(); // key: `${serverId}::${gamertag.toLowerCase()}`

async function doRemoveVip(serverId, gamertag, reason) {
  log(`doRemoveVip: "${gamertag}" on "${serverId}" (${reason})`);

  try {
    await rce.sendCommand(serverId, `RemoveVip "${escapeQuotes(gamertag)}"`);
  } catch (e) {
    logErr(`doRemoveVip failed for "${gamertag}" on "${serverId}":`, e?.message || e);
  }

  const active = readVipActive();
  if (active[serverId]) {
    delete active[serverId][gamertag.toLowerCase()];
    if (!Object.keys(active[serverId]).length) delete active[serverId];
    writeVipActive(active);
  }
}

function scheduleRemoval(serverId, gamertag, expiresAt) {
  const key = `${serverId}::${gamertag.toLowerCase()}`;

  if (pendingRemovals.has(key)) {
    clearTimeout(pendingRemovals.get(key));
    pendingRemovals.delete(key);
  }

  const delay = expiresAt - Date.now();

  if (delay <= 0) {
    doRemoveVip(serverId, gamertag, "already expired on startup");
    return;
  }

  const MAX_MS = 24 * 24 * 60 * 60 * 1000; // 24 days — keeps us in the safe setTimeout range
  if (delay > MAX_MS) {
    log(`scheduleRemoval: "${gamertag}" on "${serverId}" is ${Math.round(delay / 86400000)}d away — deferred to interval checker`);
    return;
  }

  const id = setTimeout(() => {
    pendingRemovals.delete(key);
    doRemoveVip(serverId, gamertag, "scheduled timeout");
  }, delay);

  pendingRemovals.set(key, id);
  log(`scheduleRemoval: "${gamertag}" on "${serverId}" in ${Math.round(delay / 60000)}m`);
}

function startExpiryChecker() {
  setInterval(() => {
    const active = readVipActive();
    const now    = Date.now();
    for (const [serverId, players] of Object.entries(active)) {
      for (const [, record] of Object.entries(players)) {
        if (record.expiresAt <= now) {
          log(`interval checker: "${record.gamertag}" on "${serverId}" expired`);
          doRemoveVip(serverId, record.gamertag, "interval checker");
        }
      }
    }
  }, 60 * 1000);
}

function restorePendingRemovals() {
  const active   = readVipActive();
  let   restored = 0;
  for (const [serverId, players] of Object.entries(active)) {
    for (const [, record] of Object.entries(players)) {
      scheduleRemoval(serverId, record.gamertag, record.expiresAt);
      restored++;
    }
  }
  if (restored) log(`restorePendingRemovals: ${restored} VIP(s) restored`);
}

// ── Module ──────────────────────────────────────────────────────────────────

module.exports = {
  name: "vippanel",

  init(client) {
    restorePendingRemovals();
    startExpiryChecker();

    // ── Autocomplete ───────────────────────────────────────────────────────
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete())          return;
        if (interaction.commandName !== "vip-panel") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const q       = String(focused.value || "").toLowerCase();
        const choices = listServers()
          .map((s) => ({ name: (s.displayName || s.identifier).slice(0, 100), value: s.identifier }))
          .filter((c) => !q || c.name.toLowerCase().includes(q))
          .slice(0, 25);

        await interaction.respond(choices).catch(() => {});
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // ── Slash commands ─────────────────────────────────────────────────────
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand())       return;
        if (interaction.commandName !== "vip-panel") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();

        // ── /vip-panel deploy ──────────────────────────────────────────────
        if (sub === "deploy") {
          if (!isAdminOrOwner(interaction.member)) {
            return interaction.reply({ content: "❌ Admin or Owner only.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const days     = interaction.options.getInteger("days",   true);

          if (!listServers().some((s) => s.identifier === serverId)) {
            return interaction.reply({ content: "❌ Server not found.", flags: MessageFlags.Ephemeral });
          }

          const serverDisplay = getServerDisplay(serverId);
          const embed         = buildVipEmbed(serverDisplay, days);
          const row           = buildVipRow(serverId, days);

          const msg = await interaction.channel.send({ embeds: [embed], components: [row] });

          const cfg = readVipConfig();
          if (!cfg[interaction.guildId]) cfg[interaction.guildId] = {};
          cfg[interaction.guildId][msg.id] = {
            serverId,
            days,
            channelId:   interaction.channelId,
            deployedBy:  interaction.user.id,
            deployedAt:  Date.now(),
          };
          writeVipConfig(cfg);

          log("deployed", { guildId: interaction.guildId, serverId, days, messageId: msg.id });

          return interaction.reply({
            content: `✅ VIP panel deployed for **${serverDisplay}** (${days} day${days !== 1 ? "s" : ""}).`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // ── /vip-panel config ──────────────────────────────────────────────
        if (sub === "config") {
          if (!isAdminOrOwner(interaction.member)) {
            return interaction.reply({ content: "❌ Admin or Owner only.", flags: MessageFlags.Ephemeral });
          }

          const serverId = interaction.options.getString("server", true);
          const days     = interaction.options.getInteger("days",   true);

          const cfg      = readVipConfig();
          const gPanels  = cfg[interaction.guildId] || {};
          const matching = Object.entries(gPanels).filter(([, row]) => row.serverId === serverId);

          if (!matching.length) {
            return interaction.reply({
              content: "❌ No VIP panels found for that server. Deploy one first with `/vip-panel deploy`.",
              flags: MessageFlags.Ephemeral,
            });
          }

          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const serverDisplay = getServerDisplay(serverId);
          let   updated       = 0;

          for (const [messageId, row] of matching) {
            row.days = days;
            cfg[interaction.guildId][messageId] = row;

            try {
              const channel = await interaction.guild.channels.fetch(row.channelId).catch(() => null);
              if (channel?.isTextBased?.()) {
                const msg = await channel.messages.fetch(messageId).catch(() => null);
                if (msg) {
                  await msg.edit({
                    embeds:     [buildVipEmbed(serverDisplay, days)],
                    components: [buildVipRow(serverId, days)],
                  }).catch(() => {});
                  updated++;
                }
              }
            } catch {}
          }

          writeVipConfig(cfg);
          log("config updated", { guildId: interaction.guildId, serverId, days, updated });

          return interaction.editReply({
            content: `✅ Updated **${updated}** VIP panel(s) for **${serverDisplay}** to **${days} day${days !== 1 ? "s" : ""}**.`,
          });
        }

        return interaction.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        logErr("command error:", e?.message || e);
        if (!interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        } else if (interaction.deferred) {
          try { await interaction.editReply({ content: "Error. Check console." }); } catch {}
        }
      }
    });

    // ── Button: vip_claim:<serverId>:<days> ────────────────────────────────
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isButton())                        return;
        if (!interaction.customId.startsWith("vip_claim:")) return;

        // Parse customId — serverId may contain spaces but not colons in practice.
        // Format: vip_claim:<serverId>:<days>
        const raw    = interaction.customId.slice("vip_claim:".length); // "<serverId>:<days>"
        const lastColon = raw.lastIndexOf(":");
        if (lastColon === -1) {
          return interaction.reply({ content: "❌ Invalid panel data.", flags: MessageFlags.Ephemeral });
        }
        const serverId = raw.slice(0, lastColon);
        const days     = parseInt(raw.slice(lastColon + 1), 10);

        if (!serverId || isNaN(days)) {
          return interaction.reply({ content: "❌ Invalid panel data.", flags: MessageFlags.Ephemeral });
        }

        const gamertag = getGamertag(interaction.user.id);
        if (!gamertag) {
          return interaction.reply({
            content: "❌ You haven't linked your account yet. Use `/link` to connect your gamertag first.",
            flags: MessageFlags.Ephemeral,
          });
        }

        // Check for existing active VIP on this server
        const active   = readVipActive();
        const existing = active[serverId]?.[gamertag.toLowerCase()];
        if (existing) {
          const daysLeft = Math.max(0, Math.ceil((existing.expiresAt - Date.now()) / 86400000));
          return interaction.reply({
            content: `❌ You already have active VIP on this server. It expires in **${daysLeft} day${daysLeft !== 1 ? "s" : ""}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Give VIP in-game
        let resp = null;
        try {
          resp = await rce.sendCommand(serverId, `VipID "${escapeQuotes(gamertag)}"`);
        } catch (e) {
          logErr("VipID sendCommand error:", e?.message || e);
        }

        const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;

        // Persist
        if (!active[serverId]) active[serverId] = {};
        active[serverId][gamertag.toLowerCase()] = {
          gamertag,
          discordId: interaction.user.id,
          days,
          givenAt:   Date.now(),
          expiresAt,
        };
        writeVipActive(active);

        scheduleRemoval(serverId, gamertag, expiresAt);

        const serverDisplay = getServerDisplay(serverId);
        const expiresDate   = new Date(expiresAt).toUTCString();

        log("VIP given:", { gamertag, serverId, days, expiresAt });

        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("⭐ VIP Activated!")
              .addFields(
                { name: "Gamertag", value: gamertag,                              inline: true },
                { name: "Server",   value: serverDisplay,                         inline: true },
                { name: "Duration", value: `${days} day${days !== 1 ? "s" : ""}`, inline: true },
                { name: "Expires",  value: expiresDate,                           inline: false },
                { name: "Response", value: String(resp || "No response").slice(0, 500), inline: false }
              )
              .setTimestamp(),
          ],
        });
      } catch (e) {
        logErr("button error:", e?.message || e);
        if (!interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        } else if (interaction.deferred) {
          try { await interaction.editReply({ content: "Error. Check console." }); } catch {}
        }
      }
    });
  },
};
