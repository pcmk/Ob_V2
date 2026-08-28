// Renders the panda. Two layers, lowest priority first:
//
//  1. "Baseline" - driven by the main-process activity engine
//     (activityService.js): idle / walking / playing / sleeping / in a
//     tree. Pushed over IPC as "pet:activity" whenever it changes.
//  2. "Forced" - a temporary reactive override (click reaction, water
//     reminder, tray "Make Panda Feel...") pushed as "pet:set-emotion".
//     Shows for durationMs, then automatically reverts back to whatever
//     the baseline currently is.
//
// Talks to main only through window.pandaAPI (see preload.js).

const stage = document.getElementById("stage");
const spriteWrap = document.getElementById("sprite-wrap");
const spriteFlip = document.getElementById("sprite-flip");
const spriteImg = document.getElementById("sprite-img");
const spriteEmoji = document.getElementById("sprite-emoji");
const treeBg = document.getElementById("tree-bg");
const zzz = document.getElementById("zzz");
const bubble = document.getElementById("speech-bubble");
const bubbleText = document.getElementById("speech-text");
const noteBtn = document.getElementById("note-btn");

let baseline = { sprite: "🐼", animation: "anim-breathe", direction: 1, zzz: false, showTree: false };
let forced = false;
let revertTimer = null;
let bubbleTimer = null;

// spriteId is only used to look up a real PNG in assets/sprites/ once one
// exists (see that folder's README) - for pure activity baselines there's
// no id to look up yet, so image fallback is only attempted for named
// emotions.
function render({ sprite, animation, direction, zzz: showZzz, showTree, spriteId }) {
  spriteWrap.className = "";
  void spriteWrap.offsetWidth; // restart the animation even if it's the same class
  spriteWrap.classList.add(animation);

  spriteFlip.style.transform = direction < 0 ? "scaleX(-1)" : "scaleX(1)";

  if (spriteId) {
    spriteImg.onload = () => {
      spriteImg.classList.add("visible");
      spriteEmoji.classList.add("hidden");
    };
    spriteImg.onerror = () => {
      spriteImg.classList.remove("visible");
      spriteEmoji.classList.remove("hidden");
    };
    spriteImg.src = `../../../assets/sprites/${spriteId}.png`;
  } else {
    spriteImg.classList.remove("visible");
    spriteEmoji.classList.remove("hidden");
  }
  spriteEmoji.textContent = sprite;

  zzz.classList.toggle("visible", !!showZzz);
  treeBg.classList.toggle("visible", !!showTree);
}

function applyBaseline() {
  forced = false;
  render(baseline);
}

function showSpeech(text, durationMs) {
  clearTimeout(bubbleTimer);
  if (!text) {
    bubble.classList.remove("visible");
    return;
  }
  bubbleText.textContent = text;
  bubble.classList.add("visible");
  bubbleTimer = setTimeout(() => bubble.classList.remove("visible"), Math.min(durationMs, 6000));
}

function applyForcedEmotion(id, { line, durationMs = 4000 } = {}) {
  const emotion = window.PandaEmotions.EMOTIONS[id] || window.PandaEmotions.EMOTIONS.idle;
  forced = true;
  render({
    sprite: emotion.sprite,
    animation: emotion.animation,
    direction: baseline.direction,
    zzz: false,
    showTree: baseline.showTree,
    spriteId: id,
  });
  showSpeech(line, durationMs);
  clearTimeout(revertTimer);
  revertTimer = setTimeout(applyBaseline, durationMs);
}

// --- main process pushes ---
window.pandaAPI.onSetEmotion(({ id, line, durationMs }) => applyForcedEmotion(id, { line, durationMs }));

window.pandaAPI.onActivity((payload) => {
  baseline = payload;
  if (!forced) applyBaseline();
});

// --- user interactions ---
spriteWrap.addEventListener("click", () => window.pandaAPI.reactClick());

noteBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  window.pandaAPI.openNotepad();
});

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.pandaAPI.openContextMenu();
});

// Show something sensible immediately, then tell main we're ready to
// receive the real launch greeting + first activity update.
applyBaseline();
window.pandaAPI.notifyReady();
