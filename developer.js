// modules/developer.js
const fs = require("fs");
const path = require("path");

const { MessageFlags } = require("discord.js");

const EMOTES_PATH = path.join(__dirname, "..", "data", "emotes.json");

function log(...a) { console.log("[developer]", ...a); }
function logErr(...a) { console.error("[developer]", ...a); }

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

function readEmotes() {
  return readJsonSafe(EMOTES_PATH, {});
}
function writeEmotes(data) {
  writeJsonSafe(EMOTES_PATH, data);
}

const DEV_IDS = (process.env.DEVELOPER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

function isDeveloper(interaction) {
  return (
    DEV_IDS.includes(interaction.user.id) ||
    interaction.memberPermissions?.has("Administrator")
  );
}

module.exports = {
  name: "developer",

  init(client) {
    // /developer add-emote
    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "developer") return;

        const sub = interaction.options.getSubcommand(false);
        if (sub !== "add-emote") return;

        if (!isDeveloper(interaction)) {
          return interaction.reply({ content: "Not authorised.", flags: MessageFlags.Ephemeral });
        }

        const rawEmote = interaction.options.getString("emote", true).trim();
        const friendlyName = interaction.options.getString("name", true).trim();

        if (!friendlyName || !rawEmote) {
          return interaction.reply({ content: "Both `emote` and `name` are required.", flags: MessageFlags.Ephemeral });
        }

        const emotes = readEmotes();
        const alreadyExists = emotes[friendlyName];
        emotes[friendlyName] = rawEmote;
        writeEmotes(emotes);

        log("add-emote", { name: friendlyName, rawEmote, by: interaction.user.id });

        return interaction.reply({
          content: alreadyExists
            ? `Updated emote **${friendlyName}**: \`${rawEmote}\``
            : `Added emote **${friendlyName}**: \`${rawEmote}\``,
          flags: MessageFlags.Ephemeral,
        });
      } catch (e) {
        logErr("add-emote error:", e?.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try { await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral }); } catch {}
        }
      }
    });
  },
};
