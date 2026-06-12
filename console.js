const fs = require("fs");
const path = require("path");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { RCEEvent } = require("rce.js");
const { sendConfiguredLog } = require("./rcelogs");

const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safe(s, max = 1900) {
  return String(s ?? "").trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, {
    adminRoleId: null,
    ownerRoleId: null,
    consoleRoleId: null,
  });
}

function getRoleNames(guild) {
  const cfg = readRoles();
  const names = [];

  if (cfg.consoleRoleId) {
    const r = guild?.roles?.cache?.get(cfg.consoleRoleId);
    if (r) names.push(r.name);
  }

  if (cfg.ownerRoleId) {
    const r = guild?.roles?.cache?.get(cfg.ownerRoleId);
    if (r) names.push(r.name);
  }

  const uniqueNames = [...new Set(names)];
  return uniqueNames.length ? uniqueNames.join(" or ") : "the required role";
}

function hasConsoleAccess(member) {
  const cfg = readRoles();
  const roles = member?.roles?.cache;
  if (!roles) return false;
  if (cfg.consoleRoleId && roles.has(cfg.consoleRoleId)) return true;
  if (cfg.ownerRoleId && roles.has(cfg.ownerRoleId)) return true;
  return false;
}

function normalizeLines(content) {
  return String(content || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseFirstLine(line) {
  const str = String(line || "").trim();
  const withoutPrefix = str.replace(/^!console\s*/i, "").trim();
  if (!withoutPrefix) return null;
  const quoted = withoutPrefix.match(/^"([^"]+)"$/);
  if (quoted) return quoted[1].trim();
  return withoutPrefix;
}

function isFailureResponse(resp) {
  const s = String(resp || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("unknown command") ||
    s.includes("unknown player") ||
    s.includes("failed") ||
    s.includes("error") ||
    s.includes("exception") ||
    s.includes("denied") ||
    s.includes("not found") ||
    s.includes("invalid")
  );
}

function pickResponseText(sendResp, recentText) {
  const a = safe(sendResp, 1000);
  const b = safe(recentText, 1000);
  return a || b || "No response captured.";
}

async function waitForRecentServerMessage(recentConsole, serverId, afterTs, timeoutMs = 900) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const rows = recentConsole.get(serverId) || [];
    const found = rows.findLast((x) => x.ts >= afterTs);
    if (found?.message) return found.message;
    await sleep(75);
  }
  return "";
}

async function sendConsoleLog(client, guildId, serverId, payload) {
  if (!guildId || !serverId) return;
  await sendConfiguredLog(client, guildId, serverId, "console", payload);
}

function buildSuccessReplyEmbed(serverName, results) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Console Commands Executed");

  const resultLines = results
    .map((r, i) => `${i + 1}. \`${safe(r.command, 120)}\` – ${r.success ? "Success" : "Failed"}`)
    .join("\n");

  embed.setDescription(resultLines || "No commands.");

  embed.addFields(
    { name: "Server", value: safe(serverName, 100), inline: true },
    { name: "Total Commands", value: `${results.length}`, inline: true },
    {
      name: "Status",
      value: `Success: ${results.filter((r) => r.success).length} | Failed: ${results.filter((r) => !r.success).length}`,
      inline: true,
    }
  );

  return embed;
}

function buildLogEmbed({ author, serverName, commands, success, successCount, failCount, reason, failedRows }) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Console Log")
    .addFields(
      { name: "Status", value: success ? "✅ Success" : "❌ Failed", inline: true },
      { name: "User", value: `<@${author.id}>`, inline: true },
      { name: "Server", value: safe(serverName || "Unknown", 100), inline: true },
      { name: "Results", value: `✅ ${successCount} | ❌ ${failCount}`, inline: true },
      { name: "Commands", value: `${commands.length}`, inline: true },
      { name: "Reason", value: safe(reason || "None", 500), inline: false }
    )
    .setTimestamp();

  const commandList = commands
    .map((c, i) => `${i + 1}. \`${safe(c, 200)}\``)
    .join("\n")
    .slice(0, 1000);

  if (commandList) {
    embed.addFields({ name: "Command(s)", value: commandList });
  }

  if (failedRows.length) {
    embed.addFields({
      name: "Failed Response(s)",
      value: failedRows
        .slice(0, 5)
        .map((row, i) => `**${i + 1}.** \`${safe(row.command, 120)}\`\n\`${safe(row.response, 250)}\``)
        .join("\n\n")
        .slice(0, 1000),
    });
  }

  return embed;
}

