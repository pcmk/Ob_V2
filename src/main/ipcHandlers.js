// Central place where renderer <-> main communication is wired up.
// Keeping it all in one file makes it easy to see every message the app
// understands in one glance.
const { ipcMain, Menu } = require("electron");
const store = require("./services/storeService");
const reminderService = require("./services/reminderService");
const activityService = require("./services/activityService");
const { pickLine } = require("../shared/emotions");
const { sendToPet, getPetWindow, resetPosition } = require("./windows/petWindow");
const { toggleNotepadWindow, getNotepadWindow } = require("./windows/notepadWindow");

let startedServices = false;

function setEmotion(id, { line, durationMs } = {}) {
  sendToPet("pet:set-emotion", {
    id,
    line: line ?? pickLine(id),
    durationMs: durationMs ?? 4000,
  });
}

function registerIpcHandlers() {
  // The pet window's renderer tells us once it has finished loading and
  // attached its IPC listeners. We only start pushing activity/emotion
  // updates after that - otherwise the very first messages (the launch
  // greeting, the initial activity) can be sent before anything is
  // listening and silently vanish.
  ipcMain.on("pet:renderer-ready", () => {
    if (startedServices) return;
    startedServices = true;
    activityService.start((payload) => sendToPet("pet:activity", payload));
    reminderService.start(() => setEmotion("thirsty", { durationMs: 8000 }));
    setEmotion("waving", { durationMs: 3000 });
  });

  // Panda reacts when clicked.
  ipcMain.on("pet:clicked", () => {
    setEmotion("happy", { durationMs: 2000 });
  });

  // Little notepad icon on the panda window was clicked.
  ipcMain.on("pet:open-notepad", () => {
    const petWindow = getPetWindow();
    toggleNotepadWindow(petWindow.getBounds());
  });

  // Right-click on the panda -> ask main to pop a context menu.
  ipcMain.on("pet:context-menu", (event) => {
    const petWindow = getPetWindow();
    const reminderSettings = reminderService.loadReminderSettings();
    const menu = Menu.buildFromTemplate([
      { label: "Open Notepad 📝", click: () => toggleNotepadWindow(petWindow.getBounds()) },
      {
        label: "Water Reminders",
        type: "checkbox",
        checked: reminderSettings.enabled,
        click: (item) => reminderService.setEnabled(item.checked),
      },
      { label: "I drank water 💧", click: () => handleDrankWater() },
      { type: "separator" },
      { label: "Reset Position", click: () => resetPosition() },
      { label: "Hide Panda", click: () => petWindow.hide() },
      { type: "separator" },
      { label: "Quit", click: () => require("electron").app.quit() },
    ]);
    menu.popup({ window: petWindow });
  });

  // Notepad window <-> stored notes.
  ipcMain.handle("notes:load", () => {
    return store.load("notes", { text: "" });
  });

  ipcMain.on("notes:save", (event, text) => {
    store.save("notes", { text, updatedAt: Date.now() });
    setEmotion("writing", { durationMs: 1500 });
  });

  ipcMain.on("notepad:close", () => {
    const notepadWindow = getNotepadWindow();
    if (notepadWindow) notepadWindow.hide();
  });
}

function handleDrankWater() {
  reminderService.snooze(reminderService.loadReminderSettings().intervalMinutes);
  setEmotion("love", { line: "Thanks for staying hydrated!", durationMs: 3000 });
}

module.exports = { registerIpcHandlers, setEmotion, handleDrankWater };
