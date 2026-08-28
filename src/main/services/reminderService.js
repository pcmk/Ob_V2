// Drives the "go drink water" nudge. Pure timer logic, no window/UI code
// here - it just calls the callbacks it's given.
const { Notification } = require("electron");
const store = require("../services/storeService");

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 60,
};

let timer = null;
let onTrigger = null;

function loadReminderSettings() {
  const settings = store.load("settings", {});
  return { ...DEFAULTS, ...(settings.waterReminder || {}) };
}

function saveReminderSettings(partial) {
  const settings = store.load("settings", {});
  const merged = { ...DEFAULTS, ...(settings.waterReminder || {}), ...partial };
  store.save("settings", { ...settings, waterReminder: merged });
  return merged;
}

function scheduleNext(minutes) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fire();
  }, Math.max(1, minutes) * 60 * 1000);
}

function fire() {
  const settings = loadReminderSettings();
  if (settings.enabled && onTrigger) {
    onTrigger();
    new Notification({
      title: "🐼 Time for water!",
      body: "Your panda wants you to stay hydrated. Take a sip!",
    }).show();
  }
  scheduleNext(settings.intervalMinutes);
}

function start(onTriggerCallback) {
  onTrigger = onTriggerCallback;
  const settings = loadReminderSettings();
  scheduleNext(settings.intervalMinutes);
}

function stop() {
  clearTimeout(timer);
}

function snooze(minutes = 10) {
  scheduleNext(minutes);
}

function setEnabled(enabled) {
  const settings = saveReminderSettings({ enabled });
  scheduleNext(settings.intervalMinutes);
  return settings;
}

function setIntervalMinutes(intervalMinutes) {
  const settings = saveReminderSettings({ intervalMinutes });
  scheduleNext(settings.intervalMinutes);
  return settings;
}

module.exports = {
  start,
  stop,
  snooze,
  setEnabled,
  setIntervalMinutes,
  loadReminderSettings,
};
