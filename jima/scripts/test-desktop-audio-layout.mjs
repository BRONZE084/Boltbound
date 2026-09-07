import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

for (const id of [
  "settings-music-enabled",
  "settings-music-volume",
  "settings-music-volume-value",
  "settings-effects-enabled",
  "settings-effects-volume",
  "settings-effects-volume-value",
]) {
  assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, `${id} must exist exactly once`);
}
assert.ok(
  html.indexOf('id="settings-audio-title"') < html.indexOf('id="settings-voice-title"'),
  "game sound and web voice must be separate settings sections",
);
assert.match(html, /id="settings-music-volume"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
assert.match(html, /id="settings-effects-volume"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
assert.match(css, /\.settings-audio-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.settings-audio-grid,[\s\S]*?grid-template-columns:\s*1fr/s);

assert.match(css, /\.sr-only\s*\{[^}]*position:\s*absolute\s*!important[^}]*clip-path:\s*inset\(50%\)/s);
assert.match(html, /id="settings-description"\s+class="sr-only"/);
assert.match(main, /new GameAudio\(\{[\s\S]*?backend:\s*new BrowserAudioBackend\(\)/);
assert.match(main, /addEventListener\("pointerdown",\s*unlockGameAudioFromGesture,\s*true\)/);
assert.match(main, /addEventListener\("keydown",\s*unlockGameAudioFromGesture,\s*true\)/);
for (const lifecycle of ["visibilitychange", "pagehide", "pageshow", "blur", "focus"]) {
assert.doesNotMatch(
  main,
  /removeEventListener\("(?:pointerdown|keydown)",\s*unlockGameAudioFromGesture/,
  "gesture listeners must stay installed so an asynchronously rejected play can retry",
);
assert.match(main, /button\.closest\("#touch-controls"\)/, "gameplay touch controls must not emit ui_click");
  assert.match(main, new RegExp(`addEventListener\\(\\"${lifecycle}\\"`));
}
assert.match(main, /onAudioEvent:\s*\(key,\s*options\)\s*=>\s*gameAudio\.play\(key,\s*options\)/);
assert.match(main, /effect\.type\s*!==\s*"bomb"[\s\S]*?gameAudio\.play\("item"/);
assert.match(main, /response\?\.ok\)\s*\{\s*gameAudio\.play\("draft"/s);
assert.match(main, /gameAudio\.play\("place",\s*\{\s*dedupeKey:\s*actionId\s*\}\)/s);
assert.match(main, /gameAudio\.play\("finish",\s*\{\s*dedupeKey:\s*actionId\s*\}\)/s);
assert.match(main, /function updateTimer\(\)[\s\S]*?gameAudio\.setGameState\(currentState,\s*now\)/);

console.log("desktop audio layout: controls, responsive grid, lifecycle, bridge, and success-only event wiring verified");
