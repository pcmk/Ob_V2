// Right-click / system-tray menu: quick access to everything without
// needing the panda window itself to be visible.
const { Tray, Menu, app } = require("electron");
const path = require("path");
const { EMOTIONS, EMOTION_IDS } = require("../shared/emotions");

let tray = null;

function buildEmotionTestSubmenu(setEmotion) {
  return EMOTION_IDS.map((id) => ({
    label: `${EMOTIONS[id].sprite}  ${EMOTIONS[id].label}`,
    click: () => setEmotion(id),
  }));
}

function createTray({ onToggleShow, onOpenNotepad, onResetPosition, onSetEmotion, onToggleWater, onQuit, reminderSettings }) {
  tray = new Tray(path.join(__dirname, "..", "..", "assets", "tray-icon.png"));
  tray.setToolTip("Desktop Panda Pet");

  const menu = Menu.buildFromTemplate([
    { label: "Show / Hide Panda", click: onToggleShow },
    { label: "Open Notepad 📝", click: onOpenNotepad },
    { type: "separator" },
    {
      label: "Water Reminders",
      type: "checkbox",
      checked: reminderSettings.enabled,
      click: (item) => onToggleWater(item.checked),
    },
    { label: "Reset Panda Position", click: onResetPosition },
    { type: "separator" },
    { label: "Make Panda Feel...", submenu: buildEmotionTestSubmenu(onSetEmotion) },
    { type: "separator" },
    { label: "Quit", click: onQuit },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", onToggleShow);
  return tray;
}

module.exports = { createTray };
