// events/nuketown/nuketownconfig.js
const fs = require("fs");
const path = require("path");
const {
  ContainerBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { listServers } = require("./rce");
const { readLinks } = require("./links");
const ROLES_PATH = path.join(__dirname, "roles.json");
const SPAWNS_PATH = path.join(__dirname, "nuketownspawns.json");
const ADV_PATH = path.join(__dirname, "nuketownadvanced.json");

const BLUE = 0x95a5a6;
const activePanels = new Map(); // messageId -> state

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function getRolesCfg() {
  return readJsonSafe(ROLES_PATH, {});
}

function isAdminOrOwner(member) {
  const cfg = getRolesCfg();
  const adminRoleId = cfg?.adminRoleId;
  const ownerRoleId = cfg?.ownerRoleId;

  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (adminRoleId && member?.roles?.cache?.has(adminRoleId)) return true;
  if (ownerRoleId && member?.roles?.cache?.has(ownerRoleId)) return true;
  return false;
}

function getLinkedGamertag(userId, guildId) {
  const data = readLinks();

  const a = data?.[guildId]?.[userId] || data?.[userId];
  if (!a) return null;

  if (typeof a === "string") return a;
  if (typeof a?.gamertag === "string") return a.gamertag;
  if (typeof a?.gt === "string") return a.gt;
  if (typeof a?.xbox === "string") return a.xbox;
  if (typeof a?.playerName === "string") return a.playerName;
  if (typeof a?.player === "string") return a.player;
  if (typeof a?.name === "string") return a.name;

  return null;
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function parsePrintPos(resp) {
  const t = String(resp ?? "");
  const m = t.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function readSavedConfig(guildId, serverId) {
  const all = readJsonSafe(SPAWNS_PATH, {});
  const entry = all?.[guildId]?.[serverId];

  return {
    spawns: entry?.spawns && typeof entry.spawns === "object" ? entry.spawns : {},
    middlePoint: entry?.middlePoint && typeof entry.middlePoint === "object" ? entry.middlePoint : null,
  };
}

function writeSavedConfig(guildId, serverId, { spawns, middlePoint }, userId) {
  const all = readJsonSafe(SPAWNS_PATH, {});
  if (!all[guildId]) all[guildId] = {};

  all[guildId][serverId] = {
    spawns: spawns || {},
    middlePoint: middlePoint || null,
    updatedAt: Date.now(),
    updatedBy: userId,
  };

  writeJsonSafe(SPAWNS_PATH, all);
}

function resetSavedConfig(guildId, serverId) {
  const all = readJsonSafe(SPAWNS_PATH, {});
  if (all?.[guildId]?.[serverId]) delete all[guildId][serverId];
  writeJsonSafe(SPAWNS_PATH, all);
}

function readAdvanced(guildId, serverId) {
  const all = readJsonSafe(ADV_PATH, {});
  const s = all?.[guildId]?.[serverId];
  return s && typeof s === "object" ? s : {};
}

function writeAdvanced(guildId, serverId, patch, userId) {
  const all = readJsonSafe(ADV_PATH, {});
  if (!all[guildId]) all[guildId] = {};
  const cur =
    all[guildId][serverId] && typeof all[guildId][serverId] === "object"
      ? all[guildId][serverId]
      : {};

  all[guildId][serverId] = {
    ...cur,
    ...patch,
    updatedAt: Date.now(),
    updatedBy: userId,
  };

  writeJsonSafe(ADV_PATH, all);
}

function parseKitList(resp) {
  const text = String(resp ?? "").replace(/\r/g, "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const out = [];
  for (const l of lines) {
    const low = l.toLowerCase();
    if (low.includes("kit list")) continue;
    if (low.startsWith("log:")) continue;
    if (low.startsWith("[kitmanager]")) continue;
    out.push(l);
  }

  const seen = new Set();
  const unique = [];
  for (const k of out) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(k);
  }

  return unique;
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function getTeamZoneName(n) {
  return `Nuketown <color=orange>[Team ${n}]`;
}

function buildSpawnsPanel(state) {
  const c = new ContainerBuilder().setAccentColor(BLUE);

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        "***NUKETOWN EVENT - CONFIGURE SPAWNS***",
        "> ✅ Click the buttons below to configure ***NUKETOWN EVENT*** spawn points",
        "> You must be ingame to configure spawns",
      ].join("\n")
    )
  );

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder()
        .setCustomId("nuketown_set_middle")
        .setLabel(state.middlePoint ? "Middle point set" : "Set middle point")
        .setEmoji("🏰")
        .setStyle(ButtonStyle.Primary)
    )
  );

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder()
        .setCustomId("nuketown_spawn_1")
        .setLabel(state.spawns?.[1] ? "✅ Spawn 1" : "Spawn 1")
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(state.spawns?.[1])),
      new ButtonBuilder()
        .setCustomId("nuketown_spawn_2")
        .setLabel(state.spawns?.[2] ? "✅ Spawn 2" : "Spawn 2")
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(state.spawns?.[2]))
    )
  );

  c.addSeparatorComponents((s) => s);

  const lines = [];

  if (state.middlePoint) {
    lines.push(`Middle Point: X: ${state.middlePoint.x} Y: ${state.middlePoint.y} Z: ${state.middlePoint.z}`);
    lines.push("");
  }

  if (state.spawns?.[1]) {
    const p = state.spawns[1];
    lines.push(`Spawn 1: X: ${p.x} Y: ${p.y} Z: ${p.z}`);
  }

  if (state.spawns?.[2]) {
    const p = state.spawns[2];
    lines.push(`Spawn 2: X: ${p.x} Y: ${p.y} Z: ${p.z}`);
  }

  if (lines.length) c.addTextDisplayComponents((t) => t.setContent(lines.join("\n")));

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder().setCustomId("nuketown_confirm").setLabel("Confirm").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("nuketown_reset").setLabel("Reset Configs").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("nuketown_next").setLabel("Next").setStyle(ButtonStyle.Primary)
    )
  );

  return c;
}

