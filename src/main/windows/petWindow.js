// The always-on-top transparent window the panda itself lives in.
const { BrowserWindow, screen } = require("electron");
const path = require("path");
const store = require("../services/storeService");

const WINDOW_SIZE = { width: 260, height: 260 };

let petWindow = null;
let saveTimer = null;

function defaultPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: width - WINDOW_SIZE.width - 40,
    y: height - WINDOW_SIZE.height - 40,
  };
}

function createPetWindow() {
  const settings = store.load("settings", {});
  const position = settings.petPosition || defaultPosition();

  petWindow = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "renderer", "pet", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // "screen-saver" level keeps the panda above the taskbar and most
  // full-screen-ish windows on Windows, similar to old desktop mascots.
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  petWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "pet", "index.html"));

  petWindow.on("moved", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const [x, y] = petWindow.getPosition();
      const current = store.load("settings", {});
      store.save("settings", { ...current, petPosition: { x, y } });
    }, 300);
  });

  petWindow.on("closed", () => {
    petWindow = null;
  });

  return petWindow;
}

function getPetWindow() {
  return petWindow;
}

function sendToPet(channel, payload) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(channel, payload);
  }
}

function resetPosition() {
  if (!petWindow) return;
  const { x, y } = defaultPosition();
  petWindow.setPosition(x, y);
}

module.exports = { createPetWindow, getPetWindow, sendToPet, resetPosition, WINDOW_SIZE };
