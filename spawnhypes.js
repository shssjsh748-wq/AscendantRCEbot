const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

const { listServers, getServer } = require("./rce");

const { readLinks } = require("./links");
const ROLES_PATH = path.join(__dirname, "roles.json");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVW";
const GRID_MIN_X = -1750;
const GRID_MAX_Z = 1749;
const GRID_CELL_X = (-76 - GRID_MIN_X) / 11;
const GRID_CELL_Z = (GRID_MAX_Z + 76) / 12;

// bigger letters, slightly tighter character spacing
const STEP = 60;
const CHAR_GAP = 40;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function gridSquareFromCoords(x, z) {
  const col = clamp(Math.floor((x - GRID_MIN_X) / GRID_CELL_X), 0, 22);
  const row = clamp(Math.floor((GRID_MAX_Z - z) / GRID_CELL_Z), 0, 22);
  return `${LETTERS[col]}${row}`;
}

function fmtCoord(n) {
  return Number(n).toFixed(2);
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, {
    consoleRoleId: null,
    adminRoleId: null,
    ownerRoleId: null,
  });
}

function resolveServerDisplay(serverId) {
  try {
    const s = getServer(serverId);
    return String(s?.displayName || s?.identifier || serverId || "Unknown").trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

function extractLinkedPlayerName(guildId, userId) {
  const data = readLinks();
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

  return null;
}

function escapeQuotes(s) {
  return String(s || "").replace(/"/g, '\\"');
}

function parsePrintPosResponse(resp) {
  const text = String(resp || "");
  const match = text.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);

  if (!match) return null;

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    z: Number(match[3]),
  };
}

function hasSpawnHypesAccess(member) {
  const roles = readRoles();
  const adminRoleId = roles?.adminRoleId || null;
  const ownerRoleId = roles?.ownerRoleId || null;

  if (!member?.roles?.cache) return false;

  return Boolean(
    (adminRoleId && member.roles.cache.has(adminRoleId)) ||
    (ownerRoleId && member.roles.cache.has(ownerRoleId))
  );
}

const FONT = {
  ".": [
    " ",
    " ",
    " ",
    " ",
    "#",
  ],

  "G": [
    " ### ",
    "#    ",
    "# ###",
    "#   #",
    " ####",
  ],

  "/": [
    "#    ",
    " #   ",
    "  #  ",
    "   # ",
    "    #",
  ],

  "h": [
    "#    ",
    "#    ",
    "#### ",
    "#   #",
    "#   #",
  ],

  "y": [
    "#   #",
    "#   #",
    " ####",
    "    #",
    " ### ",
  ],

  "p": [
    "#### ",
    "#   #",
    "#### ",
    "#    ",
    "#    ",
  ],

  "e": [
    " ### ",
    "#   #",
    "#####",
    "#    ",
    " ####",
  ],

  "s": [
    " ####",
    "#    ",
    " ### ",
    "    #",
    "#### ",
  ],

  "R": [
    "#### ",
    "#   #",
    "#### ",
    "#  # ",
    "#   #",
  ],

  "C": [
    " ####",
    "#    ",
    "#    ",
    "#    ",
    " ####",
  ],

  "E": [
    "#####",
    "#    ",
    "#### ",
    "#    ",
    "#####",
  ],
};

function buildArtPoints(baseX, baseY, baseZ) {
  const text = ".GG/hypesRCE";
  const points = [];
  let cursorX = baseX;

  for (const ch of text) {
    const pattern = FONT[ch];
    if (!pattern) continue;

    const height = pattern.length;
    const width = Math.max(...pattern.map((row) => row.length));

    for (let row = 0; row < height; row++) {
      const line = pattern[row];

      for (let col = 0; col < line.length; col++) {
        if (line[col] !== "#") continue;

        const x = cursorX + (col * STEP);
        const y = baseY;
        const z = baseZ + ((height - 1 - row) * STEP);

        points.push({ x, y, z });
      }
    }

    cursorX += (width * STEP) + CHAR_GAP;
  }

  if (!points.length) return [];

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const underlineZ = baseZ - (2 * STEP);

  for (let x = minX; x <= maxX; x += STEP) {
    points.push({ x, y: baseY, z: underlineZ });
  }

  const seen = new Set();
  return points.filter((p) => {
    const key = `${fmtCoord(p.x)}|${fmtCoord(p.y)}|${fmtCoord(p.z)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSpawnCommand(p) {
  return `spawn vendingmachine.deployed (${fmtCoord(p.x)},${fmtCoord(p.y)},${fmtCoord(p.z)})`;
}

function successEmbed({ grid, serverDisplay, count }) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Vertex Art Spawned")
    .addFields(
      { name: "Grid", value: `\`${grid}\``, inline: true },
      { name: "Server", value: `\`${serverDisplay}\``, inline: true },
      { name: "Vending Machines", value: `\`${count}\``, inline: true }
    )
    .setTimestamp();
}

module.exports = {
  name: "spawnhypes",

  init(client, rce) {
    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "spawnhypes") return;

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
        if (interaction.commandName !== "spawnhypes") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server." }).catch(() => {});
        }

        const member =
          interaction.member ||
          (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

        if (!hasSpawnHypesAccess(member)) {
          return interaction.reply({
            content: ":x: You do not have permission to use this command.",
          }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);
        const serverDisplay = resolveServerDisplay(serverId);

        await interaction.deferReply().catch(() => {});

        const playerName = extractLinkedPlayerName(interaction.guildId, interaction.user.id);
        if (!playerName) {
          return interaction.editReply({
            content: ":x: You must be linked to perform this action",
          }).catch(() => {});
        }

        let printPosResp = null;
        try {
          printPosResp = await rce.sendCommand(serverId, `printpos "${escapeQuotes(playerName)}"`);
        } catch {
          printPosResp = null;
        }

        if (!printPosResp || !String(printPosResp).trim()) {
          return interaction.editReply({
            content: `:x: No response from **${serverDisplay}**`,
          }).catch(() => {});
        }

        const coords = parsePrintPosResponse(printPosResp);
        if (!coords) {
          return interaction.editReply({
            content: ":x: You must be online to perform this action",
          }).catch(() => {});
        }

        const artPoints = buildArtPoints(coords.x, coords.y, coords.z);

        for (const p of artPoints) {
          await rce.sendCommand(serverId, buildSpawnCommand(p));
        }

        const grid = gridSquareFromCoords(coords.x, coords.z);

        return interaction.editReply({
          content: "",
          embeds: [
            successEmbed({
              grid,
              serverDisplay,
              count: artPoints.length,
            }),
          ],
        }).catch(() => {});
      } catch (e) {
        console.error("[spawnhypes] error:", e);

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