function buildAdvancedPanel(state) {
  const c = new ContainerBuilder().setAccentColor(BLUE);

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        "***NUKETOWN EVENT - ADVANCED CONFIGURATION***",
        "> ✅ Click the buttons below to configure the ***NUKETOWN EVENT*** variables",
        "> Some features here require RF Broadcasters to be setup.",
      ].join("\n")
    )
  );

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder().setCustomId("nuketown_adv_choosekit").setLabel("Choose Kit").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("nuketown_adv_setrf").setLabel("Set RF Frequency").setStyle(ButtonStyle.Success)
    )
  );

  c.addSectionComponents((section) =>
    section
      .addTextDisplayComponents((t) =>
        t.setContent(
          "If you don't have a kit setup for the Nuketown event click this button and we will make a kit for you in seconds"
        )
      )
      .setButtonAccessory((b) =>
        b.setCustomId("nuketown_adv_createkit").setLabel("Create Kit").setStyle(ButtonStyle.Success)
      )
  );

  c.addSeparatorComponents((s) => s);

  const kit = state.advanced?.kitName;
  const rf = state.advanced?.rfFrequency;

  const lines = [];
  if (kit) lines.push(`Nuketown Kit: **${kit}**`);
  if (rf) lines.push(`RF Frequency: **${rf}**`);
  if (lines.length) c.addTextDisplayComponents((t) => t.setContent(lines.join("\n")));

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder().setCustomId("nuketown_adv_back").setLabel("Go Back").setStyle(ButtonStyle.Secondary)
    )
  );

  return c;
}

function buildContainer(state) {
  return state.view === "advanced" ? buildAdvancedPanel(state) : buildSpawnsPanel(state);
}

