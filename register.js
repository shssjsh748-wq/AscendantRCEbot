// register.js
require("dotenv").config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const TOKEN = process.env.BOT_TOKEN;
const APP_ID = process.env.APP_ID || process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error("[Register] Missing BOT_TOKEN in .env");
  process.exit(1);
}
if (!APP_ID) {
  console.error("[Register] Missing APP_ID (or CLIENT_ID) in .env");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("[Register] Missing GUILD_ID in .env");
  process.exit(1);
}

const commands = [
  // /gameserver (admin only)
  new SlashCommandBuilder()
    .setName("gameserver")
    .setDescription("Manage RCON game servers")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) => sc.setName("add").setDescription("Add a game server (admin only)"))
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a game server (admin only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("delete")
        .setDescription("Delete a game server (admin only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("edit")
        .setDescription("Edit a game server (admin only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("timed-say")
    .setDescription("Send a repeating message to a server chat")
    .addStringOption((opt) =>
      opt
        .setName("server")
        .setDescription("Pick a server")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Message to send in-game")
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("minutes")
        .setDescription("How often to send the message (in minutes)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1440)
    )
    .toJSON(),

    new SlashCommandBuilder()
  .setName("event-config")
  .setDescription("Event configuration")
  .addSubcommand((sc) =>
    sc
      .setName("koth-spawns")
      .setDescription("Configure KOTH spawns (admin/owner, linked)")
      .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((sc) =>
  sc
    .setName("nuketown-spawns")
    .setDescription("Configure Nuketown spawns (admin/owner, linked)")
    .addStringOption((opt) =>
      opt
        .setName("server")
        .setDescription("Pick a server")
        .setRequired(true)
        .setAutocomplete(true)
    )
)
  .toJSON(),
new SlashCommandBuilder()
  .setName("koth")
  .setDescription("KOTH commands")
  .addSubcommand((sc) =>
    sc
      .setName("join")
      .setDescription("Join an active KOTH event")
      .addStringOption((opt) =>
        opt
          .setName("server")
          .setDescription("Pick a server")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .toJSON(),
// /wheel-tps
new SlashCommandBuilder()
  .setName("wheel-tps")
  .setDescription("Wheel teleports (quick chat)")
  .addSubcommand((sc) =>
    sc
      .setName("config")
      .setDescription("Configure a wheel teleport (owner only)")
      .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
      .addStringOption((opt) =>
        opt
          .setName("emote")
          .setDescription("Which quick chat slot")
          .setRequired(true)
          .addChoices(
            { name: "North", value: "north" },
            { name: "South", value: "south" },
            { name: "West", value: "west" }
          )
      )
      .addStringOption((opt) => opt.setName("name").setDescription("Teleport name (e.g. bandit, event)").setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName("combatlock")
          .setDescription("Block while combat locked?")
          .setRequired(true)
          .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })
      )
      .addIntegerOption((opt) => opt.setName("cooldown").setDescription("Cooldown minutes").setRequired(true).setMinValue(0).setMaxValue(10080))
      .addStringOption((opt) =>
        opt
          .setName("coords")
          .setDescription("Manual = enter XYZ, Auto = use your position")
          .setRequired(true)
          .addChoices({ name: "Manual", value: "manual" }, { name: "Auto", value: "auto" })
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("status")
      .setDescription("Enable/disable wheel teleports (owner only)")
      .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
      .addStringOption((opt) =>
        opt
          .setName("emote")
          .setDescription("Which teleport")
          .setRequired(true)
          .addChoices(
            { name: "North", value: "north" },
            { name: "South", value: "south" },
            { name: "West", value: "west" },
            { name: "All", value: "all" }
          )
      )
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("Enable or disable")
          .setRequired(true)
          .addChoices({ name: "Enable", value: "enable" }, { name: "Disable", value: "disable" })
      )
  )
  .toJSON(),

  // /developer
  new SlashCommandBuilder()
    .setName("developer")
    .setDescription("Developer tools")
    .addSubcommand((sc) =>
      sc
        .setName("add-emote")
        .setDescription("Add an emote mapping (developer only)")
        .addStringOption((opt) => opt.setName("emote").setDescription("Raw emote payload").setRequired(true))
        .addStringOption((opt) => opt.setName("name").setDescription("Friendly name").setRequired(true).setAutocomplete(true))
    )
    .toJSON(),

  // /spawn (roles-based in code, but keep admin default here if you want)
  new SlashCommandBuilder()
    .setName("spawn")
    .setDescription("Spawn entities on a server")
    .addStringOption((opt) => opt.setName("server").setDescription("Server").setRequired(true).setAutocomplete(true))
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("What to spawn")
        .setRequired(true)
        .addChoices(
          { name: "Locked Crates", value: "hackablecrate" },
          { name: "Bradley Crates", value: "bradley_crate" },
          { name: "Heli Crates", value: "heli_crate" },
          { name: "Sulfur Nodes", value: "sulfur-ore" },
          { name: "Stone Nodes", value: "stone-ore" },
          { name: "Metal Nodes", value: "metal-ore" }
        )
    )
    .addIntegerOption((opt) => opt.setName("quantity").setDescription("How many (1-300)").setRequired(true).setMinValue(1).setMaxValue(300))
    .addBooleanOption((opt) => opt.setName("cluster").setDescription("Randomize around the position").setRequired(true))
    .toJSON(),

    // /search (player + clan)
new SlashCommandBuilder()
  .setName("search")
  .setDescription("Search player or clan stats")
  .addSubcommand((sc) =>
    sc
      .setName("player")
      .setDescription("Search a player")
      .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
      .addUserOption((opt) => opt.setName("user").setDescription("User to search").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("clan")
      .setDescription("Search a clan")
      .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
      .addRoleOption((opt) => opt.setName("role").setDescription("Clan role").setRequired(true))
  )
  .toJSON(),

  // /setup-roles (admin only)
  new SlashCommandBuilder()
    .setName("setup-roles")
    .setDescription("Setup roles for the bot (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((opt) => opt.setName("admin").setDescription("Admin role").setRequired(true))
    .addRoleOption((opt) => opt.setName("owner").setDescription("Owner role").setRequired(true))
    .addRoleOption((opt) => opt.setName("consolerole").setDescription("Console role").setRequired(true))
    .toJSON(),

  // /deploy-link (owner only in module)
  new SlashCommandBuilder()
    .setName("deploy-link")
    .setDescription("Deploy the account linking panel (owner only)")
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to deploy panel in").setRequired(true))
    .addRoleOption((opt) => opt.setName("role").setDescription("Role to give after linking (optional)").setRequired(false))
    .toJSON(),

  // /total-links
  new SlashCommandBuilder()
    .setName("total-links")
    .setDescription("Show link totals")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("number = count, list = show list (owner only)")
        .setRequired(true)
        .addChoices({ name: "number", value: "number" }, { name: "list", value: "list" })
    )
    .toJSON(),

  // /unlink (owner only in module)
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink by discord or gamertag (owner only)")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("discord or gamertag")
        .setRequired(true)
        .addChoices({ name: "discord", value: "discord" }, { name: "gamertag", value: "gamertag" })
    )
    .addUserOption((opt) => opt.setName("discord").setDescription("User (if type=discord)").setRequired(false))
    .addStringOption((opt) => opt.setName("gamertag").setDescription("Gamertag (if type=gamertag)").setRequired(false))
    .toJSON(),

  // /forcelink (owner only in module)
  new SlashCommandBuilder()
    .setName("forcelink")
    .setDescription("Force link a discord to a gamertag (owner only)")
    .addStringOption((opt) => opt.setName("gamertag").setDescription("Gamertag").setRequired(true))
    .addUserOption((opt) => opt.setName("discord").setDescription("User").setRequired(true))
    .toJSON(),

  // /kits-config (kits + wheelkits)
  new SlashCommandBuilder()
    .setName("kits-config")
    .setDescription("Configure kits (owner only)")
    // normal kits panel/add/remove
    .addSubcommand((sc) =>
      sc
        .setName("panel")
        .setDescription("Deploy the kits panel (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Add a kit config (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("name").setDescription("Display name").setRequired(true))
        .addIntegerOption((opt) => opt.setName("cooldown").setDescription("Cooldown in hours").setRequired(true).setMinValue(1).setMaxValue(9999))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role required to claim").setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a kit config by display name (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("name").setDescription("Display name to remove").setRequired(true))
    )
    // wheelkits panel/add/remove
    .addSubcommand((sc) =>
      sc
        .setName("wheelkits-panel")
        .setDescription("Deploy the wheelkits panel (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("wheelkit-add")
        .setDescription("Add/update a wheelkit config (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("name").setDescription("Display name").setRequired(true))
        .addIntegerOption((opt) => opt.setName("cooldown").setDescription("Cooldown in hours").setRequired(true).setMinValue(1).setMaxValue(9999))
        .addStringOption((opt) => opt.setName("emote").setDescription("Pick an emote name").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("wheelkit-remove")
        .setDescription("Remove a wheelkit config by display name (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("name").setDescription("Display name to remove").setRequired(true))
    )
    .toJSON(),

  // /kits
  new SlashCommandBuilder()
    .setName("kits")
    .setDescription("Claim kits")
    .addSubcommand((sc) =>
      sc
        .setName("claim")
        .setDescription("Claim a kit")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("kit").setDescription("Kit to claim").setRequired(true).setAutocomplete(true))
    )
    .toJSON(),

  // /setup-clans (owner only in module)
  new SlashCommandBuilder()
    .setName("setup-clans")
    .setDescription("Setup clan system for a server (owner only)")
    .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("Clan system type")
        .setRequired(true)
        .addChoices({ name: "Default", value: "default" }, { name: "Advanced", value: "advanced" })
    )
    .toJSON(),

  // /setup-clanrequests (owner only in module)
  new SlashCommandBuilder()
    .setName("setup-clanrequests")
    .setDescription("Set the clan request channel (advanced only) (owner only)")
    .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel for clan create requests").setRequired(true))
    .toJSON(),

  // /setup-activeclans (owner only in module)
  new SlashCommandBuilder()
    .setName("setup-activeclans")
    .setDescription("Deploy Active Clans panel (owner only)")
    .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to send the panel in").setRequired(true))
    .addIntegerOption((opt) =>
      opt.setName("minimum").setDescription("Minimum members to be listed (1 = off)").setRequired(true).setMinValue(1).setMaxValue(5000)
    )
    .toJSON(),

  // /clan
  new SlashCommandBuilder()
    .setName("clan")
    .setDescription("Clan system")
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a clan")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("name").setDescription("Clan name").setRequired(true))
        .addStringOption((opt) => opt.setName("tag").setDescription("Clan tag (1-5 letters)").setRequired(true).setMinLength(1).setMaxLength(5))
        .addStringOption((opt) =>
          opt
            .setName("color")
            .setDescription("Role colour")
            .setRequired(true)
            .addChoices(
              { name: "Red", value: "RED" },
              { name: "Orange", value: "ORANGE" },
              { name: "Yellow", value: "YELLOW" },
              { name: "Green", value: "GREEN" },
              { name: "Blue", value: "BLUE" },
              { name: "Purple", value: "PURPLE" },
              { name: "Pink", value: "PINK" },
              { name: "White", value: "WHITE" },
              { name: "Black", value: "BLACK" }
            )
        )
    )
    .addSubcommand((sc) =>
      sc.setName("join").setDescription("Join a clan").addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc.setName("leave").setDescription("Leave your current clan").addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Transfer clan ownership to another member (leader only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName("user").setDescription("New clan leader").setRequired(true))
        .addStringOption((opt) => opt.setName("confirm").setDescription("Confirm transfer").setRequired(true).addChoices({ name: "yes", value: "yes" }, { name: "no", value: "no" }))
    )
    .addSubcommand((sc) =>
      sc.setName("disband").setDescription("Disband your clan (leader only)").addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc.setName("change-code").setDescription("Change your clan join code (leader only)").addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc.setName("force-add").setDescription("Force add a user to a clan (staff)").addUserOption((opt) => opt.setName("user").setDescription("User to add").setRequired(true)).addRoleOption((opt) => opt.setName("clan").setDescription("Clan role").setRequired(true))
    )
    .addSubcommand((sc) =>
      sc.setName("force-remove").setDescription("Force remove a user from a clan (staff)").addUserOption((opt) => opt.setName("user").setDescription("User to remove").setRequired(true)).addRoleOption((opt) => opt.setName("clan").setDescription("Clan role").setRequired(true))
    )
    .addSubcommand((sc) => sc.setName("remove").setDescription("Remove a clan (staff)").addRoleOption((opt) => opt.setName("clan").setDescription("Clan role").setRequired(true)))
    .addSubcommand((sc) => sc.setName("wipe").setDescription("Wipe ALL clans (owner only)"))
    .addSubcommand((sc) =>
      sc
        .setName("add-milestone")
        .setDescription("Add a clan milestone (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addIntegerOption((opt) => opt.setName("members").setDescription("Members needed to achieve").setRequired(true).setMinValue(1).setMaxValue(5000))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to give to clan members").setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("wipe-milestones")
        .setDescription("Wipe all clan milestones (owner only)")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("view")
        .setDescription("View a clan")
        .addStringOption((opt) => opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName("clan").setDescription("Clan name (type it)").setRequired(true))
    )
    .toJSON(),

 new SlashCommandBuilder()
  .setName("event-koth")
  .setDescription("KOTH event")
  .addSubcommand((sc) =>
    sc
      .setName("start")
      .setDescription("Start a KOTH event (admin/owner)")
      .addStringOption((o) => o.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName("pingrole").setDescription("Role to ping").setRequired(true))
      .addChannelOption((o) => o.setName("channel").setDescription("Channel to post panel").setRequired(true))
      .addIntegerOption((o) => o.setName("time").setDescription("Minutes until start").setRequired(true).setMinValue(0).setMaxValue(10080))
  )
  .addSubcommand((sc) =>
    sc
      .setName("force-end")
      .setDescription("Force end the active KOTH event and set the winner")
      .addStringOption((o) => o.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName("clan").setDescription("Winning clan role").setRequired(true))
  )
  .toJSON(),

  // register.js add
new SlashCommandBuilder()
  .setName("event-sethome")
  .setDescription("Set your clan event home")
  .addStringOption((o) =>
    o.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
  )
  .toJSON(),

// /raidguard
new SlashCommandBuilder()
  .setName("raidguard")
  .setDescription("Raid bubble protection system")
  .addSubcommand((sc) =>
    sc
      .setName("setup")
      .setDescription("Configure raidguard for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addChannelOption((opt) =>
        opt.setName("logs").setDescription("Private logs channel").setRequired(true)
      )
      .addChannelOption((opt) =>
        opt.setName("alerts").setDescription("Public alerts channel").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("size")
          .setDescription("Bubble size (radius)")
          .setRequired(true)
          .setMinValue(10)
          .setMaxValue(200)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("list")
      .setDescription("Show all active bubbles")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove a bubble")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Bubble name").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("force-set")
      .setDescription("Manually set a bubble's protection status")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Bubble name").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("Protection status")
          .setRequired(true)
          .addChoices(
            { name: "Red (Protected)", value: "red" },
            { name: "Green (Unprotected)", value: "green" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("enable")
      .setDescription("Enable raidguard for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("disable")
      .setDescription("Disable raidguard for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("status")
      .setDescription("Check your raidguard status")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .toJSON(),

// /configure-logs
new SlashCommandBuilder()
  .setName("configure-logs")
  .setDescription("Configure the logs system")
  .addStringOption((opt) =>
    opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
  )
  .toJSON(),

// /queueskip
new SlashCommandBuilder()
  .setName("queueskip")
  .setDescription("Queue skip system")

  .addSubcommand((sc) =>
    sc
      .setName("use")
      .setDescription("Use a queue skip")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )

  .addSubcommand((sc) =>
    sc
      .setName("balance")
      .setDescription("Check your queue skip balance")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )

  .addSubcommand((sc) =>
    sc
      .setName("transfer")
      .setDescription("Transfer queue skips to another user")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addUserOption((opt) =>
        opt.setName("user").setDescription("User to send to").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)
      )
  )

  .addSubcommand((sc) =>
    sc
      .setName("give")
      .setDescription("Give queue skips (admin)")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addUserOption((opt) =>
        opt.setName("user").setDescription("User").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)
      )
  )

  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove queue skips (admin)")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addUserOption((opt) =>
        opt.setName("user").setDescription("User").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)
      )
  )

  .addSubcommand((sc) =>
    sc
      .setName("wipeall")
      .setDescription("Wipe all queue skips (admin)")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )

  .toJSON(),
new SlashCommandBuilder()
  .setName("setup-poptracker")
  .setDescription("Setup population tracker channels")
  .addStringOption((opt) =>
    opt.setName("server").setDescription("Pick a server").setRequired(false).setAutocomplete(true)
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("configure-outpost")
  .setDescription("Configure outpost teleports")
  .addStringOption((opt) =>
    opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
  )
  .addRoleOption((opt) =>
    opt.setName("role").setDescription("Role allowed to use outpost").setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt.setName("cooldown").setDescription("Cooldown in minutes").setRequired(true).setMinValue(0).setMaxValue(10080)
  )
  .addStringOption((opt) =>
    opt
      .setName("combatlock")
      .setDescription("Block while in combat")
      .setRequired(true)
      .addChoices(
        { name: "Yes", value: "yes" },
        { name: "No", value: "no" }
      )
  )
  .addStringOption((opt) =>
    opt
      .setName("location")
      .setDescription("Use your current in-game position or enter manually")
      .setRequired(true)
      .addChoices(
        { name: "Auto", value: "auto" },
        { name: "Manual", value: "manual" }
      )
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("outpost")
  .setDescription("Teleport to outpost")
  .addStringOption((opt) =>
    opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
  )
  .toJSON(),
new SlashCommandBuilder()
  .setName("zorp")
  .setDescription("Clan Zorp controls")
  .addSubcommand((sc) =>
    sc
      .setName("get")
      .setDescription("Get zorp status for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("view")
      .setDescription("View zorp entries for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("force")
      .setDescription("Force a zorp status")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("status")
          .setDescription("Off = green, On = red, Grace = grace")
          .setRequired(true)
          .addChoices(
            { name: "Off", value: "off" },
            { name: "On", value: "on" }          
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove a zorp entry or all entries")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName("name").setDescription('Clan name or "all"').setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("grace")
      .setDescription("Put a clan into grace")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("time")
          .setDescription("Grace duration")
          .setRequired(true)
          .addChoices(
            { name: "1 minute", value: "1minute" },
            { name: "1 hour", value: "1hours" },
            { name: "2 hours", value: "2hours" },
            { name: "6 hours", value: "6hours" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("clan").setDescription("Clan name").setRequired(true)
      
    )
  )
  .addSubcommand((sc) =>
  sc
    .setName("check")
    .setDescription("Check your clan zorp status")
    .addStringOption((opt) =>
      opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
    )
)
  .toJSON(),
new SlashCommandBuilder()
  .setName("console")
  .setDescription("Send a raw command to a Rust server")
  .addStringOption((opt) =>
    opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt.setName("command").setDescription("Command to send").setRequired(true)
  )
  .toJSON(),
  new SlashCommandBuilder()
  .setName("setup-leaderboard")
  .setDescription("Deploy the event leaderboard hub")
  .addChannelOption((opt) =>
    opt.setName("channel").setDescription("Channel to send the leaderboard hub in").setRequired(true)
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("event-nuketown")
  .setDescription("Nuketown event")
  .addSubcommand((sc) =>
    sc
      .setName("start")
      .setDescription("Start a Nuketown event (admin/owner)")
      .addStringOption((o) =>
        o.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addRoleOption((o) =>
        o.setName("pingrole").setDescription("Role to ping").setRequired(true)
      )
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel to post panel").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("time").setDescription("Minutes until start").setRequired(true).setMinValue(0).setMaxValue(10080)
      )
      .addStringOption((o) =>
        o
          .setName("teams")
          .setDescription("How many teams")
          .setRequired(true)
          .addChoices(
            { name: "1 Team", value: "1" },
            { name: "2 Teams", value: "2" },
            { name: "3 Teams", value: "3" },
            { name: "4 Teams", value: "4" },
            { name: "5 Teams", value: "5" },
            { name: "6 Teams", value: "6" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("force-end")
      .setDescription("Force end the active Nuketown event")
      .addStringOption((o) =>
        o.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .toJSON(),
new SlashCommandBuilder()
  .setName("bounties")
  .setDescription("Bounty board system")
  .addSubcommand((sc) =>
    sc
      .setName("setup")
      .setDescription("Setup the bounty board")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("Channel to send the bounty board in").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("currency")
          .setDescription("Currency to use")
          .setRequired(true)
          .addChoices(
            { name: "GBP", value: "gbp" },
            { name: "AUD", value: "aud" },
            { name: "USD", value: "usd" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("reset")
      .setDescription("Reset all bounties, progress, and grids for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Add bounty cash to a clan")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addRoleOption((opt) =>
        opt.setName("clan").setDescription("Clan role").setRequired(true)
      )
      .addNumberOption((opt) =>
        opt.setName("amount").setDescription("Amount to add").setRequired(true).setMinValue(0.01)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove fixed cash or percentage from a clan bounty")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addRoleOption((opt) =>
        opt.setName("clan").setDescription("Clan role").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("Remove a number or percentage")
          .setRequired(true)
          .addChoices(
            { name: "Number", value: "number" },
            { name: "Percentage", value: "percentage" }
          )
      )
      .addNumberOption((opt) =>
        opt.setName("amount").setDescription("50 = £50 or 50% depending on type").setRequired(true).setMinValue(0)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("setgrid")
      .setDescription("Set a clan grid for the bounty board")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addRoleOption((opt) =>
        opt.setName("clan").setDescription("Clan role").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("grid").setDescription("Grid like F20").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("progress")
      .setDescription("Move every active bounty up by 1 wipe")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("cashout")
      .setDescription("Cash out a clan that reached 3/3 wipes")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addRoleOption((opt) =>
        opt.setName("clan").setDescription("Clan role").setRequired(true)
      )
  )
  .toJSON(),
new SlashCommandBuilder()
  .setName("map")
  .setDescription("Map database tools")
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Add a map to a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName("map").setDescription("Map image URL").setRequired(true)
      )
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("maps")
  .setDescription("Manage server maps")
  .addSubcommand((sc) =>
    sc
      .setName("wipe")
      .setDescription("Wipe all maps for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("view")
      .setDescription("View all maps for a server")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("prioritise")
      .setDescription("Prioritise a map for the next vote")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("map").setDescription("Unique map number").setRequired(true).setMinValue(1)
      )
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("mapvote")
  .setDescription("Map vote system")
  .addSubcommand((sc) =>
    sc
      .setName("start")
      .setDescription("Start a map vote")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("duration").setDescription("Minutes until vote ends").setRequired(true).setMinValue(1).setMaxValue(10080)
      )
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("Channel to send vote in").setRequired(true)
      )
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("Role to ping").setRequired(true)
      )
  )
  .toJSON(),
new SlashCommandBuilder()
  .setName("configure-feeds")
  .setDescription("Configure live feed channels")
  .addStringOption((opt) =>
    opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
  )
  .addChannelOption((opt) =>
    opt.setName("killfeed").setDescription("Killfeed channel").setRequired(true)
  )
  .toJSON(),
new SlashCommandBuilder()
  .setName("spawnhypes")
  .setDescription("Spawn Hypes vending-machine art")
  .addStringOption((opt) =>
    opt
      .setName("server")
      .setDescription("Pick a server")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .toJSON(),
new SlashCommandBuilder()
  .setName("zonetext")
  .setDescription("Configure zone text features")
  .addStringOption((opt) =>
    opt
      .setName("server")
      .setDescription("Pick a server")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("set")
      .setDescription("Which zone text set")
      .setRequired(true)
      .addChoices({ name: "Tips", value: "tips" })
  )
  .addStringOption((opt) =>
    opt
      .setName("status")
      .setDescription("Enable or disable")
      .setRequired(true)
      .addChoices(
        { name: "On", value: "on" },
        { name: "Off", value: "off" }
      )
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("authgroup")
  .setDescription("Manage in-game auth groups (VIP, Mod, Admin, Owner)")
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Give a player an auth group role")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addUserOption((opt) =>
        opt.setName("user").setDescription("Discord user to give the role to").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("role")
          .setDescription("Auth group role to assign")
          .setRequired(true)
          .addChoices(
            { name: "VIP",       value: "vip" },
            { name: "Moderator", value: "moderator" },
            { name: "Admin",     value: "admin" },
            { name: "Owner",     value: "owner" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove an auth group role from a player")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addUserOption((opt) =>
        opt.setName("user").setDescription("Discord user to remove the role from").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("role")
          .setDescription("Auth group role to remove")
          .setRequired(true)
          .addChoices(
            { name: "VIP",       value: "vip" },
            { name: "Moderator", value: "moderator" },
            { name: "Admin",     value: "admin" },
            { name: "Owner",     value: "owner" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("list")
      .setDescription("List all players in each auth group")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove-all")
      .setDescription("Remove ALL players from every auth group (destructive)")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
  )
  .toJSON(),

new SlashCommandBuilder()
  .setName("whois")
  .setDescription("Look up a linked user's gamertag, stats, and history")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Discord user to look up").setRequired(true)
  )
  .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(`[Register] Registering ${commands.length} guild commands...`);
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("[Register] Done.");
  } catch (err) {
    console.error("[Register] Error:", err);
    process.exit(1);
  }
})();