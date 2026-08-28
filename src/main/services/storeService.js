// Tiny JSON-file persistence. No external deps, easy to read and extend.
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DATA_DIR = path.join(app.getPath("userData"), "panda-data");

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load(name, fallback) {
  ensureDir();
  try {
    const raw = fs.readFileSync(filePath(name), "utf-8");
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return { ...fallback };
  }
}

function save(name, data) {
  ensureDir();
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), "utf-8");
}

module.exports = { load, save };
