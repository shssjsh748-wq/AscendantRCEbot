const fs = require("fs");
const path = require("path");
const {
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  TextDisplayBuilder,
} = require("discord.js");

const { listServers, getServer } = require("../rce");

const CFG_PATH = path.join(__dirname, "..", "data", "bounties_config.json");
const DATA_PATH = path.join(__dirname, "..", "data", "bounties_data.json");
const ROLES_PATH = path.join(__dirname, "..", "data", "roles.json");

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

const norm = (s) => String(s || "").trim().toLowerCase();
const safe = (s, m = 250) => String(s || "").trim().slice(0, m);

function getCfg() {
  return readJsonSafe(CFG_PATH, {});
}
function saveCfg(data) {
  writeJsonSafe(CFG_PATH, data);
}
function getData() {
  return readJsonSafe(DATA_PATH, {});
}
function saveData(data) {
  writeJsonSafe(DATA_PATH, data);
}
function getRoles() {
  return readJsonSafe(ROLES_PATH, {});
}

function getServerDisplay(serverId) {
  try {
    const s = getServer(serverId);
    return String(s?.displayName || s?.identifier || serverId || "Unknown").trim();
  } catch {
    return String(serverId || "Unknown");
  }
}

function isAdminOrOwner(member) {
  const roles = getRoles();
  const adminRoleId = roles?.adminRoleId;
  const ownerRoleId = roles?.ownerRoleId;

  if (!member) return false;
  if (member.permissions?.has?.("Administrator")) return true;
  if (ownerRoleId && member.roles?.cache?.has(ownerRoleId)) return true;
  if (adminRoleId && member.roles?.cache?.has(adminRoleId)) return true;
  return false;
}

function getConfig(guildId, serverId) {
  return getCfg()?.[guildId]?.[serverId] || null;
}

function getServerState(guildId, serverId) {
  const data = getData();
  const state = ensure(data, guildId, serverId);
  if (!state.entries || typeof state.entries !== "object") state.entries = {};
  if (!state.grids || typeof state.grids !== "object") state.grids = {};
  return { data, state };
}

function getCurrencyMeta(code) {
  const map = {
    gbp: { symbol: "£", locale: "en-GB", currency: "GBP" },
    aud: { symbol: "A$", locale: "en-AU", currency: "AUD" },
    usd: { symbol: "$", locale: "en-US", currency: "USD" },
  };
  return map[String(code || "").toLowerCase()] || map.gbp;
}

function formatMoney(amount, currencyCode, { trimZeros = false } = {}) {
  const value = Math.max(0, Number(amount) || 0);
  const meta = getCurrencyMeta(currencyCode);

  let text;
  try {
    text = new Intl.NumberFormat(meta.locale, {
      style: "currency",
      currency: meta.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    text = `${meta.symbol}${value.toFixed(2)}`;
  }

  if (trimZeros) {
    text = text.replace(/\.00$/, "");
  }

  return text;
}

function footerTimeText() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Today at ${hh}:${mm}`;
}

function getProgressLabel(wipesPlayed) {
  const wipes = Math.max(0, Math.min(3, Number(wipesPlayed) || 0));
  if (wipes >= 3) return "Cashout Available!";
  return `[${wipes}/3]`;
}

function clampGrid(grid) {
  return safe(String(grid || "NA").toUpperCase().replace(/\s+/g, ""), 10) || "NA";
}

function resolveRoleMention(guild, entry) {
  const roleId = entry?.roleId;
  const current = roleId ? guild.roles.cache.get(roleId) : null;
  const finalRoleId = current?.id || roleId || null;

  return finalRoleId
    ? `<@&${finalRoleId}>`
    : safe(entry?.roleName || "Unknown Clan", 100) || "Unknown Clan";
}

function buildBoardComponents(guild, serverId, config, state) {
  const entries = Object.values(state?.entries || {})
    .filter((x) => Number(x?.amount || 0) > 0)
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));

const rows = entries.map((entry) => {
  const roleMention = resolveRoleMention(guild, entry);
  const grid = clampGrid(state?.grids?.[entry.roleId]?.grid || "NA");
  const amountText = formatMoney(entry.amount, config.currency);
  const progressText = getProgressLabel(entry.wipesPlayed);

  return `* ${roleMention} [${grid}] :money_with_wings: ${amountText} \`${progressText}\``;
});

  const totalCash = entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const totalText = formatMoney(totalCash, config.currency, { trimZeros: true });

  const body = [
    "## :gem: Bounty Board",
    "",
    ...(rows.length ? rows : ["> No active bounties right now."]),
    "",
    `### :moneybag:  Total Cash In Play: ${totalText}`,
    "* **Make a ticket before raiding or it wont count!**",
    "",
    `${footerTimeText()}`,
  ].join("\n");

  return [
    new TextDisplayBuilder().setContent(`:trophy: ${safe(getServerDisplay(serverId), 100)} Bounty Board!`),
    new ContainerBuilder()
      .setAccentColor(0x95a5a6)
      .addTextDisplayComponents((textDisplay) => textDisplay.setContent(body)),
  ];
}

