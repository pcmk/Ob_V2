# 🐼 Desktop Panda Pet

A real desktop companion panda for Windows — it walks around on top of
your screen, plays, naps, climbs into a tree to sit for a while, reacts
with a full range of emotions, nudges you to drink water, and keeps a
little notepad. Not a demo: it's meant to actually run in your system
tray every day.

## Running it (Windows)

Requires [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start
```

The panda will appear in the bottom-right of your screen and an icon will
appear in your system tray.

- **Watch it** — left alone, it wanders on its own: idling, walking to a
  new spot, playing, napping, or walking over to a tree and climbing up
  to sit in it for a while.
- **Drag** the panda anywhere on screen — its position is remembered, and
  it resumes wandering from wherever you drop it.
- **Click** the panda to make it react.
- **Right-click** the panda (or the tray icon) for the menu: open the
  notepad, toggle water reminders, test emotions, reset position, quit.
- **Hover** the panda to reveal a small 📝 button that opens the notepad
  directly.

## Building a real installer (`.exe`)

```bash
npm run dist
```

This uses `electron-builder` to produce a Windows installer in `release/`.

## Project structure

```
src/
  main/                 Electron main process (Node side)
    main.js              App bootstrap
    tray.js               System tray menu
    ipcHandlers.js         All renderer <-> main messages, in one place
    windows/
      petWindow.js          The transparent always-on-top panda window
      notepadWindow.js       The sticky-note window
    services/
      storeService.js        Tiny JSON-file persistence (settings/notes)
      reminderService.js     Water-reminder timer logic
      activityService.js     Autonomous walking/playing/sleeping/tree
                               state machine - moves the actual window

  renderer/              Everything that runs inside a window (browser side)
    pet/                  The panda itself (HTML/CSS/JS + preload)
    notepad/               The notepad window (HTML/CSS/JS + preload)

  shared/
    emotions.js           Single source of truth for every emotion:
                            sprite/emoji, animation, speech lines, etc.
    activities.js          Single source of truth for every physical
                             activity: sprite, animation, how likely and
                             how long

assets/
  sprites/                Drop real panda artwork here (see its README)
  tray-icon.png            Tray icon (placeholder, swap anytime)
build/
  icon.png                 App icon used by electron-builder
```

## How the emotion system works

Everything about an emotion — its placeholder emoji, its CSS animation,
and what it says — lives in one object in `src/shared/emotions.js`. To add
a brand-new emotion, add one entry there; it automatically shows up in the
tray's "Make Panda Feel..." test menu and in the idle random-cycling pool.

The main process triggers emotions by calling `setEmotion(id, { line,
durationMs })` (see `src/main/ipcHandlers.js`), which sends an IPC message
the panda window's renderer (`pet.js`) picks up and shows for a few
seconds before automatically reverting to whatever it was doing before.

## How the activity system works

This is what makes the panda actually *move*. `activityService.js` picks
a weighted-random activity (`src/shared/activities.js`), then a ~20fps
ticker nudges the real OS window a few pixels at a time:

- **idle** - stands still for a while.
- **walk** - picks a random spot along the screen and walks there
  (window slides smoothly, sprite flips to face the direction of travel).
- **play** - little playful hops/jitters around the current spot.
- **sleep** - stands still for a longer while, eyes closed, floating "Zzz".
- **tree** - walks to a (randomly chosen, then remembered) spot, climbs
  upward, sits there for a while, then climbs back down.

Dragging the panda pauses the activity engine (so it doesn't fight your
mouse) and it resumes wandering from the new spot once you let go. A
reactive emotion (a click, a water reminder) is drawn on top of whatever
activity is happening and doesn't interrupt it - the panda can react
"happy" mid-walk without stopping.

To add a new activity: add an entry to `src/shared/activities.js`, then
teach `activityService.js`'s `tick()` what its movement (if any) should
look like - most activities need none, they're just "stand still and
show this sprite for a while."

## What's built so far

- Draggable, transparent, always-on-top panda window that remembers where
  you left it.
- Autonomous movement: the panda walks around the screen, plays, naps,
  and climbs into a tree to sit for a while, all on its own.
- ~30 emotions (happy, excited, sleepy, sad, hungry, thirsty, cheering,
  proud, mischievous, and more) with animations + speech bubbles that
  react on top of whatever it's doing, without interrupting it.
- Water reminders: configurable interval (default hourly), native Windows
  notification + panda goes visibly "thirsty" until you tell it you drank
  water (via the right-click menu).
- Notepad: a small always-on-top sticky note window, autosaves to disk.
- System tray menu for everything above.

## What's next (build as we go)

- Swap emoji placeholders for real panda artwork (drop PNGs into
  `assets/sprites/`, see that folder's README — no code changes needed).
- Whatever you want to add next.
