const fs = require("fs");
const path = require("path");

const KILLS_PATH = path.join(__dirname, "kills.json");

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

function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function readKills() {
  return readJsonSafe(KILLS_PATH, {});
}

function writeKills(data) {
  writeJsonSafe(KILLS_PATH, data);
}

module.exports = { readKills, writeKills };