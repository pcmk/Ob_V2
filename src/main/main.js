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
    createPetWindow();

    createTray({
      onToggleShow: () => {
        const win = getPetWindow();
        if (!win || win.isDestroyed()) return;
        if (win.isVisible()) win.hide();
        else win.show();
      },
      onOpenNotepad: () => {
        const win = getPetWindow();
        if (!win || win.isDestroyed()) return;
        toggleNotepadWindow(win.getBounds());
      },
      onResetPosition: resetPosition,
      onSetEmotion: (id) => setEmotion(id),
      onToggleWater: (enabled) => reminderService.setEnabled(enabled),
      onQuit: () => app.quit(),
      reminderSettings: reminderService.loadReminderSettings(),
    });

    // Activity engine (autonomous walking/playing/sleeping/tree-climbing)
    // and the water reminder loop are started once the pet window's
    // renderer signals it's ready - see ipcHandlers.js "pet:renderer-ready".
  });

  app.on("window-all-closed", () => {
    // Desktop pet has no "main window" concept - closing the pet window
    // (via tray Quit) is the only real way to exit; ignore the default
    // behavior so the tray icon can keep running the app.
  });
}
