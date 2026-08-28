// Renders the panda: current sprite/emoji, its animation, and its speech
// bubble. Talks to main only through window.pandaAPI (see preload.js).

const spriteWrap = document.getElementById("sprite-wrap");
const spriteImg = document.getElementById("sprite-img");
const spriteEmoji = document.getElementById("sprite-emoji");
const bubble = document.getElementById("speech-bubble");
const bubbleText = document.getElementById("speech-text");
const noteBtn = document.getElementById("note-btn");

let forcedUntil = 0;
let bubbleTimer = null;

function setSprite(id) {
  const emotion = window.PandaEmotions.EMOTIONS[id] || window.PandaEmotions.EMOTIONS.idle;

  spriteWrap.className = "";
  // Force reflow so the animation restarts even if it's the same class.
  void spriteWrap.offsetWidth;
  spriteWrap.classList.add(emotion.animation);

  // Real art drops into assets/sprites/<id>.png and is used automatically;
  // until then (or if it's missing) we fall back to the emoji placeholder.
  spriteImg.onload = () => {
    spriteImg.classList.add("visible");
    spriteEmoji.classList.add("hidden");
  };
  spriteImg.onerror = () => {
    spriteImg.classList.remove("visible");
    spriteEmoji.classList.remove("hidden");
  };
  spriteImg.src = `../../../assets/sprites/${id}.png`;
  spriteEmoji.textContent = emotion.sprite;
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

function applyEmotion(id, { line, durationMs = 4000, silent = false } = {}) {
  setSprite(id);
  showSpeech(silent ? null : line, durationMs);
  forcedUntil = Date.now() + durationMs;
}

// --- react to the main process (water reminders, click reactions, tray "Make Panda Feel...") ---
window.pandaAPI.onSetEmotion(({ id, line, durationMs }) => {
  applyEmotion(id, { line, durationMs });
});

// --- idle behaviour: cycle through moods on its own when nothing else is happening ---
function idleTick() {
  if (Date.now() >= forcedUntil) {
    const id = window.PandaEmotions.pickRandomIdleEmotion();
    const showLine = Math.random() < 0.35;
    applyEmotion(id, {
      line: showLine ? window.PandaEmotions.pickLine(id) : null,
      durationMs: 6000,
      silent: !showLine,
    });
  }
  setTimeout(idleTick, 8000 + Math.random() * 10000);
}

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

setSprite("idle");
idleTick();
