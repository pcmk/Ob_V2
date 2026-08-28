// The single source of truth for every panda emotion.
//
// To add a new emotion: add one entry below. Nothing else needs to change -
// the renderer picks up new keys automatically for random idle cycling,
// the tray "Test emotions" menu lists them automatically, etc.
//
// sprite: placeholder emoji shown until real art is dropped into
// assets/sprites/<id>.png (see assets/sprites/README.md). Once that file
// exists the renderer will use it automatically instead of the emoji.
//
// animation: name of a CSS animation class defined in pet.css.
// lines: things the panda says in its speech bubble for this emotion.
// category: "positive" | "negative" | "neutral" - used to pick a
//   reasonable random idle emotion without ending up sad all day.
// idleWeight: relative chance this emotion is chosen during idle
//   random-cycling. 0 = never chosen randomly, only triggered on purpose.

const EMOTIONS = {
  idle: {
    label: "Idle",
    sprite: "🐼",
    animation: "anim-breathe",
    category: "neutral",
    idleWeight: 10,
    lines: ["...", "*looks around*", "hmm?"],
  },
  happy: {
    label: "Happy",
    sprite: "😊",
    animation: "anim-bounce",
    category: "positive",
    idleWeight: 6,
    lines: ["Today's a good day!", "Yay!", "I'm happy you're here."],
  },
  excited: {
    label: "Excited",
    sprite: "🥳",
    animation: "anim-jump",
    category: "positive",
    idleWeight: 3,
    lines: ["This is so exciting!!", "Let's gooo!"],
  },
  love: {
    label: "Loving",
    sprite: "🥰",
    animation: "anim-pulse",
    category: "positive",
    idleWeight: 2,
    lines: ["I love hanging out with you.", "<3"],
  },
  cheer: {
    label: "Cheering",
    sprite: "🎉",
    animation: "anim-jump",
    category: "positive",
    idleWeight: 0,
    lines: ["You've got this!", "Go go go!", "I believe in you!", "So proud of you!"],
  },
  proud: {
    label: "Proud",
    sprite: "😎",
    animation: "anim-bounce",
    category: "positive",
    idleWeight: 1,
    lines: ["Look at you go.", "Nailed it."],
  },
  playful: {
    label: "Playful",
    sprite: "😄",
    animation: "anim-wiggle",
    category: "positive",
    idleWeight: 3,
    lines: ["Wanna play?", "Poke me again, I dare you."],
  },
  dancing: {
    label: "Dancing",
    sprite: "🕺",
    animation: "anim-dance",
    category: "positive",
    idleWeight: 1,
    lines: ["Dance break!", "Feel the rhythm~"],
  },
  laughing: {
    label: "Laughing",
    sprite: "😂",
    animation: "anim-wiggle",
    category: "positive",
    idleWeight: 1,
    lines: ["Hahaha!", "That got me!"],
  },
  relaxed: {
    label: "Relaxed",
    sprite: "😌",
    animation: "anim-breathe",
    category: "positive",
    idleWeight: 4,
    lines: ["Ahh, nice and calm.", "Just vibing."],
  },
  sleepy: {
    label: "Sleepy",
    sprite: "😴",
    animation: "anim-breathe-slow",
    category: "neutral",
    idleWeight: 3,
    lines: ["*yawn*", "Getting sleepy...", "Zzz..."],
  },
  sleeping: {
    label: "Sleeping",
    sprite: "💤",
    animation: "anim-breathe-slow",
    category: "neutral",
    idleWeight: 0,
    lines: ["Zzz... zzz..."],
  },
  bored: {
    label: "Bored",
    sprite: "😑",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 2,
    lines: ["I'm booored.", "Do something with me?"],
  },
  curious: {
    label: "Curious",
    sprite: "🤨",
    animation: "anim-tilt",
    category: "neutral",
    idleWeight: 3,
    lines: ["What's that?", "Ooh, interesting."],
  },
  thinking: {
    label: "Thinking",
    sprite: "🤔",
    animation: "anim-tilt",
    category: "neutral",
    idleWeight: 2,
    lines: ["Hmm, let me think...", "Give me a sec."],
  },
  confused: {
    label: "Confused",
    sprite: "😕",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 1,
    lines: ["Wait, what?", "I'm lost."],
  },
  surprised: {
    label: "Surprised",
    sprite: "😮",
    animation: "anim-jump",
    category: "neutral",
    idleWeight: 0,
    lines: ["Whoa!", "Didn't expect that!"],
  },
  shy: {
    label: "Shy",
    sprite: "😳",
    animation: "anim-sway",
    category: "neutral",
    idleWeight: 1,
    lines: ["Aw, stop it...", "*hides face*"],
  },
  sad: {
    label: "Sad",
    sprite: "😢",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 1,
    lines: ["Feeling a little down.", "Could use a kind word."],
  },
  crying: {
    label: "Crying",
    sprite: "😭",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 0,
    lines: ["*sniff*", "I'll be okay..."],
  },
  worried: {
    label: "Worried",
    sprite: "😟",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 1,
    lines: ["Everything okay over there?", "I'm a little worried."],
  },
  angry: {
    label: "Angry",
    sprite: "😠",
    animation: "anim-shake",
    category: "negative",
    idleWeight: 0,
    lines: ["Grr!", "Not happy about this."],
  },
  scared: {
    label: "Scared",
    sprite: "😨",
    animation: "anim-shake",
    category: "negative",
    idleWeight: 0,
    lines: ["Eek!", "That startled me."],
  },
  sick: {
    label: "Sick",
    sprite: "🤒",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 0,
    lines: ["Not feeling great...", "*cough*"],
  },
  hungry: {
    label: "Hungry",
    sprite: "🍽️",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 2,
    lines: ["Got any bamboo?", "My tummy is rumbling."],
  },
  thirsty: {
    label: "Thirsty",
    sprite: "💧",
    animation: "anim-tilt",
    category: "negative",
    idleWeight: 0,
    lines: ["Hey, drink some water!", "Hydration check! Have some water 💧", "Time for a water break!"],
  },
  writing: {
    label: "Writing",
    sprite: "📝",
    animation: "anim-tilt",
    category: "neutral",
    idleWeight: 0,
    lines: ["Writing that down...", "Noted!"],
  },
  waving: {
    label: "Waving",
    sprite: "👋",
    animation: "anim-wiggle",
    category: "positive",
    idleWeight: 0,
    lines: ["Hey there!", "Hi!! Missed you."],
  },
  determined: {
    label: "Determined",
    sprite: "😤",
    animation: "anim-bounce",
    category: "positive",
    idleWeight: 1,
    lines: ["Let's focus.", "We can get through this."],
  },
  mischievous: {
    label: "Mischievous",
    sprite: "😏",
    animation: "anim-wiggle",
    category: "neutral",
    idleWeight: 1,
    lines: ["Heheh...", "I might have moved your cursor. Maybe."],
  },
};

const EMOTION_IDS = Object.keys(EMOTIONS);

function pickRandomIdleEmotion() {
  const weighted = EMOTION_IDS.filter((id) => EMOTIONS[id].idleWeight > 0);
  const totalWeight = weighted.reduce((sum, id) => sum + EMOTIONS[id].idleWeight, 0);
  let roll = Math.random() * totalWeight;
  for (const id of weighted) {
    roll -= EMOTIONS[id].idleWeight;
    if (roll <= 0) return id;
  }
  return "idle";
}

function pickLine(emotionId) {
  const emotion = EMOTIONS[emotionId] || EMOTIONS.idle;
  const lines = emotion.lines || [""];
  return lines[Math.floor(Math.random() * lines.length)];
}

const api = { EMOTIONS, EMOTION_IDS, pickRandomIdleEmotion, pickLine };

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.PandaEmotions = api;
}
