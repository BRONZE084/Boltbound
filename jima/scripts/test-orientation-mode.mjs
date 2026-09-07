import assert from "node:assert/strict";

import {
  isActualLandscape,
  mapVirtualPointerToCanvas,
  requestNativeLandscape,
  resolveLandscapePresentation,
  waitForActualLandscape,
} from "../src/orientation/landscapeMode.js";

assert.equal(isActualLandscape({ mediaMatches: false, viewportWidth: 390, viewportHeight: 844 }), false);
assert.equal(isActualLandscape({ mediaMatches: false, viewportWidth: 844, viewportHeight: 390 }), true);
assert.equal(isActualLandscape({ mediaMatches: true, viewportWidth: 390, viewportHeight: 844 }), true);

assert.equal(resolveLandscapePresentation({ gameActive: false, coarsePointer: true }), "inactive");
assert.equal(resolveLandscapePresentation({ gameActive: true, coarsePointer: true }), "gate");
assert.equal(resolveLandscapePresentation({ gameActive: true, coarsePointer: true, virtualLandscape: true }), "virtual");
assert.equal(resolveLandscapePresentation({
  gameActive: true,
  coarsePointer: true,
  virtualLandscape: true,
  actualLandscape: true,
}), "native");

assert.deepEqual(
  mapVirtualPointerToCanvas({
    clientX: 100,
    clientY: 250,
    canvasRect: { left: 0, top: 75, right: 390, width: 390, height: 694 },
  }),
  {
    clientX: (175 / 694) * 390,
    clientY: (290 / 390) * 694 + 75,
  },
);

let fakeNow = 0;
let reads = 0;
const observed = await waitForActualLandscape({
  timeoutMs: 800,
  pollIntervalMs: 100,
  now: () => fakeNow,
  sleep: async (delay) => { fakeNow += delay; },
  readSnapshot: () => ({
    actualLandscape: ++reads >= 5,
    mediaMatches: false,
    viewportWidth: reads >= 5 ? 844 : 390,
    viewportHeight: reads >= 5 ? 390 : 844,
  }),
});
assert.equal(observed.actualLandscape, true);
assert.equal(observed.elapsedMs, 400);

fakeNow = 0;
const timedOut = await waitForActualLandscape({
  timeoutMs: 800,
  pollIntervalMs: 125,
  now: () => fakeNow,
  sleep: async (delay) => { fakeNow += delay; },
  readSnapshot: () => ({
    actualLandscape: false,
    mediaMatches: false,
    viewportWidth: 390,
    viewportHeight: 844,
  }),
});
assert.equal(timedOut.actualLandscape, false);
assert.equal(timedOut.elapsedMs, 800, "portrait observation must wait the full bounded window");

const fullscreenCalls = [];
const fullscreenError = Object.assign(new Error("options unsupported"), { name: "TypeError" });
const root = {
  async requestFullscreen(options) {
    fullscreenCalls.push(options);
    if (options) throw fullscreenError;
  },
};
const lockCalls = [];
const nativeOutcome = await requestNativeLandscape({
  root,
  documentRef: {},
  screenRef: { orientation: { async lock(value) { lockCalls.push(value); } } },
  observe: async () => ({ actualLandscape: false, elapsedMs: 800 }),
});
assert.equal(fullscreenCalls.length, 2, "fullscreen must retry without unsupported options");
assert.deepEqual(fullscreenCalls, [{ navigationUI: "hide" }, undefined]);
assert.equal(nativeOutcome.fullscreen.granted, true);
assert.equal(nativeOutcome.fullscreen.retriedWithoutOptions, true);
assert.equal(nativeOutcome.fullscreen.firstErrorCode, "TypeError");
assert.deepEqual(lockCalls, ["landscape"]);
assert.equal(nativeOutcome.orientationLock.granted, true);
assert.equal(nativeOutcome.actualLandscape, false, "resolved APIs do not prove visual rotation");

const missingOutcome = await requestNativeLandscape({
  root: {},
  documentRef: {},
  screenRef: {},
  observe: async () => ({ actualLandscape: false, elapsedMs: 800 }),
});
assert.equal(missingOutcome.fullscreen.supported, false);
assert.equal(missingOutcome.orientationLock.supported, false);
assert.equal(missingOutcome.actualLandscape, false);

const rejectedOutcome = await requestNativeLandscape({
  root: {
    async requestFullscreen(options) {
      throw Object.assign(new Error("blocked"), {
        name: options ? "TypeError" : "NotAllowedError",
      });
    },
  },
  documentRef: {},
  screenRef: {
    orientation: {
      async lock() {
        throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
      },
    },
  },
  observe: async () => ({ actualLandscape: false, elapsedMs: 800 }),
});
assert.equal(rejectedOutcome.fullscreen.retriedWithoutOptions, true);
assert.equal(rejectedOutcome.fullscreen.errorCode, "NotAllowedError");
assert.equal(rejectedOutcome.orientationLock.errorCode, "NotAllowedError");
assert.equal(rejectedOutcome.actualLandscape, false);

let pendingObservationCalls = 0;
const pendingStartedAt = Date.now();
const pendingOutcome = await requestNativeLandscape({
  root: {
    requestFullscreen() {
      return new Promise(() => {});
    },
  },
  documentRef: {},
  screenRef: {
    orientation: {
      lock() {
        return new Promise(() => {});
      },
    },
  },
  nativeCallTimeoutMs: 5,
  observe: async () => {
    pendingObservationCalls += 1;
    return { actualLandscape: false, elapsedMs: 800 };
  },
});
assert.equal(pendingOutcome.fullscreen.firstErrorCode, "timeout");
assert.equal(pendingOutcome.fullscreen.retriedWithoutOptions, true);
assert.equal(pendingOutcome.fullscreen.errorCode, "timeout");
assert.equal(pendingOutcome.orientationLock.errorCode, "timeout");
assert.equal(pendingObservationCalls, 1, "pending native APIs must still reach visual observation");
assert.ok(Date.now() - pendingStartedAt < 250, "native API calls must have a bounded wait");

console.log("orientation mode: native outcome, visual wait, fallback state, and pointer mapping verified");
