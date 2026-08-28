// The single source of truth for every panda emotion.
//
// To add a new emotion: add one entry below. Nothing else needs to change -
// the renderer picks up new keys automatically for random idle cycling,
// the tray "Test emotions" menu lists them automatically, etc.
//
// sprite: the base character shown, always the panda itself (🐼) unless a
//   dedicated PNG exists for this exact id (assets/sprites/<id>.png, see
//   that folder's README) - once one does, it's used automatically and
//   replaces both the emoji and the accent badge below.
// accent: a small badge emoji shown next to the panda to convey the mood
//   without swapping the character out for an unrelated face. null = no
//   badge, just the animation/speech line carries the mood.
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
    accent: null,
    animation: "anim-breathe",
    category: "neutral",
    idleWeight: 10,
    lines: ["...", "*looks around*", "hmm?"],
  },
  happy: {
    label: "Happy",
    sprite: "🐼",
    accent: "😊",
    animation: "anim-bounce",
    category: "positive",
    idleWeight: 6,
    lines: ["Today's a good day!", "Yay!", "I'm happy you're here."],
  },
  excited: {
    label: "Excited",
    sprite: "🐼",
    accent: "✨",
    animation: "anim-jump",
    category: "positive",
    idleWeight: 3,
    lines: ["This is so exciting!!", "Let's gooo!"],
  },
  love: {
    label: "Loving",
    sprite: "🐼",
    accent: "🥰",
    animation: "anim-pulse",
    category: "positive",
    idleWeight: 2,
    lines: ["I love hanging out with you.", "<3"],
  },
  cheer: {
    label: "Cheering",
    sprite: "🐼",
    accent: "🎉",
    animation: "anim-jump",
    category: "positive",
    idleWeight: 0,
    lines: ["You've got this!", "Go go go!", "I believe in you!", "So proud of you!"],
  },
  proud: {
    label: "Proud",
    sprite: "🐼",
    accent: "⭐",
    animation: "anim-bounce",
    category: "positive",
    idleWeight: 1,
    lines: ["Look at you go.", "Nailed it."],
  },
  playful: {
    label: "Playful",
    sprite: "🐼",
    accent: "😄",
    animation: "anim-wiggle",
    category: "positive",
    idleWeight: 3,
    lines: ["Wanna play?", "Poke me again, I dare you."],
  },
  dancing: {
    label: "Dancing",
    sprite: "🐼",
    accent: "🎵",
    animation: "anim-dance",
    category: "positive",
    idleWeight: 1,
    lines: ["Dance break!", "Feel the rhythm~"],
  },
  laughing: {
    label: "Laughing",
    sprite: "🐼",
    accent: "😂",
    animation: "anim-wiggle",
    category: "positive",
    idleWeight: 1,
    lines: ["Hahaha!", "That got me!"],
  },
  relaxed: {
    label: "Relaxed",
    sprite: "🐼",
    accent: "😌",
    animation: "anim-breathe",
    category: "positive",
    idleWeight: 4,
    lines: ["Ahh, nice and calm.", "Just vibing."],
  },
  sleepy: {
    label: "Sleepy",
    sprite: "🐼",
    accent: "😴",
    animation: "anim-breathe-slow",
    category: "neutral",
    idleWeight: 3,
    lines: ["*yawn*", "Getting sleepy...", "Zzz..."],
  },
  sleeping: {
    label: "Sleeping",
    sprite: "🐼",
    accent: "💤",
    animation: "anim-breathe-slow",
    category: "neutral",
    idleWeight: 0,
    lines: ["Zzz... zzz..."],
  },
  bored: {
    label: "Bored",
    sprite: "🐼",
    accent: "😑",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 2,
    lines: ["I'm booored.", "Do something with me?"],
  },
  curious: {
    label: "Curious",
    sprite: "🐼",
    accent: "❓",
    animation: "anim-tilt",
    category: "neutral",
    idleWeight: 3,
    lines: ["What's that?", "Ooh, interesting."],
  },
  thinking: {
    label: "Thinking",
    sprite: "🐼",
    accent: "💭",
    animation: "anim-tilt",
    category: "neutral",
    idleWeight: 2,
    lines: ["Hmm, let me think...", "Give me a sec."],
  },
  confused: {
    label: "Confused",
    sprite: "🐼",
    accent: "❓",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 1,
    lines: ["Wait, what?", "I'm lost."],
  },
  surprised: {
    label: "Surprised",
    sprite: "🐼",
    accent: "❗",
    animation: "anim-jump",
    category: "neutral",
    idleWeight: 0,
    lines: ["Whoa!", "Didn't expect that!"],
  },
  shy: {
    label: "Shy",
    sprite: "🐼",
    accent: "😳",
    animation: "anim-sway",
    category: "neutral",
    idleWeight: 1,
    lines: ["Aw, stop it...", "*hides face*"],
  },
  sad: {
    label: "Sad",
    sprite: "🐼",
    accent: "😢",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 1,
    lines: ["Feeling a little down.", "Could use a kind word."],
  },
  crying: {
    label: "Crying",
    sprite: "🐼",
    accent: "😭",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 0,
    lines: ["*sniff*", "I'll be okay..."],
  },
  worried: {
    label: "Worried",
    sprite: "🐼",
    accent: "😟",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 1,
    lines: ["Everything okay over there?", "I'm a little worried."],
  },
  angry: {
    label: "Angry",
    sprite: "🐼",
    accent: "💢",
    animation: "anim-shake",
    category: "negative",
    idleWeight: 0,
    lines: ["Grr!", "Not happy about this."],
  },
  scared: {
    label: "Scared",
    sprite: "🐼",
    accent: "😨",
    animation: "anim-shake",
    category: "negative",
    idleWeight: 0,
    lines: ["Eek!", "That startled me."],
  },
  sick: {
    label: "Sick",
    sprite: "🐼",
    accent: "🤒",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 0,
    lines: ["Not feeling great...", "*cough*"],
  },
  hungry: {
    label: "Hungry",
    sprite: "🐼",
    accent: "🍽️",
    animation: "anim-sway",
    category: "negative",
    idleWeight: 2,
    lines: ["Got any bamboo?", "My tummy is rumbling."],
  },
  thirsty: {
    label: "Thirsty",
    sprite: "🐼",
    accent: "💧",
    animation: "anim-tilt",
    category: "negative",
    idleWeight: 0,
    lines: ["Hey, drink some water!", "Hydration check! Have some water 💧", "Time for a water break!"],
  },
  writing: {
    label: "Writing",
    sprite: "🐼",
    accent: "📝",
    animation: "anim-tilt",
    category: "neutral",
    idleWeight: 0,
    lines: ["Writing that down...", "Noted!"],
  },
  waving: {
    label: "Waving",
    sprite: "🐼",
    accent: "👋",
    animation: "anim-wiggle",
    category: "positive",
    idleWeight: 0,
    lines: ["Hey there!", "Hi!! Missed you."],
  },
  determined: {
    label: "Determined",
    sprite: "🐼",
    accent: "😤",
    animation: "anim-bounce",
    category: "positive",
    idleWeight: 1,
    lines: ["Let's focus.", "We can get through this."],
  },
  mischievous: {
    label: "Mischievous",
    sprite: "🐼",
    accent: "😏",
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
