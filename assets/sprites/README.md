# Panda sprites

Right now the panda is rendered as an emoji placeholder (see
`src/shared/emotions.js` -> `sprite` field) so the app is fully playable
without any art.

To use real artwork instead: drop a PNG into this folder named after the
emotion id, e.g.:

```
assets/sprites/idle.png
assets/sprites/happy.png
assets/sprites/thirsty.png
assets/sprites/sleepy.png
```

The full list of emotion ids lives in `src/shared/emotions.js`. As soon as
a matching file exists here, the renderer (`src/renderer/pet/pet.js`)
picks it up automatically and stops using the emoji for that emotion -
no code changes needed. Recommended size: roughly 300x300px, transparent
background, panda facing forward/slightly toward camera so it reads well
at ~160px on screen.