async function upsertBoardMessage(client, guildId, serverId) {
  const config = getConfig(guildId, serverId);
  if (!config?.channelId) return null;

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;

  const channel = guild.channels.cache.get(config.channelId) || (await guild.channels.fetch(config.channelId).catch(() => null));
  if (!channel || !channel.send) return null;

  const { data, state } = getServerState(guildId, serverId);
  const components = buildBoardComponents(guild, serverId, config, state);

  const mentionRoleIds = Object.values(state?.entries || {})
    .map((x) => x?.roleId)
    .filter(Boolean);

  let msg = null;

  if (config.boardMessageId) {
    msg = await channel.messages.fetch(config.boardMessageId).catch(() => null);
    if (msg) {
     await msg.edit({
  components,
  allowedMentions: { roles: mentionRoleIds },
}).catch(() => null);
    }
  }

  if (!msg) {
  msg = await channel
  .send({
    flags: MessageFlags.IsComponentsV2,
    components,
    allowedMentions: { roles: mentionRoleIds },
  })
  .catch(() => null);

    if (msg) {
      const cfg = getCfg();
      const slot = ensure(cfg, guildId, serverId);
      slot.channelId = config.channelId;
      slot.currency = config.currency;
      slot.boardMessageId = msg.id;
      slot.updatedAt = Date.now();
      saveCfg(cfg);
    }
  }

  if (!msg) return null;

  const latest = ensure(data, guildId, serverId);
  latest.lastBoardSyncAt = Date.now();
  saveData(data);
  return msg;
}

function okEmbed(title, lines) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(`### ${title}\n\n${lines.join("\n")}`).setTimestamp();
}

function infoEmbed(title, lines) {
  return new EmbedBuilder().setColor(0x95a5a6).setDescription(`### ${title}\n\n${lines.join("\n")}`).setTimestamp();
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch {}
}

function getAmountOption(options, name) {
  try {
    const v = options.getNumber(name, false);
    if (typeof v === "number") return v;
  } catch {}
  try {
    const v = options.getInteger(name, false);
    if (typeof v === "number") return v;
  } catch {}
  return null;
}

