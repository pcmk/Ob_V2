// App entry point. Keeps bootstrapping thin - the real logic lives in
// windows/, services/, ipcHandlers.js and tray.js.
const { app } = require("electron");
const { createPetWindow, getPetWindow, resetPosition } = require("./windows/petWindow");
const { toggleNotepadWindow } = require("./windows/notepadWindow");
const { createTray } = require("./tray");
const { registerIpcHandlers, setEmotion } = require("./ipcHandlers");
const reminderService = require("./services/reminderService");

// Only one instance of the panda should ever run at once.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const petWindow = getPetWindow();
    if (petWindow) {
      petWindow.show();
      petWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    const petWindow = createPetWindow();

    createTray({
      onToggleShow: () => {
        if (petWindow.isVisible()) petWindow.hide();
        else petWindow.show();
      },
      onOpenNotepad: () => toggleNotepadWindow(petWindow.getBounds()),
      onResetPosition: resetPosition,
      onSetEmotion: (id) => setEmotion(id),
      onToggleWater: (enabled) => reminderService.setEnabled(enabled),
      onQuit: () => app.quit(),
      reminderSettings: reminderService.loadReminderSettings(),
    });

    // Water reminder loop: whenever it fires, make the panda visibly thirsty.
    reminderService.start(() => setEmotion("thirsty", { durationMs: 8000 }));

    // Greet on launch.
    setEmotion("waving", { durationMs: 3000 });
  });

  app.on("window-all-closed", () => {
    // Desktop pet has no "main window" concept - closing the pet window
    // (via tray Quit) is the only real way to exit; ignore the default
    // behavior so the tray icon can keep running the app.
  });
}
