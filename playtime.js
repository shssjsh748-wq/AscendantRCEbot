const fs = require("fs");
const path = require("path");

const PLAYTIME_PATH = path.join(__dirname, "..", "..", "global-data", "playtime.json");

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

function readPlaytime() {
  return readJsonSafe(PLAYTIME_PATH, {});
}

function writePlaytime(data) {
  writeJsonSafe(PLAYTIME_PATH, data);
}

module.exports = { readPlaytime, writePlaytime };