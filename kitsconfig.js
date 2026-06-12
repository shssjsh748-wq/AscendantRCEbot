// modules/kitsconfig.js
const fs = require("fs");
const path = require("path");

const {
  ContainerBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const { listServers } = require("./rce");

const ROLES_PATH = path.join(__dirname, "roles.json");
const KITS_CFG_PATH = path.join(__dirname, "kits_config.json");

function log(...a) { console.log("[kitsconfig]", ...a); }
function logErr(...a) { console.error("[kitsconfig]", ...a); }

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
function isOwner(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasDiscordAdmin);
}

function readKitsCfg() {
  return readJsonSafe(KITS_CFG_PATH, {});
}
function writeKitsCfg(data) {
  writeJsonSafe(KITS_CFG_PATH, data);
}
function ensureGuildServer(obj, guildId, serverId) {
  if (!obj[guildId]) obj[guildId] = {};
  if (!obj[guildId][serverId]) obj[guildId][serverId] = { kits: [] };
  if (!Array.isArray(obj[guildId][serverId].kits)) obj[guildId][serverId].kits = [];
  return obj[guildId][serverId];
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function parseKitListResponse(resp) {
  const text = String(resp || "");
  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

  const cleaned = [];
  for (const line of lines) {
    if (/kit\s+list/i.test(line)) continue;
    if (/^\:log\:/i.test(line) && /kit\s+list/i.test(line)) continue;
    cleaned.push(line);
  }

  const seen = new Set();
  const out = [];
  for (const k of cleaned) {
    const key = norm(k);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

function buildPickContainer({ titleLine, options1, options2 }) {
  const c = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents((t) =>
      t.setContent([`## **${titleLine}**`, `Select the in-game kit name from the dropdown.`].join("\n"))
    )
    .addSeparatorComponents((s) => s);

  const row1 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("kits_pick_1")
      .setPlaceholder("Select a kit (1)")
      .addOptions(options1)
      .setMinValues(1)
      .setMaxValues(1)
  );
  c.addActionRowComponents(() => row1);

  if (options2 && options2.length) {
    const row2 = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("kits_pick_2")
        .setPlaceholder("Select a kit (2)")
        .addOptions(options2)
        .setMinValues(1)
        .setMaxValues(1)
    );
    c.addActionRowComponents(() => row2);
  }

  const rowBtns = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("kits_pick_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  c.addActionRowComponents(() => rowBtns);

  return c;
}

// userId -> { guildId, serverId, displayName, cooldownHours, roleId, createdAt }
const pending = new Map();

module.exports = {
  name: "kitsconfig",

  init(client, rce) {


    // AUTOCOMPLETE: /kits-config server (add/remove)
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isAutocomplete()) return;
        if (interaction.commandName !== "kits-config") return;

        const sub = interaction.options.getSubcommand(false);
        if (sub !== "add" && sub !== "remove") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const servers = listServers();
        const q = norm(focused.value);

        const choices = servers
          .map((s) => ({ name: (s.displayName || s.identifier).slice(0, 100), value: s.identifier }))
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 25);

        await interaction.respond(choices).catch((e) => {
          logErr("autocomplete respond failed:", e?.code || e?.message || e);
        });
      } catch (e) {
        logErr("autocomplete error:", e?.message || e);
      }
    });

    // /kits-config add/remove
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "kits-config") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }
        if (!isOwner(interaction)) {
          return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();
        const serverId = interaction.options.getString("server", true);

        const exists = listServers().some((s) => s.identifier === serverId);
        if (!exists) return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });

        if (sub === "add") {
          const displayName = interaction.options.getString("name", true).trim();
          const cooldownHours = interaction.options.getInteger("cooldown", true);
          const role = interaction.options.getRole("role", true);

          pending.set(interaction.user.id, {
            guildId: interaction.guildId,
            serverId,
            displayName,
            cooldownHours,
            roleId: role.id,
            createdAt: Date.now(),
          });

          log("add start", { guildId: interaction.guildId, serverId, by: interaction.user.id, displayName });

          // legacy ephemeral "loading"
          await interaction.reply({ content: "Fetching kit list from server...", flags: MessageFlags.Ephemeral });

          const resp = await rce.sendCommand(serverId, "kit list").catch((e) => {
            logErr("rce.sendCommand kit list failed:", e?.message || e);
            return null;
          });

          const kits = parseKitListResponse(resp);
          log("kit list parsed", { serverId, count: kits.length });

          if (!kits.length) {
            pending.delete(interaction.user.id);
            return interaction.editReply({ content: "No kits returned from `kit list` (check server perms/output)." });
          }

          const hardCap = 50;
          const sliced = kits.slice(0, hardCap);
          const opts = sliced.map((k) => ({ label: k.slice(0, 100), value: k.slice(0, 100) }));

          const options1 = opts.slice(0, 25);
          const options2 = opts.slice(25, 50);

          const container = buildPickContainer({
            titleLine: `Pick an in-game kit for: ${displayName}`,
            options1,
            options2,
          });

          // IMPORTANT: send V2 as a NEW message (followUp), do NOT editReply into V2
          await interaction.followUp({
            components: [container],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });

          // clean up the loading line
          return interaction.editReply({ content: "Kit list loaded. Pick from the menu above." });
        }

        if (sub === "remove") {
          const nameInput = interaction.options.getString("name", true);
          const needle = norm(nameInput);

          const cfg = readKitsCfg();
          const row = ensureGuildServer(cfg, interaction.guildId, serverId);

          const before = row.kits.length;
          row.kits = row.kits.filter((k) => norm(k?.name) !== needle);
          const after = row.kits.length;

          writeKitsCfg(cfg);

          log("remove", { guildId: interaction.guildId, serverId, nameInput, removed: before - after });

          client.emit("kits:refreshPanels", { guildId: interaction.guildId, serverId });

          return interaction.reply({
            content: before === after ? "No kit matched that name." : `Removed **${before - after}** kit(s).`,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        logErr("command error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        }
      }
    });

    // picker select + cancel
    client.on("interactionCreate", async (interaction) => {
      try {
        const isPick =
          interaction.isStringSelectMenu() &&
          (interaction.customId === "kits_pick_1" || interaction.customId === "kits_pick_2");
        const isCancel = interaction.isButton() && interaction.customId === "kits_pick_cancel";
        if (!isPick && !isCancel) return;

        await interaction.deferUpdate().catch(() => {});

        if (isCancel) {
          pending.delete(interaction.user.id);
          // V2-safe close: NO content, just remove components
          await interaction.update({ components: [] }).catch(() => {});
          return interaction.followUp({ content: "Cancelled.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const p = pending.get(interaction.user.id);
        if (!p || p.guildId !== interaction.guildId) {
          await interaction.update({ components: [] }).catch(() => {});
          return interaction.followUp({ content: "This kit selection expired.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        if (Date.now() - p.createdAt > 120_000) {
          pending.delete(interaction.user.id);
          await interaction.update({ components: [] }).catch(() => {});
          return interaction.followUp({ content: "This kit selection expired.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const ingameKit = interaction.values?.[0];
        if (!ingameKit) {
          await interaction.update({ components: [] }).catch(() => {});
          return interaction.followUp({ content: "No kit selected.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const cfg = readKitsCfg();
        const row = ensureGuildServer(cfg, p.guildId, p.serverId);

        const idx = row.kits.findIndex((k) => norm(k?.name) === norm(p.displayName));
        const entry = {
          name: p.displayName,
          ingameKit,
          cooldownHours: p.cooldownHours,
          roleId: p.roleId,
          addedBy: interaction.user.id,
          addedAt: Date.now(),
        };

        if (idx !== -1) row.kits[idx] = entry;
        else row.kits.push(entry);

        writeKitsCfg(cfg);
        pending.delete(interaction.user.id);

        log("add saved", { guildId: p.guildId, serverId: p.serverId, name: p.displayName, ingameKit });

        client.emit("kits:refreshPanels", { guildId: p.guildId, serverId: p.serverId });

        // close picker (no content), confirm with followUp
        await interaction.update({ components: [] }).catch(() => {});
        return interaction
          .followUp({ content: `Saved kit: **${p.displayName}** → **${ingameKit}**`, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      } catch (e) {
        logErr("picker error:", e?.message || e);
        try {
          if (interaction.isRepliable()) {
            await interaction.followUp({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        } catch {}
      }
    });
  },
};