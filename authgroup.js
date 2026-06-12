// modules/authgroup.js — /authgroup add | remove | list
const fs = require("fs");
const path = require("path");

const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { listServers, rce } = require("./rce");
const { readLinks } = require("./links");

const ROLES_PATH = path.join(__dirname, "roles.json");

function log(...a) { console.log("[authgroup]", ...a); }
function logErr(...a) { console.error("[authgroup]", ...a); }

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function getRoleConfig() { return readJsonSafe(ROLES_PATH, {}); }

function isAdminOrOwner(member) {
  if (!member) return false;
  const roles = getRoleConfig();
  if (member.permissions?.has?.("Administrator")) return true;
  if (roles.ownerRoleId && member.roles?.cache?.has(roles.ownerRoleId)) return true;
  if (roles.adminRoleId && member.roles?.cache?.has(roles.adminRoleId)) return true;
  return false;
}

function grey() { return new EmbedBuilder().setColor(0x95a5a6).setTimestamp(); }

function escapeQuotes(s) { return String(s || "").replace(/"/g, '\\"'); }

function norm(s) { return String(s || "").trim().toLowerCase(); }

// Map role choice value → RCE command names
const ROLE_COMMANDS = {
  vip:       { add: "VipID",       remove: "RemoveVip",       label: "VIP" },
  moderator: { add: "ModeratorID", remove: "RemoveModerator", label: "Moderator" },
  admin:     { add: "AdminID",     remove: "RemoveAdmin",     label: "Admin" },
  owner:     { add: "OwnerID",     remove: "RemoveOwner",     label: "Owner" },
};

function getServerDisplay(serverId) {
  try {
    const s = listServers().find((x) => x.identifier === serverId);
    return String(s?.displayName || s?.identifier || serverId).trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

// Look up a Discord user's linked gamertag. Returns null if not linked.
function getGamertag(discordId) {
  const links = readLinks();
  return links[discordId]?.gamertag || null;
}

module.exports = {
  name: "authgroup",

  init(client) {
    // Autocomplete: server option
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "authgroup") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const q = norm(focused.value);
        const choices = listServers()
          .map((s) => ({ name: (s.displayName || s.identifier).slice(0, 100), value: s.identifier }))
          .filter((c) => !q || c.name.toLowerCase().includes(q))
          .slice(0, 25);

        await interaction.respond(choices).catch(() => {});
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // Command handler
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "authgroup") return;
        if (!interaction.inGuild()) return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });

        if (!isAdminOrOwner(interaction.member)) {
          return interaction.reply({ content: "❌ Admin or Owner only.", flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();
        const serverId = interaction.options.getString("server", true);

        const serverExists = listServers().some((s) => s.identifier === serverId);
        if (!serverExists) {
          return interaction.reply({ content: "❌ Server not found.", flags: MessageFlags.Ephemeral });
        }

        // ── ADD ────────────────────────────────────────────────────────────
        if (sub === "add") {
          const targetUser = interaction.options.getUser("user", true);
          const roleKey    = interaction.options.getString("role", true);
          const roleCfg    = ROLE_COMMANDS[roleKey];

          const gamertag = getGamertag(targetUser.id);
          if (!gamertag) {
            return interaction.reply({
              content: `❌ **${targetUser.tag}** has not linked their account yet.`,
              flags: MessageFlags.Ephemeral,
            });
          }

          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const cmd = `${roleCfg.add} "${escapeQuotes(gamertag)}"`;
          log("add:", cmd, "on", serverId);

          let resp = null;
          try {
            resp = await rce.sendCommand(serverId, cmd);
          } catch (e) {
            logErr("sendCommand error:", e?.message || e);
          }

          const embed = grey()
            .setTitle(`Authgroup — ${roleCfg.label} Added`)
            .addFields(
              { name: "Player",   value: targetUser.tag,             inline: true },
              { name: "Gamertag", value: gamertag,                   inline: true },
              { name: "Role",     value: roleCfg.label,              inline: true },
              { name: "Server",   value: getServerDisplay(serverId), inline: true },
              { name: "Command",  value: `\`${cmd}\``,               inline: false },
              { name: "Response", value: String(resp || "No response").slice(0, 1000), inline: false }
            );

          return interaction.editReply({ embeds: [embed] });
        }

        // ── REMOVE ─────────────────────────────────────────────────────────
        if (sub === "remove") {
          const targetUser = interaction.options.getUser("user", true);
          const roleKey    = interaction.options.getString("role", true);
          const roleCfg    = ROLE_COMMANDS[roleKey];

          const gamertag = getGamertag(targetUser.id);
          if (!gamertag) {
            return interaction.reply({
              content: `❌ **${targetUser.tag}** has not linked their account yet.`,
              flags: MessageFlags.Ephemeral,
            });
          }

          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const cmd = `${roleCfg.remove} "${escapeQuotes(gamertag)}"`;
          log("remove:", cmd, "on", serverId);

          let resp = null;
          try {
            resp = await rce.sendCommand(serverId, cmd);
          } catch (e) {
            logErr("sendCommand error:", e?.message || e);
          }

          const embed = grey()
            .setTitle(`Authgroup — ${roleCfg.label} Removed`)
            .addFields(
              { name: "Player",   value: targetUser.tag,             inline: true },
              { name: "Gamertag", value: gamertag,                   inline: true },
              { name: "Role",     value: roleCfg.label,              inline: true },
              { name: "Server",   value: getServerDisplay(serverId), inline: true },
              { name: "Command",  value: `\`${cmd}\``,               inline: false },
              { name: "Response", value: String(resp || "No response").slice(0, 1000), inline: false }
            );

          return interaction.editReply({ embeds: [embed] });
        }

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === "list") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          let resp = null;
          try {
            resp = await rce.sendCommand(serverId, "global.getauthlevels");
          } catch (e) {
            logErr("list sendCommand error:", e?.message || e);
          }

          const raw = String(resp ?? "No response").trim();
          const display = raw.length > 3800 ? raw.slice(0, 3800) + "…" : raw || "None";

          const embed = grey()
            .setTitle(`Authgroup List — ${getServerDisplay(serverId)}`)
            .setDescription(`\`\`\`${display}\`\`\``);

          return interaction.editReply({ embeds: [embed] });
        }


        // ── REMOVE-ALL ─────────────────────────────────────────────────────
        if (sub === "remove-all") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          // First fetch the current list so the user knows what will be wiped
          let listResp = null;
          try {
            listResp = await rce.sendCommand(serverId, "global.getauthlevels");
          } catch (e) {
            logErr("remove-all getauthlevels error:", e?.message || e);
          }

          const raw = String(listResp ?? "No response").trim();
          const preview = raw.length > 1800 ? raw.slice(0, 1800) + "…" : raw || "None";

          const embed = grey()
            .setTitle(`⚠️ Authgroup Remove-All — ${getServerDisplay(serverId)}`)
            .setDescription(
              `This will remove **every player** from all auth groups on **${getServerDisplay(serverId)}**.\n\n**Current auth levels:**\n\`\`\`${preview}\`\`\``
            );

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`authgroup_removeall:${serverId}:${interaction.user.id}`)
              .setLabel("Confirm Remove All")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`authgroup_removeall_cancel:${interaction.user.id}`)
              .setLabel("Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          return interaction.editReply({ embeds: [embed], components: [row] });
        }

        return interaction.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        logErr("command error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        } else if (interaction.deferred) {
          try { await interaction.editReply({ content: "Error. Check console." }); } catch {}
        }
      }
    });

    // Button: confirm / cancel remove-all
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isButton()) return;

        // Cancel
        if (interaction.customId.startsWith("authgroup_removeall_cancel:")) {
          const [, ownerId] = interaction.customId.split(":");
          if (interaction.user.id !== ownerId) {
            return interaction.reply({ content: "Not your panel.", flags: MessageFlags.Ephemeral });
          }
          await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
          return;
        }

        // Confirm
        if (interaction.customId.startsWith("authgroup_removeall:")) {
          const parts = interaction.customId.split(":");
          const serverId = parts[1];
          const ownerId  = parts[2];

          if (interaction.user.id !== ownerId) {
            return interaction.reply({ content: "Not your panel.", flags: MessageFlags.Ephemeral });
          }
          if (!isAdminOrOwner(interaction.member)) {
            return interaction.reply({ content: "❌ Admin or Owner only.", flags: MessageFlags.Ephemeral });
          }

          await interaction.update({ content: "⏳ Removing all auth groups…", embeds: [], components: [] });

          // Get the list and parse names
          let listResp = null;
          try {
            listResp = await rce.sendCommand(serverId, "global.getauthlevels");
          } catch (e) {
            logErr("remove-all confirm getauthlevels error:", e?.message || e);
          }

          const raw = String(listResp ?? "").trim();
          log("remove-all raw list:", raw);

          // Parse player names from the response.
          // Try to extract names — each line may look like:
          //   PlayerName - VIP  |  PlayerName (Moderator)  |  SteamID | PlayerName | Level
          // We collect anything that looks like a name (non-empty token that isn't a known keyword).
          const SKIP = new Set(["none", "vip", "moderator", "admin", "owner", "authlevel", "auth", "level", "steamid", "-", "|", ":", ""]);
          const namesFound = new Set();

          for (const line of raw.split(/\r?\n/)) {
            const clean = line.trim();
            if (!clean) continue;

            // Strategy 1: quoted name  "PlayerName"
            const quoted = clean.match(/"([^"]+)"/g);
            if (quoted) {
              for (const q of quoted) namesFound.add(q.slice(1, -1).trim());
              continue;
            }

            // Strategy 2: split by common separators and pick token that looks like a name
            const tokens = clean.split(/[\s|,]+/).map((t) => t.trim()).filter(Boolean);
            for (const token of tokens) {
              // Skip pure numbers (SteamIDs), short tokens, and keywords
              if (/^\d+$/.test(token)) continue;
              if (token.length < 2) continue;
              if (SKIP.has(token.toLowerCase())) continue;
              namesFound.add(token);
            }
          }

          const names = [...namesFound];
          log("remove-all parsed names:", names);

          if (!names.length) {
            return interaction.editReply({
              content: `⚠️ Could not parse any player names from the server response.\n\`\`\`${raw.slice(0, 1000) || "Empty"}\`\`\``,
            });
          }

          // Run all four Remove commands for every name found
          const removeKeys = Object.values(ROLE_COMMANDS);
          const results = [];

          for (const name of names) {
            const escaped = escapeQuotes(name);
            for (const { remove, label } of removeKeys) {
              const cmd = `${remove} "${escaped}"`;
              let resp = null;
              try {
                resp = await rce.sendCommand(serverId, cmd);
              } catch (e) {
                resp = `ERROR: ${e?.message || e}`;
              }
              results.push({ name, role: label, cmd, resp: String(resp ?? "").trim() });
            }
          }

          // Build summary
          const lines = results
            .filter((r) => r.resp && !/no user|not found|error/i.test(r.resp))
            .map((r) => `${r.name} — ${r.role}: ${r.resp.slice(0, 80)}`);

          const summary = lines.length
            ? lines.join("\n").slice(0, 3500)
            : `Sent ${results.length} remove commands (${names.length} players × 4 roles).`;

          const embed = grey()
            .setTitle(`Authgroup Remove-All — ${getServerDisplay(serverId)}`)
            .setDescription(`Removed **${names.length}** player(s) from all auth groups.\n\`\`\`${summary}\`\`\``);

          return interaction.editReply({ content: "", embeds: [embed] });
        }
      } catch (e) {
        logErr("button error:", e?.message || e);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.editReply({ content: "Error. Check console." });
          }
        } catch {}
      }
    });
  },
};
