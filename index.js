require("dotenv").config();

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection } = require("discord.js");

const { rce, loadAllServers } = require("./rce");

const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel],
});

client.setMaxListeners(100);
client.on("error", (e) => console.error("[Discord] client error:", e?.message || e));

client.raidguard = new Collection();
client.clanzorp = new Collection();

client.modules = new Collection();
client.trackers = new Collection();
client.events = new Collection();
client.levels = new Collection();
client.maps = new Collection();
client.zonetext = new Collection();

function loadFolder(folderName, targetCollection) {
  const folderPath = path.join(__dirname, folderName);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const failed = [];
  let loaded = 0;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;

      delete require.cache[require.resolve(fullPath)];

      let mod;
      try {
        mod = require(fullPath);
      } catch (e) {
        failed.push(`❌ ${path.relative(folderPath, fullPath)} (require failed: ${e.message})`);
        continue;
      }

      if (!mod?.name || typeof mod.init !== "function") {
        failed.push(`❌ ${path.relative(folderPath, fullPath)} (missing name/init)`);
        continue;
      }

      try {
        mod.init(client, rce);
        targetCollection.set(mod.name, mod);
        loaded++;
      } catch (e) {
        failed.push(`❌ ${mod.name} (${e.message})`);
      }
    }
  }

  walk(folderPath);

  console.log(`[${folderName}] All Loaded (${loaded})`);

  if (failed.length) {
    console.log(`[${folderName}] Failed files:`);
    for (const line of failed) console.log(line);
  }
}

function loadRaidguard() {
  loadFolder("raidguard", client.raidguard);
}

function loadClanZorp() {
  loadFolder("clan-zorp", client.clanzorp);
}

function loadModules() {
  loadFolder("modules", client.modules);
}

function loadTrackers() {
  loadFolder("trackers", client.trackers);
}

function loadEvents() {
  loadFolder("events", client.events);
}

function loadLevels() {
  loadFolder("levels", client.levels);
}

function loadMaps() {
  loadFolder("maps", client.maps);
}

function loadZoneText() {
  loadFolder("zonetext", client.zonetext);
}

function loadRootModules() {
  const folderPath = __dirname;
  const excluded = new Set(["index.js", "register.js", "rce.js"]);
  const failed = [];
  let loaded = 0;

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js") || excluded.has(entry.name)) continue;
    const fullPath = path.join(folderPath, entry.name);

    delete require.cache[require.resolve(fullPath)];

    let mod;
    try {
      mod = require(fullPath);
    } catch (e) {
      failed.push(`❌ ${entry.name} (require failed: ${e.message})`);
      continue;
    }

    if (!mod?.name || typeof mod.init !== "function") {
      failed.push(`❌ ${entry.name} (missing name/init)`);
      continue;
    }

    try {
      mod.init(client, rce);
      client.modules.set(mod.name, mod);
      loaded++;
    } catch (e) {
      failed.push(`❌ ${mod.name} (${e.message})`);
    }
  }

  console.log(`[root modules] All Loaded (${loaded})`);
  if (failed.length) {
    console.log(`[root modules] Failed files:`);
    for (const line of failed) console.log(line);
  }
}


client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  loadRootModules();
  loadRaidguard();
  loadClanZorp();
  loadEvents();
  loadModules();
  loadTrackers();
  loadLevels();
  loadMaps();
  loadZoneText();

  try {
    await loadAllServers();
  } catch (e) {
    console.error("[RCE] loadAllServers error:", e);
  }

  client.emit("clientReady");
});

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK\n");
  })
  .listen(PORT, () => {
    console.log(`[HTTP] Listening on port ${PORT}`);
  });

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err?.message || err);
});

if (!process.env.BOT_TOKEN) {
  console.error("[Startup] Missing BOT_TOKEN environment variable.");
  process.exit(1);
}

client.login(process.env.BOT_TOKEN).catch((err) => {
  console.error("[Discord] login failed:", err?.message || err);
  process.exit(1);
});
