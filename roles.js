const fs = require("fs");
const path = require("path");
const { EmbedBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");

const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");

function readRoles() {
  try {
    if (!fs.existsSync(ROLES_PATH)) {
      fs.writeFileSync(
        ROLES_PATH,
        JSON.stringify({ consoleRoleId: null, adminRoleId: null, ownerRoleId: null }, null, 2),
        "utf8"
      );
    }
    return JSON.parse(fs.readFileSync(ROLES_PATH, "utf8"));
  } catch {
    return { consoleRoleId: null, adminRoleId: null, ownerRoleId: null };
  }
}

function writeRoles(next) {
  fs.writeFileSync(ROLES_PATH, JSON.stringify(next, null, 2), "utf8");
}

function successEmbed({ consoleRoleId, adminRoleId, ownerRoleId }) {
  const e = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setDescription(
`✅ Roles Configured!

> • Console Role: <@&${consoleRoleId}>
> • Admin Role: <@&${adminRoleId}>
> • Owner Role: <@&${ownerRoleId}>`
    )
    .setFooter({ text: "Ascendant | Roles Configured" })
    .setTimestamp(new Date());

  return e;
}

module.exports = {
  name: "roles",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "setup-roles") return;

        if (!interaction.inGuild()) {
          return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) {
          return interaction.reply({ content: "Administrator only.", flags: MessageFlags.Ephemeral });
        }

        const adminRole = interaction.options.getRole("admin", true);
        const ownerRole = interaction.options.getRole("owner", true);
        const consoleRole = interaction.options.getRole("consolerole", true);

        const next = {
          adminRoleId: adminRole.id,
          ownerRoleId: ownerRole.id,
          consoleRoleId: consoleRole.id,
        };

        writeRoles(next);
        console.log("[roles] saved:", next);

        return interaction.reply({ embeds: [successEmbed(next)] });
      } catch (e) {
        console.error("[roles] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },

  // optional helper if you want to import it elsewhere
  readRoles,
};