// The sticky-note style window for jotting quick notes.
const { BrowserWindow } = require("electron");
const path = require("path");

let notepadWindow = null;

function createNotepadWindow(anchorBounds) {
  if (notepadWindow && !notepadWindow.isDestroyed()) {
    notepadWindow.show();
    notepadWindow.focus();
    return notepadWindow;
  }

  const x = anchorBounds ? anchorBounds.x - 260 : undefined;
  const y = anchorBounds ? anchorBounds.y : undefined;

  notepadWindow = new BrowserWindow({
    width: 260,
    height: 320,
    x,
    y,
    minWidth: 200,
    minHeight: 220,
    title: "Panda Notes",
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#fff6d8",
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "renderer", "notepad", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notepadWindow.setMenuBarVisibility(false);
  notepadWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "notepad", "index.html"));

  notepadWindow.on("closed", () => {
    notepadWindow = null;
  });

  return notepadWindow;
}

function getNotepadWindow() {
  return notepadWindow;
}

function toggleNotepadWindow(anchorBounds) {
  if (notepadWindow && !notepadWindow.isDestroyed()) {
    if (notepadWindow.isVisible()) {
      notepadWindow.hide();
    } else {
      notepadWindow.show();
      notepadWindow.focus();
    }
    return notepadWindow;
  }
  return createNotepadWindow(anchorBounds);
}

module.exports = { createNotepadWindow, getNotepadWindow, toggleNotepadWindow };
