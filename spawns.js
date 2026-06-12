const fs = require("fs");
const path = require("path");

const {
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const { listServers } = require("../rce");
const { sendConfiguredLog } = require("./rcelogs");

const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");

function readRoles() {
  try {
    return JSON.parse(fs.readFileSync(ROLES_PATH, "utf8"));
  } catch {
    return { consoleRoleId: null, adminRoleId: null, ownerRoleId: null };
  }
}

function canUseSpawn(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  if (!cache) return false;

  const hasAdminRole = cfg.adminRoleId && cache.has(cfg.adminRoleId);
  const hasOwnerRole = cfg.ownerRoleId && cache.has(cfg.ownerRoleId);

  const hasDiscordAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

  return Boolean(hasAdminRole || hasOwnerRole || hasDiscordAdmin);
}

const pending = new Map();

const TYPE_LABEL = {
  hackablecrate: "Locked Crates",
  bradley_crate: "Bradley Crates",
  heli_crate: "Heli Crates",
  "sulfur-ore": "Sulfur Nodes",
  "stone-ore": "Stone Nodes",
  "metal-ore": "Metal Nodes",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVW";
const GRID_MIN_X = -1750;
const GRID_MAX_Z = 1749;
const GRID_CELL_X = (-76 - GRID_MIN_X) / 11;
const GRID_CELL_Z = (GRID_MAX_Z + 76) / 12;

function gridSquareFromCoords(x, z) {
  const col = clamp(Math.floor((x - GRID_MIN_X) / GRID_CELL_X), 0, 22);
  const row = clamp(Math.floor((GRID_MAX_Z - z) / GRID_CELL_Z), 0, 22);
  return `${LETTERS[col]}${row}`;
}

function fmtCoord(n) {
  return Number(n).toFixed(2);
}

function spawnCommand(shortname, x, y, z) {
  return `spawn ${shortname} (${fmtCoord(x)},${fmtCoord(y)},${fmtCoord(z)})`;
}

function isSpawnSuccess(resp, shortname) {
  const s = String(resp || "");
  return s.includes("server spawned") && s.includes(shortname);
}

function buildSpawnLogEmbed({
  interaction,
  data,
  x,
  y,
  z,
  grid,
  success,
  successCount,
  reason,
}) {
  const niceType = TYPE_LABEL[data?.type] || data?.type || "Unknown";

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Spawn Log")
    .addFields(
      { name: "Status", value: success ? "✅ Success" : "❌ Failed", inline: true },
      { name: "User", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Type", value: niceType, inline: true },
      { name: "Quantity", value: `${successCount}/${data?.quantity || 0}`, inline: true },
      { name: "Server", value: data?.serverDisplay || data?.serverId || "Unknown", inline: true },
      { name: "Position", value: grid || "Unknown", inline: true },
      { name: "Coords", value: `X:${fmtCoord(x || 0)} Y:${fmtCoord(y || 0)} Z:${fmtCoord(z || 0)}` },
      { name: "Reason", value: reason || (success ? "Spawn completed" : "Spawn failed") }
    )
    .setTimestamp(new Date());
}

async function sendSpawnLog(client, interaction, data, extra = {}) {
  if (!data?.serverId) return;
  await sendConfiguredLog(client, interaction.guildId, data.serverId, "spawn", {
    embeds: [
      buildSpawnLogEmbed({
        interaction,
        data,
        ...extra,
      }),
    ],
  });
}

module.exports = {
  name: "spawns",

  init(client, rce) {


    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isAutocomplete()) return;
      if (interaction.commandName !== "spawn") return;

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
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "spawn") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        if (!canUseSpawn(interaction)) {
          return interaction.reply({
            content: "Admin/Owner role only.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const serverId = interaction.options.getString("server", true);
        const type = interaction.options.getString("type", true);
        const quantity = interaction.options.getInteger("quantity", true);
        const cluster = interaction.options.getBoolean("cluster", true);

        const servers = listServers();
        const server = servers.find((s) => s.identifier === serverId);
        if (!server) {
          return interaction.reply({
            content: `Unknown server: ${serverId}`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`spawn_modal:${interaction.id}`)
          .setTitle("Spawn Position");

        const xIn = new TextInputBuilder()
          .setCustomId("x")
          .setLabel("X Position")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const yIn = new TextInputBuilder()
          .setCustomId("y")
          .setLabel("Y Position")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const zIn = new TextInputBuilder()
          .setCustomId("z")
          .setLabel("Z Position")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(xIn),
          new ActionRowBuilder().addComponents(yIn),
          new ActionRowBuilder().addComponents(zIn)
        );

        pending.set(interaction.id, {
          serverId,
          serverDisplay: server.displayName || server.identifier,
          type,
          quantity: clamp(quantity, 1, 300),
          cluster: !!cluster,
          userId: interaction.user.id,
        });

        console.log("[/spawn] modal open:", pending.get(interaction.id));
        return interaction.showModal(modal);
      } catch (e) {
        console.error("[/spawn] command error:", e);
        if (!interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({
              content: "Error starting spawn.",
              flags: MessageFlags.Ephemeral,
            });
          } catch {}
        }
      }
    });

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith("spawn_modal:")) return;

      const interactionId = interaction.customId.split(":")[1];
      const data = pending.get(interactionId);

      try {
        if (!data) {
          return interaction.reply({
            content: "Spawn request expired.",
            flags: MessageFlags.Ephemeral,
          });
        }
        if (data.userId !== interaction.user.id) {
          return interaction.reply({
            content: "That spawn request is not yours.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const x = Number(interaction.fields.getTextInputValue("x"));
        const y = Number(interaction.fields.getTextInputValue("y"));
        const z = Number(interaction.fields.getTextInputValue("z"));

        if (![x, y, z].every(Number.isFinite)) {
          await sendSpawnLog(client, interaction, data, {
            x,
            y,
            z,
            grid: "Invalid",
            success: false,
            successCount: 0,
            reason: "X/Y/Z must be numbers",
          });

          return interaction.reply({
            content: "X/Y/Z must be numbers.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const grid = gridSquareFromCoords(x, z);
        const niceType = TYPE_LABEL[data.type] || data.type;

        await interaction.reply({
          content: "Starting spawn...",
          flags: MessageFlags.Ephemeral,
        });

        const embed = new EmbedBuilder()
          .setDescription(
            `Spawning\n` +
              `> ${data.quantity} ${niceType}\n` +
              `> Server: ${data.serverDisplay}\n` +
              `> Position: ${grid}\n` +
              `> Coords: X:${fmtCoord(x)} Y:${fmtCoord(y)} Z:${fmtCoord(z)}\n\n` +
              `Spawning ${data.quantity} ${niceType}...`
          )
          .setFooter({ text: "Ascendant | Entity Spawning" })
          .setTimestamp(new Date());

        const msg = await interaction.channel.send({ embeds: [embed] });

        console.log(
          `[spawn] begin -> server=${data.serverId} type=${data.type} qty=${data.quantity} cluster=${data.cluster} at (${x},${y},${z}) grid=${grid}`
        );

        let successCount = 0;

        for (let i = 1; i <= data.quantity; i++) {
          let sx = x;
          let sz = z;

          if (data.cluster) {
            const dx = Math.random() * 60 - 30;
            const dz = Math.random() * 60 - 30;
            sx = x + dx;
            sz = z + dz;
          }

          const cmd = spawnCommand(data.type, sx, y, sz);

          console.log(`[spawn] ${i}/${data.quantity} -> ${cmd}`);
          const resp = await rce.sendCommand(data.serverId, cmd);
          console.log(`[spawn] resp ${i}/${data.quantity}:`, resp);

          if (isSpawnSuccess(resp, data.type)) successCount++;

          if (i % 10 === 0 || i === data.quantity) {
            const progressEmbed = EmbedBuilder.from(embed).setDescription(
              `Spawning\n` +
                `> ${data.quantity} ${niceType}\n` +
                `> Server: ${data.serverDisplay}\n` +
                `> Position: ${grid}\n` +
                `> Coords: X:${fmtCoord(x)} Y:${fmtCoord(y)} Z:${fmtCoord(z)}\n\n` +
                `Spawning ${data.quantity} ${niceType}...\n` +
                `Progress: ${successCount}/${data.quantity}`
            );
            await msg.edit({ embeds: [progressEmbed] });
          }

          if (i % 100 === 0 && i !== data.quantity) {
            await sleep(1000);
          }
        }

        const doneEmbed = new EmbedBuilder()
          .setColor(0x95a5a6)
          .setDescription(
            `Spawning Successful\n\n` +
              `> Spawned ${successCount}/${data.quantity} ${niceType}\n` +
              `> Server: ${data.serverDisplay}\n` +
              `> Position: ${grid}\n` +
              `> Coords: X:${fmtCoord(x)} Y:${fmtCoord(y)} Z:${fmtCoord(z)}`
          )
          .setFooter({ text: "Ascendant | Entity Spawning" })
          .setTimestamp(new Date());

        await msg.edit({ embeds: [doneEmbed] });

        await sendSpawnLog(client, interaction, data, {
          x,
          y,
          z,
          grid,
          success: true,
          successCount,
          reason: "Spawn completed",
        });

        console.log(`[spawn] done -> success=${successCount}/${data.quantity}`);
      } catch (e) {
        console.error("[spawn] modal submit error:", e);

        try {
          if (data) {
            const x = Number(interaction.fields?.getTextInputValue("x") || 0);
            const y = Number(interaction.fields?.getTextInputValue("y") || 0);
            const z = Number(interaction.fields?.getTextInputValue("z") || 0);

            await sendSpawnLog(client, interaction, data, {
              x,
              y,
              z,
              grid: Number.isFinite(x) && Number.isFinite(z) ? gridSquareFromCoords(x, z) : "Unknown",
              success: false,
              successCount: 0,
              reason: String(e?.message || e).slice(0, 300),
            });
          }
        } catch {}

        try {
          await interaction.followUp({
            content: "Spawn failed (check console).",
            flags: MessageFlags.Ephemeral,
          });
        } catch {}
      } finally {
        pending.delete(interactionId);
      }
    });
  },
};
