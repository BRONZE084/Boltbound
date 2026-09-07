import assert from "node:assert/strict";
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTINGS_STORAGE_KEY,
  QUALITY_PROFILES,
  loadGameSettings,
  normalizeGameSettings,
  qualityProfileFor,
  saveGameSettings,
} from "../src/settings/GameSettings.js";
import {
  DEFAULT_WECHAT_SETTINGS,
  WECHAT_QUALITY_PROFILES,
  loadWechatRuntimeSettings,
  applyRenderProfileToScene,
  applyWechatRenderProfile,
  getWechatRenderProfile,
  normalizeWechatSettings,
} from "../src/wechat/WechatSettings.js";

assert.deepEqual(normalizeGameSettings(), DEFAULT_GAME_SETTINGS);
assert.deepEqual(normalizeGameSettings({
  musicEnabled: false,
  musicVolume: "1.75",
  effectsEnabled: false,
  effectsVolume: "0.25",
  voiceVolume: "1.75",
  micEnabled: true,
  speakerEnabled: false,
  quality: "clear",
}), {
  musicEnabled: false,
  musicVolume: 1,
  effectsEnabled: false,
  effectsVolume: 0.25,
  voiceVolume: 1,
  micEnabled: true,
  speakerEnabled: false,
  quality: "clear",
});
assert.equal(normalizeGameSettings({ voiceVolume: -0.2 }).voiceVolume, 0);
assert.equal(normalizeGameSettings({ voiceVolume: "not-a-number" }).voiceVolume, 0.8);
assert.equal(normalizeGameSettings({ quality: "ultra" }).quality, "balanced");
assert.equal(normalizeGameSettings({ micEnabled: 1 }).micEnabled, false);
assert.equal(normalizeGameSettings({ speakerEnabled: 0 }).speakerEnabled, true);

const loadStorage = {
  getItem(key) {
    assert.equal(key, GAME_SETTINGS_STORAGE_KEY);
    return JSON.stringify({
      voiceVolume: 0.35,
      micEnabled: true,
      speakerEnabled: false,
      quality: "performance",
    });
  },
};
assert.deepEqual(loadGameSettings(loadStorage), {
  musicEnabled: true,
  musicVolume: 0.45,
  effectsEnabled: true,
  effectsVolume: 0.75,
  voiceVolume: 0.35,
  micEnabled: false,
  speakerEnabled: false,
  quality: "performance",
}, "loading stored settings must never reopen the microphone automatically");
assert.deepEqual(loadGameSettings({ getItem: () => "{broken" }), DEFAULT_GAME_SETTINGS);
assert.deepEqual(loadGameSettings(null), DEFAULT_GAME_SETTINGS);

let storedKey = "";
let storedValue = "";
const saved = saveGameSettings({ voiceVolume: 2, quality: "clear", micEnabled: true }, {
  setItem(key, value) {
    storedKey = key;
    storedValue = value;
  },
});
assert.equal(storedKey, GAME_SETTINGS_STORAGE_KEY);
assert.deepEqual(JSON.parse(storedValue), saved);
assert.deepEqual(saved, {
  musicEnabled: true,
  musicVolume: 0.45,
  effectsEnabled: true,
  effectsVolume: 0.75,
  voiceVolume: 1,
  micEnabled: true,
  speakerEnabled: true,
  quality: "clear",
});
assert.doesNotThrow(() => saveGameSettings({}, { setItem() { throw new Error("quota"); } }));

for (const [key, expected] of Object.entries({
  performance: [1_200, 675, 0.75],
  balanced: [1_600, 900, 1],
  clear: [2_000, 1_125, 1.25],
})) {
  const profile = qualityProfileFor(key);
  assert.equal(profile, QUALITY_PROFILES[key]);
  assert.deepEqual([profile.width, profile.height, profile.zoom], expected);
  assert.equal(profile.width / profile.zoom, 1_600);
assert.deepEqual(loadWechatRuntimeSettings(JSON.stringify({
  quality: "clear",
  micEnabled: true,
  speakerEnabled: false,
})), {
  version: 1,
  quality: "clear",
  micEnabled: false,
  speakerEnabled: false,
  musicEnabled: true,
  musicVolume: 0.45,
  effectsEnabled: true,
  effectsVolume: 0.75,
}, "WeChat startup must retain quality/speaker preferences without restoring the microphone");
  assert.equal(profile.height / profile.zoom, 900);
}
assert.equal(qualityProfileFor("unknown"), QUALITY_PROFILES.balanced);
assert.equal(qualityProfileFor({ quality: "clear" }), QUALITY_PROFILES.clear);

