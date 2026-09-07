import assert from "node:assert/strict";

import {
  GAME_SETTINGS_STORAGE_KEY,
  QUALITY_PROFILES,
  loadGameSettings,
  qualityProfileFor,
  saveGameSettings,
} from "../src/settings/GameSettings.js";

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
};

saveGameSettings({
  musicEnabled: false,
  musicVolume: 1.8,
  effectsEnabled: true,
  effectsVolume: -0.4,
  voiceVolume: 1.8,
  micEnabled: true,
  speakerEnabled: false,
  quality: "clear",
}, storage);

const stored = JSON.parse(values.get(GAME_SETTINGS_STORAGE_KEY));
assert.equal(stored.musicEnabled, false);
assert.equal(stored.musicVolume, 1);
assert.equal(stored.effectsEnabled, true);
assert.equal(stored.effectsVolume, 0);
assert.equal(stored.voiceVolume, 1);
assert.equal(stored.micEnabled, true, "the current tab may remember its microphone toggle");

const loaded = loadGameSettings(storage);
assert.equal(loaded.musicEnabled, false);
assert.equal(loaded.musicVolume, 1);
assert.equal(loaded.effectsEnabled, true);
assert.equal(loaded.effectsVolume, 0);
assert.equal(loaded.micEnabled, false, "a page reload must never restore an open microphone");
assert.equal(loaded.speakerEnabled, false);
assert.equal(loaded.voiceVolume, 1);
assert.equal(loaded.quality, "clear");

values.set(GAME_SETTINGS_STORAGE_KEY, JSON.stringify({
  voiceVolume: 0.35,
  speakerEnabled: false,
  quality: "performance",
}));
const migratedLegacy = loadGameSettings(storage);
assert.equal(migratedLegacy.musicEnabled, true);
assert.equal(migratedLegacy.musicVolume, 0.45);
assert.equal(migratedLegacy.effectsEnabled, true);
assert.equal(migratedLegacy.effectsVolume, 0.75);
assert.equal(migratedLegacy.voiceVolume, 0.35);
assert.equal(migratedLegacy.quality, "performance");

assert.deepEqual(
  Object.fromEntries(Object.entries(QUALITY_PROFILES).map(([key, profile]) => [
    key,
    [profile.width, profile.height, profile.zoom, profile.width / profile.zoom, profile.height / profile.zoom],
  ])),
  {
    performance: [1200, 675, 0.75, 1600, 900],
    balanced: [1600, 900, 1, 1600, 900],
    clear: [2000, 1125, 1.25, 1600, 900],
  },
  "every backing resolution must preserve the same 1600 x 900 world viewport",
);
assert.equal(qualityProfileFor("unknown"), QUALITY_PROFILES.balanced);

console.log("game settings: privacy-safe reload, volume clamp, and fixed-world quality profiles verified");
