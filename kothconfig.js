// events/kothconfig.js
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
const SPAWNS_PATH = path.join(__dirname, "kothspawns.json");
const ADV_PATH = path.join(__dirname, "kothadvanced.json");

const activePanels = new Map(); // messageId -> state

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
  const cur = all[guildId][serverId] && typeof all[guildId][serverId] === "object" ? all[guildId][serverId] : {};
  all[guildId][serverId] = { ...cur, ...patch, updatedAt: Date.now(), updatedBy: userId };
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

  // de-dupe preserving order
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCustomZoneCenter(resp) {
  const t = String(resp ?? "");
  const m = t.match(/Position\s*\[\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\]/i);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function distanceBetween(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
// -------------------- PANELS --------------------

function buildSpawnsPanel(state) {
  const c = new ContainerBuilder().setAccentColor(0x95a5a6);

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        "***KOTH EVENT - CONFIGURE SPAWNS***",
        "> ✅ Click the buttons below to configure ***KOTH EVENT*** spawn points",
        "> You must be ingame to configure spawns",
      ].join("\n")
    )
  );

  c.addSeparatorComponents((s) => s);

    c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder()
        .setCustomId("koth_set_middle")
        .setLabel(state.middlePoint ? "Middle point set" : "Set middle point")
        .setEmoji("🏰")
        .setStyle(ButtonStyle.Primary)
    )
  );
  for (let row = 0; row < 4; row++) {
    const buttons = [];
    for (let col = 0; col < 4; col++) {
      const i = row * 4 + col + 1;
      const done = Boolean(state.spawns?.[i]);

      buttons.push(
        new ButtonBuilder()
          .setCustomId(`koth_spawn_${i}`)
          .setLabel(done ? `✅ Spawn ${i}` : `Spawn ${i}`)
          .setStyle(ButtonStyle.Success)
          .setDisabled(done)
      );
    }
    c.addActionRowComponents((ar) => ar.setComponents(...buttons));
  }

  c.addSeparatorComponents((s) => s);

   const lines = [];

  if (state.middlePoint) {
    lines.push(`Middle Point: X: ${state.middlePoint.x} Y: ${state.middlePoint.y} Z: ${state.middlePoint.z}`);
    lines.push("");
  }

  for (let i = 1; i <= 16; i++) {
    const p = state.spawns?.[i];
    if (p) lines.push(`Spawn ${i}: X: ${p.x} Y: ${p.y} Z: ${p.z}`);
  }

  if (lines.length) c.addTextDisplayComponents((t) => t.setContent(lines.join("\n")));

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder().setCustomId("koth_confirm").setLabel("Confirm").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("koth_reset").setLabel("Reset Configs").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("koth_next").setLabel("Next").setStyle(ButtonStyle.Primary)
    )
  );

  return c;
}