module.exports = {
  name: "bounties",

  init(client) {
    if (client._bountiesLoaded) return;
    client._bountiesLoaded = true;

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName !== "bounties") return;

          const focused = interaction.options.getFocused(true);
          if (focused.name !== "server") return;

          const q = norm(focused.value);
          const choices = listServers()
            .map((s) => ({
              name: safe(s.displayName || s.identifier, 100),
              value: s.identifier,
            }))
            .filter((x) => norm(x.name).includes(q))
            .slice(0, 25);

          return interaction.respond(choices).catch(() => {});
        }

        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== "bounties") return;
        if (!interaction.inGuild()) return;

        const sub = interaction.options.getSubcommand();
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!isAdminOrOwner(member)) {
          return interaction.reply({ content: "You do not have permission." }).catch(() => {});
        }

        const serverId = interaction.options.getString("server", true);

        if (sub === "setup") {
          const channel = interaction.options.getChannel("channel", true);
          const currency = interaction.options.getString("currency", true).toLowerCase();

          const cfg = getCfg();
          const slot = ensure(cfg, interaction.guildId, serverId);
          slot.channelId = channel.id;
          slot.currency = currency;
          slot.updatedAt = Date.now();
          saveCfg(cfg);

          const { data, state } = getServerState(interaction.guildId, serverId);
          state.entries = state.entries || {};
          state.grids = state.grids || {};
          saveData(data);

          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Bounty Board Configured", [
                `* Server: **${safe(getServerDisplay(serverId), 100)}**`,
                `* Channel: ${channel}`,
                `* Currency: **${currency.toUpperCase()}**`,
              ]),
            ],
          }).catch(() => {});
        }

        const config = getConfig(interaction.guildId, serverId);
        if (!config?.channelId || !config?.currency) {
          return interaction.reply({ content: "Run /bounties setup first." }).catch(() => {});
        }

        if (sub === "reset") {
          const data = getData();
          const slot = ensure(data, interaction.guildId, serverId);
          slot.entries = {};
          slot.grids = {};
          slot.lastResetAt = Date.now();
          saveData(data);

          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Bounties Reset", [
                `All bounties, wipe progress, and saved grids were reset for **${safe(getServerDisplay(serverId), 100)}**.`,
              ]),
            ],
          }).catch(() => {});
        }

        if (sub === "add") {
          const clan = interaction.options.getRole("clan", true);
          const amount = getAmountOption(interaction.options, "amount");
          if (amount === null || amount <= 0) {
            return interaction.reply({ content: "Amount must be greater than 0." }).catch(() => {});
          }

          const { data, state } = getServerState(interaction.guildId, serverId);
          const current = state.entries[clan.id] || {
            roleId: clan.id,
            roleName: clan.name,
            amount: 0,
            wipesPlayed: 0,
          };

          current.roleId = clan.id;
          current.roleName = clan.name;
          current.amount = Math.max(0, Number(current.amount || 0) + Number(amount));
          current.wipesPlayed = Math.max(0, Math.min(3, Number(current.wipesPlayed || 0)));
          current.updatedAt = Date.now();

          state.entries[clan.id] = current;
          saveData(data);

          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Bounty Added", [
                `* Clan: ${clan}`,
                `* Added: **${formatMoney(amount, config.currency)}**`,
                `* New Total: **${formatMoney(current.amount, config.currency)}**`,
              ]),
            ],
          }).catch(() => {});
        }

        if (sub === "remove") {
          const clan = interaction.options.getRole("clan", true);
          const type = interaction.options.getString("type", true).toLowerCase();
          const amount = getAmountOption(interaction.options, "amount");
          if (amount === null || amount < 0) {
            return interaction.reply({ content: "Amount must be 0 or more." }).catch(() => {});
          }

          const { data, state } = getServerState(interaction.guildId, serverId);
          const current = state.entries[clan.id];
          if (!current || Number(current.amount || 0) <= 0) {
            return interaction.reply({ content: "That clan does not have an active bounty." }).catch(() => {});
          }

          const oldAmount = Number(current.amount || 0);
          let removed = 0;

          if (type === "percentage") {
            removed = oldAmount * (Number(amount) / 100);
          } else {
            removed = Number(amount);
          }

          const nextAmount = Math.max(0, oldAmount - removed);

          if (nextAmount <= 0) {
            delete state.entries[clan.id];
          } else {
            current.amount = nextAmount;
            current.roleName = clan.name;
            current.updatedAt = Date.now();
            state.entries[clan.id] = current;
          }

          saveData(data);
          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Bounty Removed", [
                `* Clan: ${clan}`,
                `* Removed: **${formatMoney(Math.min(oldAmount, removed), config.currency)}**`,
                `* New Total: **${formatMoney(nextAmount, config.currency)}**`,
              ]),
            ],
          }).catch(() => {});
        }

        if (sub === "setgrid") {
          const clan = interaction.options.getRole("clan", true);
          const grid = clampGrid(interaction.options.getString("grid", true));

          const { data, state } = getServerState(interaction.guildId, serverId);
          state.grids[clan.id] = {
            roleId: clan.id,
            roleName: clan.name,
            grid,
            updatedAt: Date.now(),
          };
          saveData(data);

          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Grid Updated", [
                `* Clan: ${clan}`,
                `* Grid: **${grid}**`,
              ]),
            ],
          }).catch(() => {});
        }

        if (sub === "progress") {
          const { data, state } = getServerState(interaction.guildId, serverId);
          let updated = 0;

          for (const entry of Object.values(state.entries || {})) {
            if (Number(entry.amount || 0) <= 0) continue;
            entry.wipesPlayed = Math.min(3, Number(entry.wipesPlayed || 0) + 1);
            entry.updatedAt = Date.now();
            updated++;
          }

          saveData(data);
          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Bounty Progress Updated", [
                `Advanced **${updated}** clan bounty${updated === 1 ? "" : "ies"} for **${safe(getServerDisplay(serverId), 100)}**.`,
              ]),
            ],
          }).catch(() => {});
        }

        if (sub === "cashout") {
          const clan = interaction.options.getRole("clan", true);
          const { data, state } = getServerState(interaction.guildId, serverId);
          const entry = state.entries[clan.id];

          if (!entry || Number(entry.amount || 0) <= 0) {
            return interaction.reply({ content: "That clan does not have an active bounty." }).catch(() => {});
          }
          if (Number(entry.wipesPlayed || 0) < 3) {
            return interaction.reply({ content: "That clan is not at Cashout Available yet." }).catch(() => {});
          }

          const cashoutAmount = Number(entry.amount || 0);
          delete state.entries[clan.id];
          saveData(data);

          await upsertBoardMessage(client, interaction.guildId, serverId);

          return interaction.reply({
            embeds: [
              okEmbed("Bounty Cashed Out", [
                `* Clan: ${clan}`,
                `* Cashed Out: **${formatMoney(cashoutAmount, config.currency)}**`,
                `* Status: Removed from the board`,
              ]),
            ],
          }).catch(() => {});
        }

        return interaction.reply({
          embeds: [infoEmbed("Bounties", ["Unknown subcommand."])],
        }).catch(() => {});
      } catch (e) {
        console.error("BOUNTIES MODULE ERROR:", e);
        await safeReply(interaction, { content: "Something broke.", ephemeral: true });
      }
    });
  },
};