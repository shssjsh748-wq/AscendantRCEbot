// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS BLOCK to the `commands` array in register.js
// Paste it just before the closing ]; of the commands array
// ─────────────────────────────────────────────────────────────────────────────

new SlashCommandBuilder()
  .setName("vip-panel")
  .setDescription("VIP panel — deploy an embed with a button that gives timed VIP")
  .addSubcommand((sc) =>
    sc
      .setName("deploy")
      .setDescription("Deploy a VIP panel in this channel (admin/owner only)")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("days")
          .setDescription("How many days VIP lasts before auto-removal")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(365)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("config")
      .setDescription("Update the VIP duration on existing panels for a server (admin/owner only)")
      .addStringOption((opt) =>
        opt.setName("server").setDescription("Pick a server").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("days")
          .setDescription("New VIP duration in days")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(365)
      )
  )
  .toJSON(),
