// Defines what the panda *does* physically on screen - idling, walking
// around, playing, napping, or climbing into a tree to sit for a while.
// This is separate from emotions.js (which is the panda's *face*): an
// activity picks a baseline sprite/animation, but a reactive emotion
// (click reaction, water reminder) can still briefly override the face
// on top of whatever activity is happening - e.g. it can react "happy"
// mid-walk without stopping walking.
//
// To add a new activity: add an entry here, then teach
// src/main/services/activityService.js what its movement should look
// like (most activities need none - they're just "sit still and show
// this sprite/animation for a while").

const ACTIVITIES = {
  idle: {
    label: "Idle",
    weight: 5,
    minMs: 6000,
    maxMs: 14000,
    sprite: "🐼",
    animation: "anim-breathe",
  },
  walk: {
    label: "Walking",
    weight: 7,
    // Walking ends when it reaches its destination, not on a timer.
    sprite: "🐼",
    animation: "anim-walk",
  },
  play: {
    label: "Playing",
    weight: 3,
    minMs: 4000,
    maxMs: 8000,
    sprite: "😄",
    animation: "anim-hop",
  },
  sleep: {
    label: "Sleeping",
    weight: 2,
    minMs: 20000,
    maxMs: 45000,
    sprite: "😴",
    animation: "anim-breathe-slow",
    zzz: true,
  },
  tree: {
    label: "In a tree",
    weight: 2,
    // How long it sits up there once it's climbed up.
    minMs: 12000,
    maxMs: 25000,
    sprite: "🐼",
    animation: "anim-breathe",
  },
};

const ACTIVITY_IDS = Object.keys(ACTIVITIES);

function pickNextActivity(excludeId) {
  const choices = ACTIVITY_IDS.filter((id) => id !== excludeId);
  const totalWeight = choices.reduce((sum, id) => sum + ACTIVITIES[id].weight, 0);
  let roll = Math.random() * totalWeight;
  for (const id of choices) {
    roll -= ACTIVITIES[id].weight;
    if (roll <= 0) return id;
  }
  return "idle";
}

function randomDuration(id) {
  const activity = ACTIVITIES[id];
  if (!activity || !activity.minMs) return 6000;
  return activity.minMs + Math.random() * (activity.maxMs - activity.minMs);
}

const api = { ACTIVITIES, ACTIVITY_IDS, pickNextActivity, randomDuration };

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.PandaActivities = api;
}
