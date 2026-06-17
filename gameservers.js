const {
  EmbedBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} = require("discord.js");

const {
  makeIdentifier,
  listServers,
  getServer,
  saveServer,
  updateServer,
  deleteServer,
  addServerToRCE,
  removeServerFromRCE,
  testRCONConnection,
} = require("./rce");

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
}

function prettyEmbedBase() {
  // footer text cannot be empty in discord.js
  return new EmbedBuilder()
    .setFooter({ text: "Vertex" })
    .setTimestamp(new Date());
}

function makeLoadingEmbed(displayName) {
  return prettyEmbedBase()
    .setDescription("**RCON Connection Loading...**")
    .addFields(
      { name: "Server", value: displayName || "Unknown", inline: true },
      { name: "Status", value: "Connecting…", inline: true }
    );
}

function makeSuccessEmbed({ displayName, hostname, fps, entities }) {
  const cleanServerName = (hostname || displayName || "Unknown").trim();
  const shownName = (displayName || "Unknown").trim();

  const desc =
`## CONNECTION SUCCESSFUL :tada:

- ${cleanServerName}
- FPS: ${fps ?? "Unknown"}
- Entities: ${entities ?? "Unknown"}

> :tada: Your server is now connected to the system
> You can start using all features on ${shownName}!`;

  return prettyEmbedBase()
    .setColor(0x95a5a6)
    .setDescription(desc);
}

function makeFailEmbed(displayName, reason) {
  return prettyEmbedBase()
    .setColor(0x95a5a6)
    .setDescription("## connection Failed :x:")
    .addFields(
      { name: "Server", value: displayName || "Unknown", inline: false },
      { name: "Reason", value: reason || "Unknown error", inline: false }
    );
}

function addServerModal(customId, defaults = {}) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle("Add Game Server");

  const displayName = new TextInputBuilder()
    .setCustomId("displayName")
    .setLabel("Display Name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(defaults.displayName ?? "");

  const host = new TextInputBuilder()
    .setCustomId("host")
    .setLabel("Host / IP")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(defaults.host ?? "");

  const port = new TextInputBuilder()
    .setCustomId("port")
    .setLabel("RCON Port")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(defaults.port != null ? String(defaults.port) : "");

  const password = new TextInputBuilder()
    .setCustomId("password")
    .setLabel("RCON Password")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(displayName),
    new ActionRowBuilder().addComponents(host),
    new ActionRowBuilder().addComponents(port),
    new ActionRowBuilder().addComponents(password)
  );

  return modal;
}

module.exports = {
  name: "gameservers",

  init(client) {
    client.on("interactionCreate", async (interaction) => {
      try {
        // ---- autocomplete for remove/edit ----
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "gameserver") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const servers = listServers();
          const q = String(focused.value || "").toLowerCase();

          const choices = servers
            .filter((s) => (s.displayName || s.identifier).toLowerCase().includes(q))
            .slice(0, 25)
            .map((s) => ({
              name: `${s.displayName} (${s.identifier})`.slice(0, 100),
              value: s.identifier,
            }));

          return interaction.respond(choices).catch(() => {})
        }

        // ---- slash commands ----
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName !== "gameserver") return;

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }

          if (!isAdmin(interaction)) {
            return interaction.reply({ content: "Admin only.", flags: MessageFlags.Ephemeral });
          }

          const sub = interaction.options.getSubcommand();

          if (sub === "add") {
            const modal = addServerModal("gameserver_add_modal");
            return interaction.showModal(modal);
          }

          if (sub === "remove") {
            const identifier = interaction.options.getString("server", true);
            const server = getServer(identifier);

            if (!server) {
              return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
            }

            await removeServerFromRCE(identifier);
            deleteServer(identifier);

            console.log("[GameServer] removed:", identifier);
            return interaction.reply({
              content: `Removed **${server.displayName}** (${identifier}).`,
              flags: MessageFlags.Ephemeral,
            });
          }

          if (sub === "edit") {
            const identifier = interaction.options.getString("server", true);
            const server = getServer(identifier);

            if (!server) {
              return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
            }

            const modal = addServerModal("gameserver_edit_modal:" + identifier, {
              displayName: server.displayName,
              host: server.host,
              port: server.port,
            });

            modal.setTitle("Edit Game Server");
            return interaction.showModal(modal);
          }
        }

        // ---- modal submits ----
        if (interaction.isModalSubmit()) {
          // ADD
          if (interaction.customId === "gameserver_add_modal") {
            const displayName = interaction.fields.getTextInputValue("displayName").trim();
            const host = interaction.fields.getTextInputValue("host").trim();
            const port = interaction.fields.getTextInputValue("port").trim();
            const password = interaction.fields.getTextInputValue("password");

            const identifier = makeIdentifier(displayName);

            const saved = saveServer({
              identifier,
              displayName,
              host,
              port: Number(port),
              password,
            });

            console.log("[GameServer] saved new server:", saved);

            await interaction.reply({ embeds: [makeLoadingEmbed(displayName)] });

            // makes the loading show a bit longer
            await sleep(2500);

            try {
              await addServerToRCE(saved);

              const test = await testRCONConnection(identifier);
              if (!test.ok) {
                return interaction.editReply({
                  embeds: [makeFailEmbed(displayName, "Could not parse serverinfo / no response")],
                });
              }

              return interaction.editReply({
                embeds: [
                  makeSuccessEmbed({
                    displayName, // keep display name
                    hostname: test.hostname,
                    fps: test.fps,
                    entities: test.entities,
                  }),
                ],
              });
            } catch (e) {
              console.error("[GameServer] add/test error:", e);
              return interaction.editReply({
                embeds: [makeFailEmbed(displayName, "RCON add/test threw an error (check console)")],
              });
            }
          }

          // EDIT
          if (interaction.customId.startsWith("gameserver_edit_modal:")) {
            const identifier = interaction.customId.split(":")[1];
            const existing = getServer(identifier);

            if (!existing) {
              return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });
            }

            const displayName = interaction.fields.getTextInputValue("displayName").trim();
            const host = interaction.fields.getTextInputValue("host").trim();
            const port = interaction.fields.getTextInputValue("port").trim();
            const password = interaction.fields.getTextInputValue("password");

            const updated = updateServer(identifier, {
              displayName,
              host,
              port: Number(port),
              password,
            });

            console.log("[GameServer] updated server:", updated);

            await interaction.reply({ embeds: [makeLoadingEmbed(displayName)] });
            await sleep(2500);

            try {
              await removeServerFromRCE(identifier);
              await addServerToRCE(updated);

              const test = await testRCONConnection(identifier);
              if (!test.ok) {
                return interaction.editReply({
                  embeds: [makeFailEmbed(displayName, "Could not parse serverinfo / no response")],
                });
              }

              return interaction.editReply({
                embeds: [
                  makeSuccessEmbed({
                    displayName,
                    hostname: test.hostname,
                    fps: test.fps,
                    entities: test.entities,
                  }),
                ],
              });
            } catch (e) {
              console.error("[GameServer] edit add/test error:", e);
              return interaction.editReply({
                embeds: [makeFailEmbed(displayName, "RCON add/test threw an error (check console)")],
              });
            }
          }
        }
      } catch (err) {
        console.error("[gameservers module] interaction error:", err);

        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });

    console.log("[gameservers] init ok");
  },
};