async function updatePublicMessage(interactionOrClient, state) {
  const payload = {
    content: "",
    flags: MessageFlags.IsComponentsV2,
    components: [buildContainer(state)],
  };

  if (interactionOrClient?.isButton?.()) {
    return interactionOrClient.update(payload).catch(() => {});
  }

  const client = interactionOrClient?.client || interactionOrClient;
  const channel = await client.channels.fetch(state.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(state.messageId).catch(() => null);
  if (!msg) return;

  await msg.edit(payload).catch(() => {});
}

module.exports = {
  name: "nuketownconfig",

  init(client, rce) {
    readJsonSafe(SPAWNS_PATH, {});
    readJsonSafe(ADV_PATH, {});

    client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName !== "event-config") return;
        if (interaction.options.getSubcommand(false) !== "nuketown-spawns") return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== "server") return;

        const q = String(focused.value || "").toLowerCase().trim();
        const servers = listServers();

        const choices = servers
          .map((s) => ({
            name: (s.displayName || s.identifier).slice(0, 100),
            value: s.identifier,
          }))
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 25);

        return interaction.respond(choices).catch(() => {});
      }

      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "event-config") return;
        if (interaction.options.getSubcommand() !== "nuketown-spawns") return;
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server." }).catch(() => {});
        }

        if (!isAdminOrOwner(interaction.member)) {
          return interaction.reply({ content: "No permission.", ephemeral: true }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const serverExists = listServers().some((s) => s.identifier === serverId);
        if (!serverExists) {
          return interaction.reply({ content: "Server not found.", ephemeral: true }).catch(() => {});
        }

        const gamertag = getLinkedGamertag(interaction.user.id, interaction.guildId);
        if (!gamertag) {
          return interaction.reply({ content: "You must be linked to use this.", ephemeral: true }).catch(() => {});
        }

        await interaction.deferReply().catch(() => {});

        const savedCfg = readSavedConfig(interaction.guildId, serverId);

        const state = {
          ownerId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          messageId: null,
          serverId,
          gamertag,
          view: "spawns",
          spawns: savedCfg.spawns || {},
          middlePoint: savedCfg.middlePoint || null,
          advanced: readAdvanced(interaction.guildId, serverId) || {},
        };

        const payload = {
          content: "",
          flags: MessageFlags.IsComponentsV2,
          components: [buildContainer(state)],
        };

        await interaction.editReply(payload).catch(() => {});

        const msg = await interaction.fetchReply().catch(() => null);
        if (msg?.id) {
          state.messageId = msg.id;
          activePanels.set(msg.id, state);
        }
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (!interaction.customId.startsWith("nuketown_kit_")) return;

        const parts = interaction.customId.split("_");
        const messageId = parts[2];
        const state = activePanels.get(messageId);
        if (!state) return;

        if (interaction.user.id !== state.ownerId) {
          return interaction.reply({ content: "Only the panel owner can use this.", ephemeral: true }).catch(() => {});
        }

        const selected = interaction.values?.[0];
        if (!selected) return;

        state.advanced = state.advanced || {};
        state.advanced.kitName = selected;

        writeAdvanced(state.guildId, state.serverId, { kitName: selected }, state.ownerId);

        await interaction.update({ content: `✅ Selected kit: **${selected}**`, components: [] }).catch(() => {});
        await updatePublicMessage(interaction.client, state);
        return;
      }

      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith("nuketown_rf_")) return;

        const messageId = interaction.customId.slice("nuketown_rf_".length);
        const state = activePanels.get(messageId);
        if (!state) return;

        if (interaction.user.id !== state.ownerId) {
          return interaction.reply({ content: "Only the panel owner can use this.", ephemeral: true }).catch(() => {});
        }

        const freq = String(interaction.fields.getTextInputValue("freq") || "").trim();
        if (!freq) {
          return interaction.reply({ content: "Invalid frequency.", ephemeral: true }).catch(() => {});
        }

        state.advanced = state.advanced || {};
        state.advanced.rfFrequency = freq;

        writeAdvanced(state.guildId, state.serverId, { rfFrequency: freq }, state.ownerId);

        await interaction.reply({ content: `✅ RF Frequency set to **${freq}**`, ephemeral: true }).catch(() => {});
        await updatePublicMessage(interaction.client, state);
        return;
      }

      if (!interaction.isButton()) return;

      const state = activePanels.get(interaction.message?.id);
      if (!state) return;

      if (interaction.user.id !== state.ownerId) {
        return interaction.reply({ content: "Only the panel owner can use this.", ephemeral: true }).catch(() => {});
      }

      if (interaction.customId === "nuketown_set_middle") {
        await interaction.deferUpdate().catch(() => {});

        const resp = await rce
          .sendCommand(state.serverId, `printpos "${escapeQuotes(state.gamertag)}"`)
          .catch(() => null);

        const pos = parsePrintPos(resp);
        if (!pos) {
          return interaction.followUp({
            content: "Could not read your position. You must be ingame.",
            ephemeral: true,
          }).catch(() => {});
        }

        state.middlePoint = pos;

        await updatePublicMessage(interaction.client, state);
        await interaction.followUp({ content: "✅ Middle point set.", ephemeral: true }).catch(() => {});
        return;
      }

      if (interaction.customId.startsWith("nuketown_spawn_")) {
        const n = Number(interaction.customId.split("_").pop());
        if (![1, 2].includes(n)) return;

        const resp = await rce
          .sendCommand(state.serverId, `printpos "${escapeQuotes(state.gamertag)}"`)
          .catch(() => null);

        const pos = parsePrintPos(resp);
        if (!pos) {
          return interaction.reply({ content: "Could not read your position. You must be ingame.", ephemeral: true }).catch(() => {});
        }

        state.spawns[n] = pos;

        const zoneName = getTeamZoneName(n);

        await rce
          .sendCommand(state.serverId, `createcustomzone "${zoneName}" (${pos.x},${pos.y},${pos.z}) 45 sphere 12`)
          .catch(() => null);

        await rce
          .sendCommand(state.serverId, `editcustomzone "${zoneName}" color (143,237,143)`)
          .catch(() => null);

        await updatePublicMessage(interaction, state);
        return;
      }

      if (interaction.customId === "nuketown_confirm") {
        writeSavedConfig(
          state.guildId,
          state.serverId,
          { spawns: state.spawns || {}, middlePoint: state.middlePoint || null },
          state.ownerId
        );

        return interaction.reply({
          content: `Saved ${Object.keys(state.spawns || {}).length} spawn(s).`,
          ephemeral: true,
        }).catch(() => {});
      }

      if (interaction.customId === "nuketown_reset") {
        await interaction.deferUpdate().catch(() => {});

        for (const spawnNum of Object.keys(state.spawns || {})) {
          const n = Number(spawnNum);
          if (![1, 2].includes(n)) continue;
          const zoneName = getTeamZoneName(n);
          // eslint-disable-next-line no-await-in-loop
          await rce.sendCommand(state.serverId, `deletecustomzone "${zoneName}"`).catch(() => null);
        }

        state.spawns = {};
        state.middlePoint = null;

        resetSavedConfig(state.guildId, state.serverId);

        await updatePublicMessage(interaction.client, state);
        await interaction.followUp({
          content: "✅ Nuketown configs reset and zones deleted.",
          ephemeral: true,
        }).catch(() => {});
        return;
      }

      if (interaction.customId === "nuketown_next") {
        state.view = "advanced";
        state.advanced = readAdvanced(state.guildId, state.serverId) || state.advanced || {};
        await updatePublicMessage(interaction, state);
        return;
      }

      if (interaction.customId === "nuketown_adv_back") {
        state.view = "spawns";
        const savedCfg = readSavedConfig(state.guildId, state.serverId);
        state.spawns = savedCfg.spawns || state.spawns || {};
        state.middlePoint = savedCfg.middlePoint || state.middlePoint || null;
        await updatePublicMessage(interaction, state);
        return;
      }

      if (interaction.customId === "nuketown_adv_choosekit") {
        await interaction.reply({ content: "Loading Panel...", ephemeral: true }).catch(() => {});

        const resp = await rce.sendCommand(state.serverId, "kit list").catch(() => null);
        const kits = parseKitList(resp);

        if (!kits.length) {
          return interaction.editReply({ content: "No kits found.", components: [] }).catch(() => {});
        }

        const chunks = chunk(kits, 25);

        const rows = chunks.slice(0, 5).map((group, idx) => {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`nuketown_kit_${state.messageId}_${idx}`)
            .setPlaceholder("Select a kit")
            .addOptions(
              group.map((k) => ({
                label: String(k).slice(0, 100),
                value: String(k).slice(0, 100),
              }))
            );

          return new ActionRowBuilder().addComponents(menu);
        });

        return interaction.editReply({ content: "Select a kit:", components: rows }).catch(() => {});
      }

      if (interaction.customId === "nuketown_adv_setrf") {
        const modal = new ModalBuilder()
          .setCustomId(`nuketown_rf_${state.messageId}`)
          .setTitle("Set RF Frequency");

        const input = new TextInputBuilder()
          .setCustomId("freq")
          .setLabel("RF Frequency")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 1234");

        modal.addComponents(new ActionRowBuilder().addComponents(input));

        return interaction.showModal(modal).catch(() => {});
      }

      if (interaction.customId === "nuketown_adv_createkit") {
        await interaction.reply({ content: "Creating Kit...", ephemeral: true }).catch(() => {});

        const list1 = await rce.sendCommand(state.serverId, "kit list").catch(() => null);
        const kits = parseKitList(list1);

        const exists = kits.some((k) => String(k).trim().toLowerCase() === "nuke");
        if (exists) {
          return interaction.editReply({ content: "❌ There is already a kit named **NUKE**" }).catch(() => {});
        }

        const cmds = [
          `kit add "NUKE" "metal.plate.torso" 1 1 "wear"`,
          `kit add "NUKE" "metal.facemask" 1 1 "wear"`,
          `kit add "NUKE" "roadsign.kilt" 1 1 "wear"`,
          `kit add "NUKE" "tactical.gloves" 1 1 "wear"`,
          `kit add "NUKE" "hoodie" 1 1 "wear"`,
          `kit add "NUKE" "pants" 1 1 "wear"`,
          `kit add "NUKE" "shoes.boots" 1 1 "wear"`,
          `kit add "NUKE" "weapon.mod.holosight" 1 1 "main"`,
          `kit add "NUKE" "weapon.mod.lasersight" 1 1 "main"`,
          `kit add "NUKE" "weapon.mod.extendedmags" 1 1 "main"`,
          `kit add "NUKE" "ammo.rifle" 356 1 "main"`,
          `kit add "NUKE" "rifle.ak" 1 1 "belt"`,
          `kit add "NUKE" "syringe.medical" 6 1 "belt"`,
          `kit add "NUKE" "syringe.medical" 6 1 "belt"`,
          `kit add "NUKE" "syringe.medical" 6 1 "belt"`,
          `kit add "NUKE" "barricade.wood.cover" 50 1 "belt"`,
        ];

        for (const cmd of cmds) {
          // eslint-disable-next-line no-await-in-loop
          await rce.sendCommand(state.serverId, cmd).catch(() => null);
        }

        const list2 = await rce.sendCommand(state.serverId, "kit list").catch(() => null);
        const kits2 = parseKitList(list2);
        const ok = kits2.some((k) => String(k).trim().toLowerCase() === "nuke");

        if (!ok) {
          return interaction.editReply({ content: "❌ Failed to confirm kit creation. Check KITMANAGER." }).catch(() => {});
        }

        state.advanced = state.advanced || {};
        state.advanced.kitName = "NUKE";
        writeAdvanced(state.guildId, state.serverId, { kitName: "NUKE" }, state.ownerId);
        await updatePublicMessage(interaction.client, state);

        return interaction.editReply({ content: "✅ Kit **NUKE** Successfully created!" }).catch(() => {});
      }
    });
  },
};