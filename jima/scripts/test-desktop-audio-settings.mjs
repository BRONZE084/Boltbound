import assert from "node:assert/strict";
import { BrowserAudioBackend } from "../src/audio/BrowserAudioBackend.js";
import { GameAudio } from "../src/audio/GameAudio.js";
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTINGS_STORAGE_KEY,
  loadGameSettings,
  saveGameSettings,
} from "../src/settings/GameSettings.js";

class FakeAudioElement {
  constructor() {
    this.src = "";
    this.volume = 1;
    this.currentTime = 0;
    this.loop = false;
    this.paused = true;
    this.ended = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.listeners = new Map();
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
}

const legacyStorage = {
  value: JSON.stringify({ voiceVolume: 0.6, speakerEnabled: false, quality: "clear" }),
  getItem(key) {
    assert.equal(key, GAME_SETTINGS_STORAGE_KEY);
    return this.value;
  },
  setItem(key, value) {
    assert.equal(key, GAME_SETTINGS_STORAGE_KEY);
    this.value = value;
  },
};

const migrated = loadGameSettings(legacyStorage);
assert.equal(migrated.musicEnabled, DEFAULT_GAME_SETTINGS.musicEnabled);
assert.equal(migrated.musicVolume, DEFAULT_GAME_SETTINGS.musicVolume);
assert.equal(migrated.effectsEnabled, DEFAULT_GAME_SETTINGS.effectsEnabled);
assert.equal(migrated.effectsVolume, DEFAULT_GAME_SETTINGS.effectsVolume);

const elements = [];
const backend = new BrowserAudioBackend({
  createAudio: () => {
    const element = new FakeAudioElement();
    elements.push(element);
    return element;
  },
});
const gameAudio = new GameAudio({ backend, initialSettings: migrated });
assert.equal(elements.length, 0, "audio elements must remain lazy before a user gesture");
assert.equal(gameAudio.unlock(), true);
assert.equal(elements.length, 1, "unlock starts the configured background loop");
assert.equal(elements[0].src, "/assets/audio/bgm-industrial-run.wav");
assert.equal(elements[0].loop, true);
assert.equal(elements[0].volume, 0.45);
assert.equal(elements[0].playCalls, 1);

const saved = saveGameSettings({
  ...migrated,
  musicVolume: 0.3,
  effectsVolume: 0.2,
}, legacyStorage);
gameAudio.setSettings(saved);
assert.equal(elements[0].volume, 0.3, "music volume updates immediately");
assert.equal(gameAudio.play("jump", { dedupeKey: "jump-1" }), true);
assert.equal(elements.length, 2);
assert.equal(elements[1].src, "/assets/audio/jump.wav");
assert.equal(elements[1].volume, 0.2);
assert.equal(gameAudio.play("jump", { dedupeKey: "jump-1" }), false, "duplicate scene events stay silent");

gameAudio.setSettings({ effectsEnabled: false });
assert.equal(gameAudio.play("place"), false);
gameAudio.setSettings({ musicEnabled: false });
assert.equal(elements[0].paused, true);
gameAudio.setSettings({ musicEnabled: true, musicVolume: 0.4 });
assert.equal(elements[0].playCalls, 2);
assert.equal(elements[0].volume, 0.4);

gameAudio.suspend("visibility");
assert.equal(elements[0].paused, true);
assert.equal(gameAudio.resume("visibility"), true);
assert.equal(elements[0].playCalls, 3);

console.log("desktop audio settings: legacy migration, lazy unlock, live volume, dedupe, toggles, and lifecycle verified");