assert.deepEqual(normalizeWechatSettings(), DEFAULT_WECHAT_SETTINGS);
assert.deepEqual(normalizeWechatSettings(JSON.stringify({
  version: 99,
  quality: "clear",
  musicEnabled: false,
  musicVolume: 2,
  effectsEnabled: false,
  effectsVolume: -0.4,
  micEnabled: true,
  speakerEnabled: false,
})), {
  version: 1,
  quality: "clear",
  micEnabled: true,
  speakerEnabled: false,
  musicEnabled: false,
  musicVolume: 1,
  effectsEnabled: false,
  effectsVolume: 0,
});
assert.deepEqual(normalizeWechatSettings("{broken"), DEFAULT_WECHAT_SETTINGS);
assert.equal(normalizeWechatSettings({ quality: "ultra" }).quality, "balanced");
assert.equal(normalizeWechatSettings({ micEnabled: 1 }).micEnabled, false);
assert.equal(normalizeWechatSettings({ speakerEnabled: 0 }).speakerEnabled, true);

for (const [key, expected] of Object.entries({
  performance: [960, 540, 0.6],
  balanced: [1_280, 720, 0.8],
  clear: [1_600, 900, 1],
})) {
  const profile = getWechatRenderProfile(key);
  assert.equal(profile, WECHAT_QUALITY_PROFILES[key]);
  assert.deepEqual([profile.width, profile.height, profile.scale], expected);
  assert.equal(profile.width / profile.scale, 1_600);
  assert.equal(profile.height / profile.scale, 900);
}
assert.equal(getWechatRenderProfile("unknown"), WECHAT_QUALITY_PROFILES.balanced);

function sceneProbe() {
  const calls = [];
  return {
    calls,
    scene: {
      cameras: {
        main: {
          setViewport: (...args) => calls.push(["viewport", ...args]),
          setZoom: (...args) => calls.push(["zoom", ...args]),
          setScroll: (...args) => calls.push(["scroll", ...args]),
        },
      },
    },
  };
}

const directScene = sceneProbe();
assert.equal(applyRenderProfileToScene(directScene.scene, "performance"), WECHAT_QUALITY_PROFILES.performance);
assert.deepEqual(directScene.calls, [
  ["viewport", 0, 0, 960, 540],
  ["zoom", 0.6],
  ["scroll", 0, 0],
]);
assert.equal(applyRenderProfileToScene(null, "clear"), WECHAT_QUALITY_PROFILES.clear);

const firstScene = sceneProbe();
const secondScene = sceneProbe();
const resizeCalls = [];
const renderResult = applyWechatRenderProfile({
  game: {
    scale: {
      width: 1_280,
      height: 720,
      setGameSize: (...args) => resizeCalls.push(args),
    },
  },
  scenes: [firstScene.scene, secondScene.scene],
  quality: "clear",
});
assert.deepEqual(resizeCalls, [[1_600, 900]]);
assert.deepEqual(firstScene.calls, [
  ["viewport", 0, 0, 1_600, 900],
  ["zoom", 1],
  ["scroll", 0, 0],
]);
assert.deepEqual(secondScene.calls, firstScene.calls);
assert.deepEqual(renderResult, {
  key: "clear",
  width: 1_600,
  height: 900,
  scale: 1,
  logicalWidth: 1_600,
  logicalHeight: 900,
});

const noResizeCalls = [];
applyWechatRenderProfile({
  game: {
    scale: {
      width: 960,
      height: 540,
      setGameSize: (...args) => noResizeCalls.push(args),
    },
  },
  quality: "performance",
});
assert.deepEqual(noResizeCalls, [], "the current backing size must not be reset unnecessarily");

console.log("settings: desktop persistence and desktop/WeChat render profiles verified");