function buildAdvancedPanel(state) {
  const c = new ContainerBuilder().setAccentColor(0x95a5a6);

  c.addTextDisplayComponents((t) =>
    t.setContent(
      [
        "***KOTH EVENT - ADVANCED CONFIGURATION***",
        "> ✅ Click the buttons below to configure the ***KOTH EVENT*** variables",
        "> Some features here require RF Broadcasters to be setup.",
      ].join("\n")
    )
  );

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(
      new ButtonBuilder().setCustomId("koth_adv_choosekit").setLabel("Choose Kit").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("koth_adv_setrf").setLabel("Set RF Frequency").setStyle(ButtonStyle.Success)
    )
  );

  c.addSectionComponents((section) =>
    section
      .addTextDisplayComponents((t) =>
        t.setContent(
          "If you don't have a kit setup for the KOTH event click this button and we will make a kit for you in seconds"
        )
      )
      .setButtonAccessory((b) => b.setCustomId("koth_adv_createkit").setLabel("Create Kit").setStyle(ButtonStyle.Success))
  );

  c.addSeparatorComponents((s) => s);

  const kit = state.advanced?.kitName;
  const rf = state.advanced?.rfFrequency;

  const lines = [];
  if (kit) lines.push(`KOTH Kit: **${kit}**`);
  if (rf) lines.push(`RF Frequency: **${rf}**`);
  if (lines.length) c.addTextDisplayComponents((t) => t.setContent(lines.join("\n")));

  c.addSeparatorComponents((s) => s);

  c.addActionRowComponents((ar) =>
    ar.setComponents(new ButtonBuilder().setCustomId("koth_adv_back").setLabel("Go Back").setStyle(ButtonStyle.Secondary))
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

  // if we can update directly (button on the public message)
  if (interactionOrClient?.isButton?.()) {
    return interactionOrClient.update(payload).catch(() => {});
  }

  // fallback edit by fetch
  const client = interactionOrClient?.client || interactionOrClient;
  const channel = await client.channels.fetch(state.channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(state.messageId).catch(() => null);
  if (!msg) return;

  await msg.edit(payload).catch(() => {});
}

// -------------------- MODULE --------------------

module.exports = {
  name: "kothconfig",

  init(client, rce) {
    readJsonSafe(SPAWNS_PATH, {});
    readJsonSafe(ADV_PATH, {});

    client.on("interactionCreate", async (interaction) => {
      // AUTOCOMPLETE
      if (interaction.isAutocomplete()) {
        if (interaction.commandName !== "event-config") return;
        if (interaction.options.getSubcommand(false) !== "koth-spawns") return;

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

      // COMMAND
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "event-config") return;
        if (interaction.options.getSubcommand() !== "koth-spawns") return;
        if (!interaction.inGuild()) return interaction.reply({ content: "Use this in a server." }).catch(() => {});

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

      // SELECT MENU: kit picker (ephemeral)
      if (interaction.isStringSelectMenu()) {
        if (!interaction.customId.startsWith("koth_kit_")) return;

        const parts = interaction.customId.split("_"); // koth_kit_<messageId>_<chunkIndex>
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

      // MODAL: RF frequency
      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith("koth_rf_")) return;

        const messageId = interaction.customId.slice("koth_rf_".length);
        const state = activePanels.get(messageId);
        if (!state) return;

        if (interaction.user.id !== state.ownerId) {
          return interaction.reply({ content: "Only the panel owner can use this.", ephemeral: true }).catch(() => {});
        }

        const freq = String(interaction.fields.getTextInputValue("freq") || "").trim();
        if (!freq) return interaction.reply({ content: "Invalid frequency.", ephemeral: true }).catch(() => {});

        state.advanced = state.advanced || {};
        state.advanced.rfFrequency = freq;

        writeAdvanced(state.guildId, state.serverId, { rfFrequency: freq }, state.ownerId);

        await interaction.reply({ content: `✅ RF Frequency set to **${freq}**`, ephemeral: true }).catch(() => {});
        await updatePublicMessage(interaction.client, state);
        return;
      }

      // BUTTONS (public panel)
      if (!interaction.isButton()) return;

      const state = activePanels.get(interaction.message?.id);
      if (!state) return;

      if (interaction.user.id !== state.ownerId) {
        return interaction.reply({ content: "Only the panel owner can use this.", ephemeral: true }).catch(() => {});
      }

    if (interaction.customId === "koth_set_middle") {
  await interaction.deferUpdate().catch(() => {});

  const resp = await rce
    .sendCommand(state.serverId, `printpos "${escapeQuotes(state.gamertag)}"`)
    .catch(() => null);

  const pos = parsePrintPos(resp);
  if (!pos) {
    return interaction.followUp({ content: "Could not read your position. You must be ingame.", ephemeral: true }).catch(() => {});
  }

  state.middlePoint = pos;

  await rce.sendCommand(state.serverId, `createcustomzone KOTH (${pos.x},${pos.y},${pos.z}) 45 sphere 60`).catch(() => null);
  await wait(2000);
  await rce.sendCommand(state.serverId, `editcustomzone KOTH color (128.,0.,128.)`).catch(() => null);
  await wait(2000);
  await rce.sendCommand(state.serverId, `editcustomzone "KOTH" "radiationdamage" 300.`).catch(() => null);

  await updatePublicMessage(interaction.client, state);
  await interaction.followUp({ content: "✅ Middle point set.", ephemeral: true }).catch(() => {});
  return;
}
            // SPAWNS: spawn buttons
      if (interaction.customId.startsWith("koth_spawn_")) {
        const n = Number(interaction.customId.split("_").pop());
        if (!Number.isFinite(n) || n < 1 || n > 16) return;

        if (!state.middlePoint) {
          return interaction.reply({ content: "Please set middle point first!", ephemeral: true }).catch(() => {});
        }

        const resp = await rce
          .sendCommand(state.serverId, `printpos "${escapeQuotes(state.gamertag)}"`)
          .catch(() => null);

        const pos = parsePrintPos(resp);
        if (!pos) {
          return interaction.reply({ content: "Could not read your position. You must be ingame.", ephemeral: true }).catch(() => {});
        }

        const zoneInfo = await rce.sendCommand(state.serverId, `customzoneinfo "KOTH"`).catch(() => null);
        const zoneCenter = parseCustomZoneCenter(zoneInfo) || state.middlePoint;

        if (!zoneCenter) {
          return interaction.reply({ content: "Could not read KOTH middle point.", ephemeral: true }).catch(() => {});
        }

        const dist = distanceBetween(pos, zoneCenter);
    if (dist < 60) {
  return interaction
    .reply({
      content: `Too close to middle point, you are ${(60 - dist).toFixed(2)} metres away from an eligible point!`,
      ephemeral: true,
    })
    .catch(() => {});
}

        state.spawns[n] = pos;

        await rce.sendCommand(state.serverId, `createcustomzone "Spawn ${n}" (${pos.x},${pos.y},${pos.z}) 45 sphere 5`).catch(() => null);
        await rce.sendCommand(state.serverId, `editcustomzone "Spawn ${n}" color (143,237,143)`).catch(() => null);

        await updatePublicMessage(interaction, state);
        return;
      }

      // SPAWNS: confirm
      if (interaction.customId === "koth_confirm") {
                writeSavedConfig(
          state.guildId,
          state.serverId,
          { spawns: state.spawns || {}, middlePoint: state.middlePoint || null },
          state.ownerId
        );
        return interaction.reply({ content: `Saved ${Object.keys(state.spawns || {}).length} spawn(s).`, ephemeral: true }).catch(() => {});
      }

      // SPAWNS: reset
        if (interaction.customId === "koth_reset") {
  await interaction.deferUpdate().catch(() => {});

  const configuredSpawns = Object.keys(state.spawns || {});

  if (state.middlePoint) {
    await rce.sendCommand(state.serverId, `deletecustomzone "KOTH"`).catch(() => null);
  }

  for (const spawnNum of configuredSpawns) {
    // eslint-disable-next-line no-await-in-loop
    await rce.sendCommand(state.serverId, `deletecustomzone "Spawn ${spawnNum}"`).catch(() => null);
  }

  state.spawns = {};
  state.middlePoint = null;

  resetSavedConfig(state.guildId, state.serverId);

  await updatePublicMessage(interaction.client, state);
  await interaction.followUp({ content: "✅ KOTH configs reset and zones deleted.", ephemeral: true }).catch(() => {});
  return;
}

      // SPAWNS: next -> advanced panel
      if (interaction.customId === "koth_next") {
        state.view = "advanced";
        state.advanced = readAdvanced(state.guildId, state.serverId) || state.advanced || {};
        await updatePublicMessage(interaction, state);
        return;
      }

      // ADV: go back
            if (interaction.customId === "koth_adv_back") {
        state.view = "spawns";
        const savedCfg = readSavedConfig(state.guildId, state.serverId);
        state.spawns = savedCfg.spawns || state.spawns || {};
        state.middlePoint = savedCfg.middlePoint || state.middlePoint || null;
        await updatePublicMessage(interaction, state);
        return;
      }

      // ADV: choose kit
      if (interaction.customId === "koth_adv_choosekit") {
        await interaction.reply({ content: "Loading Panel...", ephemeral: true }).catch(() => {});

        const resp = await rce.sendCommand(state.serverId, "kit list").catch(() => null);
        const kits = parseKitList(resp);

        if (!kits.length) {
          return interaction.editReply({ content: "No kits found.", components: [] }).catch(() => {});
        }

        const chunks = chunk(kits, 25);

        const rows = chunks.slice(0, 5).map((group, idx) => {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`koth_kit_${state.messageId}_${idx}`)
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

      // ADV: set RF frequency (modal)
      if (interaction.customId === "koth_adv_setrf") {
        const modal = new ModalBuilder().setCustomId(`koth_rf_${state.messageId}`).setTitle("Set RF Frequency");

        const input = new TextInputBuilder()
          .setCustomId("freq")
          .setLabel("RF Frequency")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 1234");

        modal.addComponents(new ActionRowBuilder().addComponents(input));

        return interaction.showModal(modal).catch(() => {});
      }

      // ADV: create kit
      if (interaction.customId === "koth_adv_createkit") {
        await interaction.reply({ content: "Creating Kit...", ephemeral: true }).catch(() => {});

        const list1 = await rce.sendCommand(state.serverId, "kit list").catch(() => null);
        const kits = parseKitList(list1);

        const exists = kits.some((k) => String(k).trim().toLowerCase() === "koth");
        if (exists) {
          return interaction.editReply({ content: "❌ There is already a kit named **KOTH**" }).catch(() => {});
        }

        const cmds = [
          `kit add "KOTH" "metal.plate.torso" 1 1 "wear"`,
          `kit add "KOTH" "metal.facemask" 1 1 "wear"`,
          `kit add "KOTH" "roadsign.kilt" 1 1 "wear"`,
          `kit add "KOTH" "tactical.gloves" 1 1 "wear"`,
          `kit add "KOTH" "hoodie" 1 1 "wear"`,
          `kit add "KOTH" "pants" 1 1 "wear"`,
          `kit add "KOTH" "shoes.boots" 1 1 "wear"`,
          `kit add "KOTH" "weapon.mod.holosight" 2 1 "main"`,
          `kit add "KOTH" "weapon.mod.lasersight" 2 1 "main"`,
          `kit add "KOTH" "weapon.mod.extendedmags" 2 1 "main"`,
          `kit add "KOTH" "weapon.mod.small.scope" 2 1 "main"`,
          `kit add "KOTH" "ammo.rifle" 356 1 "main"`,
          `kit add "KOTH" "rifle.ak" 1 1 "belt"`,
          `kit add "KOTH" "rifle.sks" 1 1 "belt"`,
          `kit add "KOTH" "syringe.medical" 6 1 "belt"`,
          `kit add "KOTH" "syringe.medical" 6 1 "belt"`,
          `kit add "KOTH" "syringe.medical" 6 1 "belt"`,
          `kit add "KOTH" "barricade.wood.cover" 50 1 "belt"`,
        ];

        for (const cmd of cmds) {
          // 1 at a time
          // eslint-disable-next-line no-await-in-loop
          await rce.sendCommand(state.serverId, cmd).catch(() => null);
        }

        const list2 = await rce.sendCommand(state.serverId, "kit list").catch(() => null);
        const kits2 = parseKitList(list2);
        const ok = kits2.some((k) => String(k).trim().toLowerCase() === "koth");

        if (!ok) {
          return interaction.editReply({ content: "❌ Failed to confirm kit creation. Check KITMANAGER." }).catch(() => {});
        }

        // set it as selected too
        state.advanced = state.advanced || {};
        state.advanced.kitName = "KOTH";
        writeAdvanced(state.guildId, state.serverId, { kitName: "KOTH" }, state.ownerId);
        await updatePublicMessage(interaction.client, state);

        return interaction.editReply({ content: "✅ Kit **KOTH** Successfully created!" }).catch(() => {});
      }
    });
  },
};