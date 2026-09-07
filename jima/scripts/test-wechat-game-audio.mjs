import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  WECHAT_SETTINGS_STORAGE_KEY,
  loadWechatRuntimeSettings,
  normalizeWechatSettings,
} from "../src/wechat/WechatSettings.js";

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(here, "../src/wechat/main.js"), "utf8");
const uiSource = readFileSync(resolve(here, "../src/wechat/WechatUiScene.js"), "utf8");

assert.equal(WECHAT_SETTINGS_STORAGE_KEY, "settingsV1");
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
});
assert.deepEqual(normalizeWechatSettings({
  musicEnabled: false,
  musicVolume: 1.4,
  effectsEnabled: false,
  effectsVolume: -0.2,
}), {
  version: 1,
  quality: "balanced",
  micEnabled: false,
  speakerEnabled: true,
  musicEnabled: false,
  musicVolume: 1,
  effectsEnabled: false,
  effectsVolume: 0,
});

assert.match(mainSource, /new GameAudio\(\{[\s\S]*backend: new WechatAudioBackend\(\)[\s\S]*platform: "wechat"/);
assert.match(mainSource, /function persistWechatSettings[\s\S]*gameAudio\.setSettings\(wechatSettings\)/);
assert.match(mainSource, /function applyState\(state\)[\s\S]*gameAudio\.setGameState\(state, Date\.now\(\) \+ bestClockSample\.offset\)/);
assert.match(mainSource, /setInterval\(\(\) => \{[\s\S]*gameAudio\.setGameState\(currentState, Date\.now\(\) \+ bestClockSample\.offset\);[\s\S]*\}, 150\)/);
assert.match(mainSource, /onAudioUnlock: \(\) => gameAudio\.unlock\(\)/);
assert.equal((mainSource.match(/onAudioEvent: \(key, options\) => gameAudio\.play\(key, options\)/g) || []).length, 2);
assert.match(mainSource, /onSettingsAudio: updateAudioSetting/);
assert.match(mainSource, /onShow[\s\S]*gameAudio\.resume\("wechat-hidden"\)/);
assert.match(mainSource, /onHide[\s\S]*gameAudio\.suspend\("wechat-hidden"\)/);

assert.match(mainSource, /if \(!error && response\?\.ok\) \{\s*gameAudio\.play\("draft"/);
assert.match(mainSource, /if \(!error && response\?\.ok\) \{\s*gameAudio\.play\("place"/);
assert.match(mainSource, /if \(response\?\.ok\) \{\s*gameAudio\.play\("finish"/);
assert.match(mainSource, /if \(effect\.type !== "bomb"\) \{\s*gameAudio\.play\("item"/);
assert.match(mainSource, /socket\.on\("bomb:blast", \(blast\) => \{\s*if \(roomBound\) gameScene\?\.receiveBombBlast\(blast\)/);

assert.match(uiSource, /this\.input\.on\("pointerdown", \(\) => this\._invoke\("onAudioUnlock"\)\)/);
for (const key of ["musicEnabled", "musicVolume", "effectsEnabled", "effectsVolume"]) {
  assert.match(uiSource, new RegExp(`onSettingsAudio\\", \\"${key}`));
}
assert.match(uiSource, /this\._addRect\(WIDTH \/ 2, HEIGHT \/ 2, 1_080, 840/);
assert.match(uiSource, /y: 820,[\s\S]*label: this\.currentView === "home"/);

const buttonStart = uiSource.indexOf("  _button({");
const buttonEnd = uiSource.indexOf("  _setButtonEnabled", buttonStart);
const holdStart = uiSource.indexOf("  _holdButton({");
const holdEnd = uiSource.indexOf("  _releaseAllControls", holdStart);
assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
assert.ok(holdStart >= 0 && holdEnd > holdStart);
assert.match(uiSource.slice(buttonStart, buttonEnd), /onAudioEvent", "ui_click"/);
assert.doesNotMatch(uiSource.slice(holdStart, holdEnd), /onAudioEvent|ui_click/);

console.log("WeChat audio settings migration, UI bridge, ACK events, and lifecycle tests passed");
