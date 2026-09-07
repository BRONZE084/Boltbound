import assert from "node:assert/strict";
import { DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from "../shared/audioSettings.js";
import { BrowserAudioBackend } from "../src/audio/BrowserAudioBackend.js";
import { GameAudio } from "../src/audio/GameAudio.js";
import { WechatAudioBackend } from "../src/wechat/WechatAudioBackend.js";

function createBackendMock() {
  const calls = [];
  const backend = { calls };
  for (const method of [
    "unlock",
    "playMusic",
    "pauseMusic",
    "resumeMusic",
    "stopMusic",
    "playEffect",
    "suspend",
    "resume",
    "destroy",
    "setMusicVolume",
    "setEffectsVolume",
  ]) {
    backend[method] = (...args) => {
      calls.push([method, ...args]);
      return true;
    };
  }
  return backend;
}

function callsFor(backend, method) {
  return backend.calls.filter(([name]) => name === method);
}

assert.deepEqual(normalizeAudioSettings({}), DEFAULT_AUDIO_SETTINGS);
assert.deepEqual(normalizeAudioSettings({
  musicEnabled: false,
  musicVolume: 4,
  effectsEnabled: false,
  effectsVolume: -2,
}), {
  musicEnabled: false,
  musicVolume: 1,
  effectsEnabled: false,
  effectsVolume: 0,
});
assert.deepEqual(normalizeAudioSettings({ musicVolume: "bad", effectsVolume: Infinity }), DEFAULT_AUDIO_SETTINGS);

const backend = createBackendMock();
const audio = new GameAudio({ backend });
assert.equal(callsFor(backend, "playMusic").length, 0, "construction must never start music");
audio.setGameState({ phase: "lobby" });
assert.equal(callsFor(backend, "playMusic").length, 0, "state changes before unlock must remain silent");
assert.equal(audio.play("jump", { dedupeKey: "round-1-jump-1" }), false);
assert.equal(callsFor(backend, "playEffect").length, 0, "effects before unlock must not play");

assert.equal(audio.unlock(), true);
assert.deepEqual(callsFor(backend, "playMusic"), [[
  "playMusic",
  "/assets/audio/bgm-industrial-run.wav",
  0.45,
]]);
const wechatGameBackend = createBackendMock();
const wechatGameAudio = new GameAudio({ backend: wechatGameBackend, platform: "wechat" });
assert.equal(wechatGameAudio.unlock(), true);
assert.deepEqual(callsFor(wechatGameBackend, "playMusic"), [[
  "playMusic",
  "assets/audio/bgm-industrial-run.wav",
  0.45,
]]);
wechatGameAudio.destroy();

assert.equal(audio.unlock(), true);
assert.equal(callsFor(backend, "playMusic").length, 1, "repeated unlock must not restart music");
assert.equal(audio.play("jump", { dedupeKey: "round-1-jump-1" }), false, "a dropped locked event stays deduplicated");
assert.equal(audio.play("jump", { dedupeKey: "round-1-jump-2" }), true);
assert.equal(audio.play("jump", { dedupeKey: "round-1-jump-2" }), false);
assert.equal(audio.play("jump", "round-1-jump-3"), true, "string shorthand is a dedupe key");
assert.equal(callsFor(backend, "playEffect").length, 2);

audio.setSettings({ musicVolume: 0.3, effectsVolume: 0.6 });
assert.deepEqual(callsFor(backend, "setMusicVolume").at(-1), ["setMusicVolume", 0.3]);
assert.deepEqual(callsFor(backend, "setEffectsVolume").at(-1), ["setEffectsVolume", 0.6]);
assert.equal(callsFor(backend, "playMusic").length, 1, "volume changes must not restart active music");
audio.setSettings({ effectsEnabled: false });
assert.equal(audio.play("land", { dedupeKey: "muted-land" }), false);
assert.deepEqual(callsFor(backend, "setEffectsVolume").at(-1), ["setEffectsVolume", 0]);

audio.suspend("hidden");
audio.suspend("blur");
assert.equal(callsFor(backend, "suspend").length, 1, "nested suspension must pause once");
assert.equal(audio.resume("hidden"), false);
assert.equal(callsFor(backend, "resume").length, 0);
assert.equal(audio.resume("blur"), true);
assert.equal(callsFor(backend, "resume").length, 1);
assert.equal(callsFor(backend, "resumeMusic").length, 1, "music resumes only after all reasons clear");

audio.setSettings({ musicEnabled: false });
assert.equal(callsFor(backend, "stopMusic").length, 1);
audio.setSettings({ musicEnabled: true });
assert.equal(callsFor(backend, "playMusic").length, 2, "explicitly re-enabling music starts the desired track");
audio.setGameState({ musicKey: null });
assert.equal(callsFor(backend, "stopMusic").length, 2);
audio.setGameState({ phase: "race" });
assert.equal(callsFor(backend, "playMusic").length, 3);

audio.destroy();
audio.destroy();
assert.equal(callsFor(backend, "destroy").length, 1, "destroy must be idempotent");
assert.equal(audio.play("bomb", { dedupeKey: "after-destroy" }), false);
assert.equal(audio.unlock(), false);

const raceBackend = createBackendMock();
const raceAudio = new GameAudio({ backend: raceBackend });
raceAudio.unlock();
raceAudio.setGameState({
  phase: "race_countdown",
  round: 1,
  race: { countdownAt: 3_500 },
}, 1_000);
raceAudio.setGameState({
  phase: "race_countdown",
  round: 1,
  race: { countdownAt: 3_500 },
}, 1_100);
raceAudio.setGameState({
  phase: "race_countdown",
  round: 1,
  race: { countdownAt: 3_500 },
}, 1_600);
raceAudio.setGameState({
  phase: "race_countdown",
  round: 1,
  race: { countdownAt: 3_500 },
}, 2_600);
raceAudio.setGameState({ phase: "race", round: 1, race: { countdownAt: 3_500 } }, 3_500);
raceAudio.setGameState({ phase: "race", round: 1, race: { countdownAt: 3_500 } }, 3_600);
assert.deepEqual(callsFor(raceBackend, "playEffect").map(([, source]) => source), [
  "/assets/audio/countdown.wav",
  "/assets/audio/countdown.wav",
  "/assets/audio/countdown.wav",
  "/assets/audio/go.wav",
], "3/2/1 and GO must each play exactly once despite repeated state updates");

const directRaceBackend = createBackendMock();
const directRaceAudio = new GameAudio({ backend: directRaceBackend });
directRaceAudio.unlock();
directRaceAudio.setGameState({ phase: "race", round: 7, race: { countdownAt: 9_000 } }, 9_100);
assert.equal(callsFor(directRaceBackend, "playEffect").length, 0, "reconnecting directly into race must not play GO");
directRaceAudio.setGameState({ phase: "race_countdown", round: 1, race: { countdownAt: 12_000 } }, 9_500);
directRaceAudio.setGameState({ phase: "race", round: 1, race: { countdownAt: 12_000 } }, 12_000);
assert.deepEqual(callsFor(directRaceBackend, "playEffect").map(([, source]) => source), [
  "/assets/audio/countdown.wav",
  "/assets/audio/go.wav",
], "a newly observed countdown enables GO even when round numbers restart");
raceAudio.destroy();
directRaceAudio.destroy();

function createBrowserAudio() {
  const listeners = new Map();
  return {
    src: "",
    loop: false,
    autoplay: false,
    preload: "",
    playsInline: false,
    volume: 1,
    currentTime: 0,
    paused: true,
    ended: false,
    playCalls: 0,
    pauseCalls: 0,
    removedSource: false,
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeAttribute(name) {
      if (name === "src") this.removedSource = true;
    },
    emit(name) {
      listeners.get(name)?.();
    },
  };
}
const retryElement = createBrowserAudio();
let rejectFirstMusicPlay = true;
retryElement.play = function play() {
  this.playCalls += 1;
  if (rejectFirstMusicPlay) {
    rejectFirstMusicPlay = false;
    this.paused = true;
    return Promise.reject(new Error("autoplay_blocked"));
  }
  this.paused = false;
  return Promise.resolve();
};
const retryBackend = new BrowserAudioBackend({ createAudio: () => retryElement });
const retryGameAudio = new GameAudio({ backend: retryBackend });
assert.equal(retryGameAudio.unlock(), true);
await Promise.resolve();
assert.equal(retryElement.playCalls, 1);
assert.equal(retryElement.paused, true);
assert.equal(retryGameAudio.unlock(), true, "a later user gesture retries rejected browser playback");
assert.equal(retryElement.playCalls, 2);
assert.equal(retryElement.src, "/assets/audio/bgm-industrial-run.wav");
retryGameAudio.destroy();


const browserAudios = [];
const browserBackend = new BrowserAudioBackend({
  effectPoolSize: 2,
  createAudio: () => {
    const instance = createBrowserAudio();
    browserAudios.push(instance);
    return instance;
  },
});
assert.equal(browserBackend.playMusic("/assets/audio/music.wav", 0.4), true);
assert.equal(browserAudios[0].src, "/assets/audio/music.wav");
assert.equal(browserAudios[0].loop, true);
assert.equal(browserAudios[0].volume, 0.4);
assert.equal(browserBackend.playEffect("/assets/audio/jump.wav", 0.7), true);
assert.equal(browserBackend.playEffect("/assets/audio/land.wav", 0.7), true);
assert.equal(browserAudios.length, 3, "browser uses one music instance plus a bounded effect pool");
assert.equal(browserAudios[1].volume, 0.7);
browserBackend.setEffectsVolume(0.25);
assert.equal(browserAudios[1].volume, 0.25);
assert.equal(browserAudios[2].volume, 0.25);
browserBackend.suspend();
assert.equal(browserAudios[0].paused, true);
assert.equal(browserBackend.resumeMusic(), true);
assert.equal(browserAudios[0].playCalls, 2);
browserBackend.destroy();
assert.ok(browserAudios.every((instance) => instance.removedSource));
assert.equal(browserBackend.playEffect("/assets/audio/no.wav"), false);

function createWechatContext() {
  const callbacks = {};
  return {
    src: "",
    autoplay: false,
    loop: false,
    obeyMuteSwitch: false,
    volume: 1,
    playCalls: 0,
    pauseCalls: 0,
    stopCalls: 0,
    destroyCalls: 0,
    play() { this.playCalls += 1; },
    pause() { this.pauseCalls += 1; },
    stop() {
      this.stopCalls += 1;
      callbacks.stop?.();
    },
    destroy() { this.destroyCalls += 1; },
    onEnded(callback) { callbacks.ended = callback; },
    onStop(callback) { callbacks.stop = callback; },
    onError(callback) { callbacks.error = callback; },
  };
}

const wechatContexts = [];
const innerOptions = [];
const wxApi = {
  setInnerAudioOption(options) { innerOptions.push(options); },
  createInnerAudioContext() {
    const context = createWechatContext();
    wechatContexts.push(context);
    return context;
  },
};
const wechatBackend = new WechatAudioBackend({ wxApi, effectPoolSize: 2 });
assert.equal(wechatBackend.unlock(), true);
assert.equal(innerOptions[0].obeyMuteSwitch, true);
assert.equal(wechatBackend.playMusic("assets/audio/music.wav", 0.35), true);
assert.equal(wechatContexts[0].src, "assets/audio/music.wav");
assert.equal(wechatContexts[0].loop, true);
assert.equal(wechatContexts[0].volume, 0.35, "WeChat volume must be applied directly to InnerAudioContext");
assert.equal(wechatBackend.playEffect("assets/audio/jump.wav", 0.65), true);
assert.equal(wechatContexts[1].src, "assets/audio/jump.wav");
assert.equal(wechatContexts[1].volume, 0.65);
wechatBackend.setEffectsVolume(0.2);
assert.equal(wechatContexts[1].volume, 0.2);
wechatBackend.suspend();
assert.equal(wechatContexts[0].pauseCalls, 1);
assert.equal(wechatBackend.resumeMusic(), true);
assert.equal(wechatContexts[0].playCalls, 2);
wechatBackend.destroy();
assert.ok(wechatContexts.every((context) => context.destroyCalls === 1));
assert.equal(wechatBackend.playEffect("assets/audio/no.wav"), false);

const unavailableWechat = new WechatAudioBackend({ wxApi: {} });
assert.equal(unavailableWechat.unlock(), false);
assert.equal(unavailableWechat.playMusic("assets/audio/music.wav"), false);
assert.equal(unavailableWechat.playEffect("assets/audio/jump.wav"), false);
unavailableWechat.destroy();

console.log("game audio settings, lifecycle, dedupe, browser, and WeChat backend tests passed");