// ── Slash /console helpers ────────────────────────────────────────────────────

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function buildSlashSuccessEmbed(serverName, command, success) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Console Command Executed")
    .setDescription(`1. \`${safe(command, 120)}\` – ${success ? "Success" : "Failed"}`)
    .addFields(
      { name: "Server", value: safe(serverName, 100), inline: true },
      { name: "Total Commands", value: "1", inline: true },
      {
        name: "Status",
        value: `Success: ${success ? 1 : 0} | Failed: ${success ? 0 : 1}`,
        inline: true,
      }
    );
  return embed;
}

module.exports = {
  name: "console",

  init(client, rce) {
    const recentConsole = new Map();

    // ── RCE message listener (shared by both !console and /console) ──────────
    if (rce && typeof rce.on === "function") {
      rce.on(RCEEvent.Message, (payload) => {
        try {
          const serverId = payload?.server?.identifier;
          const message = String(payload?.message || "");
          if (!serverId || !message) return;

          const arr = recentConsole.get(serverId) || [];
          arr.push({ ts: Date.now(), message });
          if (arr.length > 100) arr.splice(0, arr.length - 100);
          recentConsole.set(serverId, arr);
        } catch {}
      });
    }

    // ── /console slash command ────────────────────────────────────────────────
    client.on("interactionCreate", async (interaction) => {
      try {
        // Autocomplete for server option
        if (interaction.isAutocomplete() && interaction.commandName === "console") {
          const focused = interaction.options.getFocused(true);
          if (focused.name === "server") {
            const { listServers } = require("../rce");
            const q = norm(focused.value);
            const choices = listServers()
              .map((s) => ({
                name: (s.displayName || s.identifier).slice(0, 100),
                value: s.identifier,
              }))
              .filter((c) => c.name.toLowerCase().includes(q))
              .slice(0, 25);
            await interaction.respond(choices).catch(() => {});
          }
          return;
        }

        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "console") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", ephemeral: true }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const command = interaction.options.getString("command", true).trim();

        const member =
          interaction.member ||
          (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

        // ── Permission check ─────────────────────────────────────────────────
        if (!hasConsoleAccess(member)) {
          const roleName = getRoleNames(interaction.guild);

          const denyEmbed = new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle("Permission Denied")
            .setDescription(`You must have the \`${roleName}\` role to use this command!`);

          // Visible to everyone — no ephemeral
          await interaction.reply({ embeds: [denyEmbed] }).catch(() => {});

          // Log the denied attempt
          const { listServers } = require("../rce");
          const allServers = listServers();
          const matchedServer = allServers.find((s) => s.identifier === serverId);
          if (matchedServer) {
            await sendConsoleLog(client, interaction.guildId, serverId, {
              embeds: [
                buildLogEmbed({
                  author: interaction.user,
                  serverName: matchedServer.displayName || matchedServer.identifier,
                  commands: [command],
                  success: false,
                  successCount: 0,
                  failCount: 1,
                  reason: "User tried to use console without access",
                  failedRows: [],
                }),
              ],
            });
          }
          return;
        }

        // ── Find server ──────────────────────────────────────────────────────
        const { listServers } = require("../rce");
        const allServers = listServers();
        const matchedServer = allServers.find((s) => s.identifier === serverId);

        if (!matchedServer) {
          await interaction.reply({ content: `:x: Server not found.` }).catch(() => {});
          return;
        }

        // Defer — reply will be visible to everyone
        await interaction.deferReply().catch(() => {});

        const startedAt = Date.now();

        let sendResp = "";
        try {
          sendResp = await rce.sendCommand(matchedServer.identifier, command);
        } catch (e) {
          sendResp = String(e?.message || e || "");
        }

        const recentText = await waitForRecentServerMessage(
          recentConsole,
          matchedServer.identifier,
          startedAt,
          800
        );
        const finalResp = pickResponseText(sendResp, recentText);
        const success = !sendResp && !recentText ? true : !isFailureResponse(finalResp);

        const serverName = matchedServer.displayName || matchedServer.identifier;

        const replyEmbed = buildSlashSuccessEmbed(serverName, command, success);
        replyEmbed
          .setFooter({
            text: `Requested by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [replyEmbed] }).catch(() => {});

        await sendConsoleLog(client, interaction.guildId, matchedServer.identifier, {
          embeds: [
            buildLogEmbed({
              author: interaction.user,
              serverName,
              commands: [command],
              success,
              successCount: success ? 1 : 0,
              failCount: success ? 0 : 1,
              reason: success ? "Command processed successfully" : "Command may have failed",
              failedRows: success
                ? []
                : [{ command, response: finalResp }],
            }),
          ],
        });
      } catch (e) {
        console.error("[console/slash] error:", e);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "Error. Check console." }).catch(() => {});
          } else {
            await interaction.reply({ content: "Error. Check console." }).catch(() => {});
          }
        } catch {}
      }
    });

    // ── !console prefix command (unchanged) ──────────────────────────────────
    client.on("messageCreate", async (message) => {
      try {
        if (!message.guild || message.author.bot) return;
        if (!String(message.content || "").trim().toLowerCase().startsWith("!console")) return;

        const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
        const lines = normalizeLines(message.content);

        const serverDisplayName = parseFirstLine(lines[0]);
        const commands = lines.slice(1).filter(Boolean);

        const { listServers } = require("../rce");
        const allServers = listServers();

        let matchedServer = null;
        if (serverDisplayName) {
          matchedServer = allServers.find(
            (s) => String(s?.displayName || "").trim().toLowerCase() === serverDisplayName.toLowerCase()
          );
        }

        // ── No access ────────────────────────────────────────────────────────
        if (!hasConsoleAccess(member)) {
          const roleName = getRoleNames(message.guild);

          if (!serverDisplayName) {
            await message
              .reply(
                "No commands provided. Use format:\n```\n!console servername\n\ncommand1\ncommand2\ncommand3\n```"
              )
              .catch(() => {});
            return;
          }

          const denyEmbed = new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle("Permission Denied")
            .setDescription(`You must have the \`${roleName}\` role to use this command!`);

          await message.reply({ embeds: [denyEmbed] }).catch(() => {});

          if (matchedServer) {
            await sendConsoleLog(client, message.guild.id, matchedServer.identifier, {
              embeds: [
                buildLogEmbed({
                  author: message.author,
                  serverName: matchedServer.displayName || matchedServer.identifier,
                  commands,
                  success: false,
                  successCount: 0,
                  failCount: commands.length || 1,
                  reason: "User tried to use console without access",
                  failedRows: [],
                }),
              ],
            });
          }

          return;
        }

        // ── Has access but no server name given ──────────────────────────────
        if (!serverDisplayName) {
          await message
            .reply(
              "No commands provided. Use format:\n```\n!console servername\n\ncommand1\ncommand2\ncommand3\n```"
            )
            .catch(() => {});
          return;
        }

        // ── Has access, server name given, but no commands ───────────────────
        if (!commands.length) {
          await message
            .reply(
              "No commands provided. Use format:\n```\n!console servername\n\ncommand1\ncommand2\ncommand3\n```"
            )
            .catch(() => {});

          if (matchedServer) {
            await sendConsoleLog(client, message.guild.id, matchedServer.identifier, {
              embeds: [
                buildLogEmbed({
                  author: message.author,
                  serverName: matchedServer.displayName || matchedServer.identifier,
                  commands: [],
                  success: false,
                  successCount: 0,
                  failCount: 1,
                  reason: "No commands provided",
                  failedRows: [],
                }),
              ],
            });
          }

          return;
        }

        // ── Server not found ─────────────────────────────────────────────────
        if (!matchedServer) {
          await message.reply(`:x: Server \`${serverDisplayName}\` was not found.`).catch(() => {});
          return;
        }

        // ── Send commands ────────────────────────────────────────────────────
        const sendingMsg = await message.reply("Sending...").catch(() => null);

        const results = [];

        for (const cmd of commands) {
          const startedAt = Date.now();

          let sendResp = "";
          try {
            sendResp = await rce.sendCommand(matchedServer.identifier, cmd);
          } catch (e) {
            sendResp = String(e?.message || e || "");
          }

          const recentText = await waitForRecentServerMessage(recentConsole, matchedServer.identifier, startedAt, 800);
          const finalResp = pickResponseText(sendResp, recentText);
          const success = !sendResp && !recentText ? true : !isFailureResponse(finalResp);

          results.push({ command: cmd, response: finalResp, success });

          await sleep(100);
        }

        if (sendingMsg) await sendingMsg.delete().catch(() => {});

        const successCount = results.filter((r) => r.success).length;
        const failCount = results.filter((r) => !r.success).length;
        const failedRows = results.filter((r) => !r.success);

        const replyEmbed = buildSuccessReplyEmbed(
          matchedServer.displayName || matchedServer.identifier,
          results
        );

        replyEmbed
          .setFooter({
            text: `Requested by ${message.author.username}`,
            iconURL: message.author.displayAvatarURL({ dynamic: true }),
          })
          .setTimestamp();

        await message.reply({ embeds: [replyEmbed] }).catch(() => {});

        await sendConsoleLog(client, message.guild.id, matchedServer.identifier, {
          embeds: [
            buildLogEmbed({
              author: message.author,
              serverName: matchedServer.displayName || matchedServer.identifier,
              commands,
              success: failCount === 0,
              successCount,
              failCount,
              reason: failCount === 0 ? "All commands processed successfully" : "One or more commands failed",
              failedRows: failedRows.map((r) => ({ command: r.command, response: r.response })),
            }),
          ],
        });
      } catch (e) {
        console.error("[console] error:", e);
        await message.reply("Error. Check console.").catch(() => {});
      }
    });
  },
};
