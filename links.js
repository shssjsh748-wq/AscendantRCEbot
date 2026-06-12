const fs = require("fs");
const path = require("path");

const LINKS_PATH = path.join(__dirname, "links.json");

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
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readLinks() {
  return readJsonSafe(LINKS_PATH, {});
}

function writeLinks(data) {
  writeJsonSafe(LINKS_PATH, data);
}

module.exports = { readLinks, writeLinks };