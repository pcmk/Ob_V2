// Drives what the panda physically does on screen: standing around,
// walking somewhere new, playing, napping, or walking to a spot and
// climbing a tree to sit for a while. Owns a ~20fps ticker that nudges
// the actual OS window around via movePetWindow() - that's what makes
// "walking" look like smooth movement rather than teleporting.
const { screen } = require("electron");
const { getPetWindow, movePetWindow, isUserDragging, WINDOW_SIZE } = require("../windows/petWindow");
const { ACTIVITIES, pickNextActivity, randomDuration } = require("../../shared/activities");

const TICK_MS = 50;
const WALK_SPEED = 4; // px per tick (~80px/sec)
const CLIMB_SPEED = 3; // px per tick
const HOP_SPEED = 5; // px per tick, jitter while playing
const TREE_RISE = 130; // how high above the ground it perches, in px
const MIN_WALK_DISTANCE = 120; // don't bother "walking" somewhere trivially close

let tickTimer = null;
let onUpdate = null;

let activity = "idle";
let phase = "main"; // tree only: approach | climb | perch | descend
let phaseEndAt = 0;
let direction = 1;
let walkTargetX = null;
let treeX = null;

function bounds() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return {
    minX: x + 10,
    maxX: x + width - WINDOW_SIZE.width - 10,
    groundY: y + height - WINDOW_SIZE.height - 40,
  };
}

function emitUpdate() {
  if (!onUpdate) return;
  const meta = ACTIVITIES[activity] || ACTIVITIES.idle;

  // Which real-art file to look for in assets/sprites/ (falls back to the
  // emoji if it doesn't exist yet - see that folder's README). Walking to
  // the tree still *looks like* walking, so it borrows the "walk" art;
  // once up there (climbing/perched/climbing back down) it borrows "tree".
  let spriteId = activity;
  if (activity === "tree") spriteId = phase === "approach" ? "walk" : "tree";

  onUpdate({
    activity,
    phase,
    direction,
    sprite: meta.sprite,
    animation: meta.animation,
    zzz: !!meta.zzz,
    showTree: activity === "tree" && phase !== "approach",
    spriteId,
  });
}

function startActivity(id) {
  activity = id;
  phase = "main";
  const win = getPetWindow();
  if (!win || win.isDestroyed()) return;
  const b = bounds();
  const [curX] = win.getPosition();

  if (id === "walk") {
    let target = b.minX + Math.random() * (b.maxX - b.minX);
    if (Math.abs(target - curX) < MIN_WALK_DISTANCE) {
      target = target < curX ? Math.max(b.minX, curX - 200) : Math.min(b.maxX, curX + 200);
    }
    walkTargetX = target;
    direction = target >= curX ? 1 : -1;
  } else if (id === "tree") {
    if (treeX === null || treeX < b.minX || treeX > b.maxX) {
      treeX = b.minX + Math.random() * (b.maxX - b.minX);
    }
    phase = "approach";
    walkTargetX = treeX;
    direction = treeX >= curX ? 1 : -1;
  } else {
    // idle, sleep, play all just sit wherever they already are.
    phaseEndAt = Date.now() + randomDuration(id);
  }

  emitUpdate();
}

function finishAndPickNext() {
  startActivity(pickNextActivity(activity));
}

function tick() {
  if (isUserDragging()) return;
  const win = getPetWindow();
  if (!win || win.isDestroyed()) return;

  const b = bounds();
  const [curX, curY] = win.getPosition();

  if (activity === "walk") {
    const dx = walkTargetX - curX;
    if (Math.abs(dx) <= WALK_SPEED) {
      movePetWindow(walkTargetX, b.groundY);
      finishAndPickNext();
      return;
    }
    movePetWindow(curX + (dx > 0 ? WALK_SPEED : -WALK_SPEED), b.groundY);
  } else if (activity === "play") {
    const jitter = (Math.random() - 0.5) * HOP_SPEED * 2;
    const nextX = Math.max(b.minX, Math.min(b.maxX, curX + jitter));
    if (nextX !== curX) direction = nextX >= curX ? 1 : -1;
    movePetWindow(nextX, b.groundY);
    if (Date.now() >= phaseEndAt) finishAndPickNext();
  } else if (activity === "tree") {
    tickTreeActivity(b, curX, curY);
  } else {
    // idle / sleep: stationary, just watching the clock.
    if (Date.now() >= phaseEndAt) finishAndPickNext();
  }
}

function tickTreeActivity(b, curX, curY) {
  if (phase === "approach") {
    const dx = walkTargetX - curX;
    if (Math.abs(dx) <= WALK_SPEED) {
      movePetWindow(walkTargetX, b.groundY);
      phase = "climb";
      emitUpdate();
      return;
    }
    movePetWindow(curX + (dx > 0 ? WALK_SPEED : -WALK_SPEED), b.groundY);
  } else if (phase === "climb") {
    const targetY = b.groundY - TREE_RISE;
    if (curY - targetY <= CLIMB_SPEED) {
      movePetWindow(treeX, targetY);
      phase = "perch";
      phaseEndAt = Date.now() + randomDuration("tree");
      emitUpdate();
      return;
    }
    movePetWindow(treeX, curY - CLIMB_SPEED);
  } else if (phase === "perch") {
    if (Date.now() >= phaseEndAt) {
      phase = "descend";
      emitUpdate();
    }
  } else if (phase === "descend") {
    if (b.groundY - curY <= CLIMB_SPEED) {
      movePetWindow(treeX, b.groundY);
      finishAndPickNext();
      return;
    }
    movePetWindow(treeX, curY + CLIMB_SPEED);
  }
}

function start(onUpdateCallback) {
  onUpdate = onUpdateCallback;
  startActivity("idle");
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK_MS);
}

function stop() {
  clearInterval(tickTimer);
}

function getCurrentActivity() {
  return activity;
}

module.exports = { start, stop, getCurrentActivity };
