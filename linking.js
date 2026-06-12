const fs = require("fs");
const path = require("path");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
  ContainerBuilder,
} = require("discord.js");

const { sendConfiguredLog } = require("./rcelogs");

const CONFIG_PATH = path.join(__dirname, "link_config.json");
const ROLES_PATH = path.join(__dirname, "roles.json");
const { readLinks, writeLinks } = require("./links");

const pending = new Map(); // userId -> { gamertag, guildId }

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

function readConfig() {
  return readJsonSafe(CONFIG_PATH, {});
}
function writeConfig(data) {
  writeJsonSafe(CONFIG_PATH, data);
}

function readRoles() {
  return readJsonSafe(ROLES_PATH, { consoleRoleId: null, adminRoleId: null, ownerRoleId: null });
}

function isOwner(interaction) {
  const cfg = readRoles();
  const cache = interaction.member?.roles?.cache;
  const hasOwnerRole = cfg.ownerRoleId && cache?.has(cfg.ownerRoleId);
  const hasAdminPerm = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(hasOwnerRole || hasAdminPerm);
}

function makeGreenEmbed(desc) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(desc);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeGamertag(gt) {
  return String(gt || "").trim().toLowerCase();
}

function findUserByGamertag(links, gamertag) {
  const needle = normalizeGamertag(gamertag);
  for (const [userId, data] of Object.entries(links)) {
    if (normalizeGamertag(data?.gamertag) === needle) return userId;
  }
  return null;
}

function buildLinkingLogEmbed({
  title,
  success,
  userId = null,
  staffId = null,
  gamertag = null,
  reason = null,
  action = null,
}) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(title)
    .setTimestamp();

  const fields = [
    { name: "Status", value: success ? "✅ Success" : "❌ Failed", inline: true },
  ];

  if (action) fields.push({ name: "Action", value: action, inline: true });
  if (userId) fields.push({ name: "User", value: `<@${userId}>`, inline: true });
  if (staffId) fields.push({ name: "By", value: `<@${staffId}>`, inline: true });
  if (gamertag) fields.push({ name: "Gamertag", value: `\`${String(gamertag).slice(0, 100)}\``, inline: true });
  if (reason) fields.push({ name: "Reason", value: String(reason).slice(0, 1000) });

  embed.addFields(fields);
  return embed;
}

async function sendLinkLog(client, guildId, embed) {
  if (!guildId) return;
  await sendConfiguredLog(client, guildId, null, "linking", { embeds: [embed] }).catch(() => {});
}

// Components v2 panel
function buildLinkPanelContainer() {
  const container = new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents((t) =>
      t.setContent(
        [
          "### Link Your Account!",
          "* Connect your Discord account to your GamerTag to unlock exclusive features.",
          "* Link your account to gain full access to the rest of the Discord server.",
          "",
          "Click the buttons below to get started:"
        ].join("\n")
      )
    )
    .addSeparatorComponents((s) => s)
    .addActionRowComponents((row) =>
      row.setComponents(
        new ButtonBuilder()
          .setCustomId("linkpanel_link")
          .setLabel("Link Account")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🔗"),
        new ButtonBuilder()
          .setCustomId("linkpanel_unlink")
          .setLabel("Unlink Account")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🔓")
      )
    );

  return container;
}

function linkConfirmComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("link_confirm")
        .setLabel("Confirm Link")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("link_edit")
        .setLabel("Edit Link")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function makeLinkModal() {
  const modal = new ModalBuilder().setCustomId("link_modal").setTitle("Account Linking");

  const gt = new TextInputBuilder()
    .setCustomId("gamertag")
    .setLabel("Enter your Gamertag (XBOXID/PSNID)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(gt));
  return modal;
}

module.exports = {
  name: "linking",

  init(client) {


    client.on("interactionCreate", async (interaction) => {
      try {
        // /deploy-link
        if (interaction.isChatInputCommand() && interaction.commandName === "deploy-link") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "Link Panel Deploy",
                success: false,
                userId: interaction.user.id,
                action: "deploy-link",
                reason: "Owner only",
              })
            );

            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const channel = interaction.options.getChannel("channel", true);
          const role = interaction.options.getRole("role", false);

          const cfgAll = readConfig();
          cfgAll[interaction.guildId] = {
            channelId: channel.id,
            rewardRoleId: role?.id ?? null,
          };
          writeConfig(cfgAll);

          await channel.send({
            components: [buildLinkPanelContainer()],
            flags: MessageFlags.IsComponentsV2,
          });

          await sendLinkLog(
            client,
            interaction.guildId,
            buildLinkingLogEmbed({
              title: "Link Panel Deploy",
              success: true,
              userId: interaction.user.id,
              action: "deploy-link",
              reason: `Channel: <#${channel.id}>${role ? ` | Reward role: <@&${role.id}>` : ""}`,
            })
          );

          return interaction.reply({
            content: "Deployed link panel.",
            flags: MessageFlags.Ephemeral,
          });
        }

        // /total-links
        if (interaction.isChatInputCommand() && interaction.commandName === "total-links") {
          const type = interaction.options.getString("type", true);
          const links = readLinks();
          const entries = Object.entries(links);

          if (type === "number") {
            return interaction.reply({ content: `**${entries.length}** Users linked` });
          }

          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }
          if (entries.length === 0) {
            return interaction.reply({ content: "No links.", flags: MessageFlags.Ephemeral });
          }

          const lines = entries.map(([id, data]) => {
            const gt = data?.gamertag ?? "Unknown";
            const member = interaction.guild.members.cache.get(id);
            const tag = member ? `<@${id}>` : `<@${id}> (left)`;
            return `- ${tag} -> \`${gt}\``;
          });

          const parts = chunk(lines, 20);
          await interaction.reply({ content: `Links (showing ${entries.length})`, flags: MessageFlags.Ephemeral });

          for (const p of parts) {
            await interaction.followUp({ content: p.join("\n"), flags: MessageFlags.Ephemeral });
          }
          return;
        }

        // /unlink
        if (interaction.isChatInputCommand() && interaction.commandName === "unlink") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "Force Unlink",
                success: false,
                userId: interaction.user.id,
                action: "unlink",
                reason: "Owner only",
              })
            );

            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const type = interaction.options.getString("type", true);
          const links = readLinks();

          let targetId = null;
          let targetGamertag = null;

          if (type === "discord") {
            const user = interaction.options.getUser("discord", true);
            targetId = user.id;
            targetGamertag = links?.[targetId]?.gamertag || null;
          } else {
            const gt = interaction.options.getString("gamertag", true);
            targetId = findUserByGamertag(links, gt);
            targetGamertag = gt;
            if (!targetId) {
              await sendLinkLog(
                client,
                interaction.guildId,
                buildLinkingLogEmbed({
                  title: "Force Unlink",
                  success: false,
                  userId: interaction.user.id,
                  action: "unlink",
                  gamertag: gt,
                  reason: "Gamertag not found",
                })
              );

              return interaction.reply({ content: "Gamertag not found.", flags: MessageFlags.Ephemeral });
            }
          }

          const existing = links[targetId];
          if (!existing) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "Force Unlink",
                success: false,
                userId: targetId,
                staffId: interaction.user.id,
                action: "unlink",
                gamertag: targetGamertag,
                reason: "Not linked",
              })
            );

            return interaction.reply({ content: "Not linked.", flags: MessageFlags.Ephemeral });
          }

          delete links[targetId];
          writeLinks(links);

          const cfgAll = readConfig();
          const cfg = cfgAll[interaction.guildId] || {};
          if (cfg.rewardRoleId) {
            const member = await interaction.guild.members.fetch(targetId).catch(() => null);
            if (member) await member.roles.remove(cfg.rewardRoleId).catch(() => {});
          }

          await sendLinkLog(
            client,
            interaction.guildId,
            buildLinkingLogEmbed({
              title: "Force Unlink",
              success: true,
              userId: targetId,
              staffId: interaction.user.id,
              action: "unlink",
              gamertag: existing?.gamertag || targetGamertag,
              reason: "Link removed",
            })
          );

          return interaction.reply({ content: "Unlinked.", flags: MessageFlags.Ephemeral });
        }

        // /forcelink
        if (interaction.isChatInputCommand() && interaction.commandName === "forcelink") {
          if (!interaction.inGuild()) {
            return interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
          }
          if (!isOwner(interaction)) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "Force Link",
                success: false,
                userId: interaction.user.id,
                action: "forcelink",
                reason: "Owner only",
              })
            );

            return interaction.reply({ content: "Owner only.", flags: MessageFlags.Ephemeral });
          }

          const gamertag = interaction.options.getString("gamertag", true).trim();
          const user = interaction.options.getUser("discord", true);

          const links = readLinks();

          const existingOwner = findUserByGamertag(links, gamertag);
          if (existingOwner && existingOwner !== user.id) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "Force Link",
                success: false,
                userId: user.id,
                staffId: interaction.user.id,
                action: "forcelink",
                gamertag,
                reason: "Gamertag already linked to another user",
              })
            );

            return interaction.reply({
              content: "That gamertag is already linked to another user.",
              flags: MessageFlags.Ephemeral,
            });
          }

          {
            const _old = links[user.id]?.gamertag;
            const _aliases = Array.isArray(links[user.id]?.aliases) ? [...links[user.id].aliases] : [];
            if (_old && _old.toLowerCase() !== gamertag.toLowerCase() && !_aliases.some((a) => a.toLowerCase() === _old.toLowerCase())) {
              _aliases.push(_old);
            }
            links[user.id] = {
              gamertag,
              linkedAt: Date.now(),
              linkedBy: interaction.user.id,
              aliases: _aliases,
            };
          }
          writeLinks(links);

          const cfgAll = readConfig();
          const cfg = cfgAll[interaction.guildId] || {};
          if (cfg.rewardRoleId) {
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (member) await member.roles.add(cfg.rewardRoleId).catch(() => {});
          }

          await sendLinkLog(
            client,
            interaction.guildId,
            buildLinkingLogEmbed({
              title: "Force Link",
              success: true,
              userId: user.id,
              staffId: interaction.user.id,
              action: "forcelink",
              gamertag,
              reason: "Forced link created",
            })
          );

          return interaction.reply({
            content: `Forced link set: ${user} -> **${gamertag}**`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // Buttons
        if (interaction.isButton()) {
          if (!["linkpanel_link", "linkpanel_unlink", "link_confirm", "link_edit"].includes(interaction.customId)) return;

          // LINK
          if (interaction.customId === "linkpanel_link") {
            const links = readLinks();
            const existing = links[interaction.user.id];

            if (existing?.gamertag) {
              await sendLinkLog(
                client,
                interaction.guildId,
                buildLinkingLogEmbed({
                  title: "User Link Attempt",
                  success: false,
                  userId: interaction.user.id,
                  action: "panel-link",
                  gamertag: existing.gamertag,
                  reason: "Already linked",
                })
              );

              return interaction.reply({
                content: "You are already linked. If you want to change it, click Unlink Account first.",
                flags: MessageFlags.Ephemeral,
              });
            }

            return interaction.showModal(makeLinkModal());
          }

          // UNLINK
          if (interaction.customId === "linkpanel_unlink") {
            const links = readLinks();
            const existing = links[interaction.user.id];

            if (!existing) {
              await sendLinkLog(
                client,
                interaction.guildId,
                buildLinkingLogEmbed({
                  title: "User Unlink Attempt",
                  success: false,
                  userId: interaction.user.id,
                  action: "panel-unlink",
                  reason: "User is not linked",
                })
              );

              return interaction.reply({ content: "You are not linked.", flags: MessageFlags.Ephemeral });
            }

            delete links[interaction.user.id];
            writeLinks(links);

            const cfgAll = readConfig();
            const cfg = cfgAll[interaction.guildId] || {};
            if (cfg.rewardRoleId && interaction.member) {
              await interaction.member.roles.remove(cfg.rewardRoleId).catch(() => {});
            }

            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "User Unlink",
                success: true,
                userId: interaction.user.id,
                action: "panel-unlink",
                gamertag: existing.gamertag,
                reason: "User unlinked themselves",
              })
            );

            return interaction.reply({ content: "Unlinked.", flags: MessageFlags.Ephemeral });
          }

          // CONFIRM
          if (interaction.customId === "link_confirm") {
            const data = pending.get(interaction.user.id);
            if (!data) {
              await sendLinkLog(
                client,
                interaction.guildId,
                buildLinkingLogEmbed({
                  title: "User Link Confirm",
                  success: false,
                  userId: interaction.user.id,
                  action: "link-confirm",
                  reason: "Link request expired",
                })
              );

              return interaction.reply({ content: "Link request expired.", flags: MessageFlags.Ephemeral });
            }

            const links = readLinks();

            if (links[interaction.user.id]?.gamertag) {
              pending.delete(interaction.user.id);

              await sendLinkLog(
                client,
                interaction.guildId,
                buildLinkingLogEmbed({
                  title: "User Link Confirm",
                  success: false,
                  userId: interaction.user.id,
                  action: "link-confirm",
                  gamertag: links[interaction.user.id]?.gamertag,
                  reason: "Already linked",
                })
              );

              return interaction.update({ content: "You are already linked.", embeds: [], components: [] });
            }

            const existingOwner = findUserByGamertag(links, data.gamertag);
            if (existingOwner && existingOwner !== interaction.user.id) {
              pending.delete(interaction.user.id);

              await sendLinkLog(
                client,
                interaction.guildId,
                buildLinkingLogEmbed({
                  title: "User Link Confirm",
                  success: false,
                  userId: interaction.user.id,
                  action: "link-confirm",
                  gamertag: data.gamertag,
                  reason: "Gamertag already linked to another user",
                })
              );

              return interaction.update({
                content: "That gamertag is already linked to another user.",
                embeds: [],
                components: [],
              });
            }

            links[interaction.user.id] = { gamertag: data.gamertag, linkedAt: Date.now() };
            writeLinks(links);

            const cfgAll = readConfig();
            const cfg = cfgAll[interaction.guildId] || {};
            if (cfg.rewardRoleId && interaction.member) {
              await interaction.member.roles.add(cfg.rewardRoleId).catch(() => {});
            }

            pending.delete(interaction.user.id);

            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "User Link",
                success: true,
                userId: interaction.user.id,
                action: "link-confirm",
                gamertag: data.gamertag,
                reason: "User linked successfully",
              })
            );

            return interaction.update({
              content: `**${data.gamertag}** Succesfully linked to <@${interaction.user.id}>`,
              embeds: [],
              components: [],
            });
          }

          // EDIT
          if (interaction.customId === "link_edit") {
            return interaction.showModal(makeLinkModal());
          }
        }

        // Modal submit
        if (interaction.isModalSubmit()) {
          if (interaction.customId !== "link_modal") return;

          const gamertag = interaction.fields.getTextInputValue("gamertag").trim();
          const links = readLinks();

          if (links[interaction.user.id]?.gamertag) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "User Link Modal",
                success: false,
                userId: interaction.user.id,
                action: "link-modal",
                gamertag,
                reason: "Already linked",
              })
            );

            return interaction.reply({
              content: "You are already linked. Use Unlink Account first.",
              flags: MessageFlags.Ephemeral,
            });
          }

          const existingOwner = findUserByGamertag(links, gamertag);
          if (existingOwner && existingOwner !== interaction.user.id) {
            await sendLinkLog(
              client,
              interaction.guildId,
              buildLinkingLogEmbed({
                title: "User Link Modal",
                success: false,
                userId: interaction.user.id,
                action: "link-modal",
                gamertag,
                reason: "Gamertag already linked to another user",
              })
            );

            return interaction.reply({
              content: "That gamertag is already linked to another user.",
              flags: MessageFlags.Ephemeral,
            });
          }

          pending.set(interaction.user.id, { gamertag, guildId: interaction.guildId });

          const e = makeGreenEmbed(`Are you sure \`${gamertag}\` is your correct gamertag?`);

          return interaction.reply({
            embeds: [e],
            components: linkConfirmComponents(),
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        console.error("[linking] error:", e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "Error. Check console.", flags: MessageFlags.Ephemeral });
          } catch {}
        }
      }
    });
  },
};
