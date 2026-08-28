// The always-on-top transparent window the panda itself lives in.
const { BrowserWindow, screen } = require("electron");
const path = require("path");
const store = require("../services/storeService");

const WINDOW_SIZE = { width: 260, height: 260 };

let petWindow = null;
let saveTimer = null;
let programmaticMoveTimer = null;
let isProgrammaticMove = false;
let userDragging = false;
let dragEndTimer = null;

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
    // The panda's window is never meant to be closed on its own (only
    // hidden via the tray, or the whole app quit) - otherwise the tray
    // menu is left holding a reference to a destroyed window.
    closable: false,
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

  // Distinguish the user physically dragging the panda from the activity
  // engine repositioning it 20x/sec while it walks/climbs: every call to
  // movePetWindow() flags isProgrammaticMove briefly, so these handlers
  // only react to *real* drags - otherwise autonomous walking would look
  // like constant dragging and spam-save the window position to disk.
  petWindow.on("move", () => {
    if (isProgrammaticMove) return;
    userDragging = true;
    clearTimeout(dragEndTimer);
    dragEndTimer = setTimeout(() => {
      userDragging = false;
    }, 250);
  });

  petWindow.on("moved", () => {
    if (isProgrammaticMove) return;
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
  movePetWindow(x, y);
}

// The only way the activity engine (or anything else in main) should move
// the window - flags the move as programmatic so it isn't mistaken for a
// user drag (see the "move"/"moved" handlers above).
function movePetWindow(x, y) {
  if (!petWindow || petWindow.isDestroyed()) return;
  isProgrammaticMove = true;
  petWindow.setPosition(Math.round(x), Math.round(y));
  clearTimeout(programmaticMoveTimer);
  programmaticMoveTimer = setTimeout(() => {
    isProgrammaticMove = false;
  }, 30);
}

function isUserDragging() {
  return userDragging;
}

module.exports = {
  createPetWindow,
  getPetWindow,
  sendToPet,
  resetPosition,
  movePetWindow,
  isUserDragging,
  WINDOW_SIZE,
};
