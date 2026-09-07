import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = 32_264;
const baseUrl = `http://127.0.0.1:${port}`;
const bundleArgument = process.argv[2] || process.env.JUMP_QA_DIST;
const bundleDir = bundleArgument ? resolve(bundleArgument) : null;
const backendPort = bundleDir ? 32_265 : port;

function findPlaywright() {
  const override = process.env.PLAYWRIGHT_MODULE;
  if (override && existsSync(override)) return override;
  const cacheRoot = join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  if (!existsSync(cacheRoot)) return null;
  return readdirSync(cacheRoot)
    .map((name) => join(cacheRoot, name, "node_modules", "playwright"))
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || null;
}

async function waitForServer(server, url) {
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`test server exited early\n${output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`test server did not become ready\n${output}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveWait) => child.once("exit", resolveWait)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
}

async function installGameCapture(page) {
  await page.addInitScript(() => {
    let phaserValue;
    Object.defineProperty(globalThis, "Phaser", {
      configurable: true,
      get: () => phaserValue,
      set: (next) => {
        phaserValue = next;
        const OriginalGame = next?.Game;
        if (typeof OriginalGame !== "function" || OriginalGame.__jumpQaWrapped) return;
        class CapturedGame extends OriginalGame {
          constructor(...args) {
            super(...args);
            globalThis.__JUMP_QA_GAME__ = this;
          }
        }
        Object.defineProperty(CapturedGame, "__jumpQaWrapped", { value: true });
        next.Game = CapturedGame;
      },
    });
  });
}

async function jumpSnapshot(page, label) {
  return page.evaluate((snapshotLabel) => {
    const game = globalThis.__JUMP_QA_GAME__;
    const scene = game?.scene?.getScene?.("Boltbound");
    const local = scene?.playerSprites?.get(scene.myPlayerId)?.sprite;
    if (!scene || !local?.body) throw new Error("real Boltbound scene was not captured");
    return {
      label: snapshotLabel,
      browserAt: Number(performance.now().toFixed(2)),
      loopFrame: game.loop.frame,
      jumpPressQueue: scene.jumpPressQueue,
      sceneAt: Number(scene.time.now.toFixed(2)),
      grounded: Boolean(local.body.blocked.down || local.body.touching.down),
      y: Number(local.y.toFixed(2)),
      vy: Number(local.body.velocity.y.toFixed(2)),
      airJumpsRemaining: scene.airJumpsRemaining,
      keyboardJumpWasDown: scene.keyboardJumpWasDown,
      touchJumpPressed: scene.touchJumpPressed,
      touchJumpDown: scene.touch.jump,
      jumpQueuedAt: Number.isFinite(scene.jumpQueuedAt) ? Number(scene.jumpQueuedAt.toFixed(2)) : null,
    };
  }, label);
}

async function waitForGrounded(page) {
  await page.waitForFunction(() => {
    const game = globalThis.__JUMP_QA_GAME__;
    const scene = game?.scene?.getScene?.("Boltbound");
    const local = scene?.playerSprites?.get(scene.myPlayerId)?.sprite;
    return Boolean(
      scene?.roomState?.phase === "race" &&
      local?.body?.enable &&
      (local.body.blocked.down || local.body.touching.down)
    );
  }, null, { timeout: 8_000 });
}

async function waitForJumpQueueDrain(page, dispatchFrame) {
  await page.waitForFunction((minimumFrame) => {
    const game = globalThis.__JUMP_QA_GAME__;
    const scene = game?.scene?.getScene?.("Boltbound");
    return Boolean(
      Number.isFinite(game?.loop?.frame) &&
      game.loop.frame >= minimumFrame &&
      scene?.jumpPressQueue === 0
    );
  }, dispatchFrame + 2, { timeout: 1_000 });
}

async function runKeyboardSequence(page) {
  await waitForGrounded(page);
  const samples = [await jumpSnapshot(page, "keyboard:grounded")];
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(50);
  samples.push(await jumpSnapshot(page, "keyboard:first-down"));
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(110);
  samples.push(await jumpSnapshot(page, "keyboard:released-in-air"));
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(50);
  samples.push(await jumpSnapshot(page, "keyboard:second-down"));
  await page.keyboard.up("KeyW");
  return samples;
}

async function dispatchJumpPointer(page, eventType, pointerId) {
  await page.locator('#touch-controls [data-control="jump"]').dispatchEvent(eventType, {
    pointerId,
    pointerType: "touch",
    isPrimary: true,
    buttons: eventType === "pointerdown" ? 1 : 0,
  });
}

async function runTouchSequence(page) {
  await waitForGrounded(page);
  const samples = [await jumpSnapshot(page, "touch:grounded")];
  await dispatchJumpPointer(page, "pointerdown", 31);
  await page.waitForTimeout(50);
  samples.push(await jumpSnapshot(page, "touch:first-down"));
  await dispatchJumpPointer(page, "pointerup", 31);
  await page.waitForTimeout(110);
  samples.push(await jumpSnapshot(page, "touch:released-in-air"));
  await dispatchJumpPointer(page, "pointerdown", 32);
  await page.waitForTimeout(50);
  samples.push(await jumpSnapshot(page, "touch:second-down"));
  await dispatchJumpPointer(page, "pointerup", 32);
  return samples;
}

async function runSameFrameKeyboardSequence(page) {
  await waitForGrounded(page);
  const before = await jumpSnapshot(page, "keyboard-burst:grounded");
  const dispatch = await page.evaluate(() => {
    const send = (type) => globalThis.dispatchEvent(new KeyboardEvent(type, {
      key: "w",
      code: "KeyW",
      keyCode: 87,
      which: 87,
      bubbles: true,
      cancelable: true,
    }));
    send("keydown");
    send("keyup");
    send("keydown");
    const game = globalThis.__JUMP_QA_GAME__;
    const scene = game?.scene?.getScene?.("Boltbound");
    return { frame: game?.loop?.frame, queued: scene?.jumpPressQueue };
  });
  assert.equal(dispatch.queued, 2, "keyboard: both same-frame press edges must enter the Scene queue");
  assert.ok(Number.isFinite(dispatch.frame), "keyboard: Phaser loop frame must be observable");
  await waitForJumpQueueDrain(page, dispatch.frame);
  const after = await jumpSnapshot(page, "keyboard-burst:after-two-presses");
  await page.evaluate(() => globalThis.dispatchEvent(new KeyboardEvent("keyup", {
    key: "w",
    code: "KeyW",
    keyCode: 87,
    which: 87,
    bubbles: true,
    cancelable: true,
  })));
  return [before, after];
}

async function runSameFrameTouchSequence(page) {
  await waitForGrounded(page);
  const before = await jumpSnapshot(page, "touch-burst:grounded");
  const dispatch = await page.locator('#touch-controls [data-control="jump"]').evaluate((button) => {
    const send = (type, pointerId, buttons) => button.dispatchEvent(new PointerEvent(type, {
      pointerId,
      pointerType: "touch",
      isPrimary: true,
      buttons,
      bubbles: true,
      cancelable: true,
    }));
    send("pointerdown", 41, 1);
    send("pointerup", 41, 0);
    send("pointerdown", 42, 1);
    const game = globalThis.__JUMP_QA_GAME__;
    const scene = game?.scene?.getScene?.("Boltbound");
    return { frame: game?.loop?.frame, queued: scene?.jumpPressQueue };
  });
  assert.equal(dispatch.queued, 2, "touch: both same-frame press edges must enter the Scene queue");
  assert.ok(Number.isFinite(dispatch.frame), "touch: Phaser loop frame must be observable");
  await waitForJumpQueueDrain(page, dispatch.frame);
  const after = await jumpSnapshot(page, "touch-burst:after-two-presses");
  await dispatchJumpPointer(page, "pointerup", 42);
  return [before, after];
}

function assertSecondJump(samples, inputKind) {
  const first = samples.find((sample) => sample.label === `${inputKind}:first-down`);
  const released = samples.find((sample) => sample.label === `${inputKind}:released-in-air`);
  const second = samples.find((sample) => sample.label === `${inputKind}:second-down`);
  assert.ok(first.vy < -300, `${inputKind}: first jump must launch upward`);
  assert.equal(released.grounded, false, `${inputKind}: second input must occur in the air`);
  assert.equal(second.airJumpsRemaining, 0, `${inputKind}: second edge must consume the air jump`);
  assert.ok(
    second.vy < released.vy,
    `${inputKind}: second edge must produce a fresh upward impulse (${released.vy} -> ${second.vy})`,
  );
}

const require = createRequire(import.meta.url);
let playwrightPath;
try {
  playwrightPath = require.resolve("playwright");
} catch {
  playwrightPath = findPlaywright();
}
assert.ok(playwrightPath, "Install the declared Playwright devDependency for the real Edge regression");
const { chromium } = require(playwrightPath);
let server;
let previewServer;
let browser;

try {
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(backendPort),
      NODE_ENV: "test",
      GAME_TIMERS: "short",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await waitForServer(server, `http://127.0.0.1:${backendPort}/health`);
  if (bundleDir) {
    const { preview } = await import("vite");
    previewServer = await preview({
      root: projectRoot,
      configFile: false,
      build: { outDir: bundleDir },
      preview: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        proxy: {
          "/socket.io": {
            target: `http://127.0.0.1:${backendPort}`,
            ws: true,
          },
        },
      },
    });
  }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await installGameCapture(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#player-name").fill("JumpQA");
  await page.locator("#practice").click();
  await page.waitForFunction(
    () => document.querySelector("#phase-label")?.textContent === "竞速",
    null,
    { timeout: 20_000 },
  );
  await page.evaluate(() => {
    const scene = globalThis.__JUMP_QA_GAME__?.scene?.getScene?.("Boltbound");
    if (!scene) throw new Error("real Boltbound scene was not captured for audio probes");
    globalThis.__AUDIO_QA_EVENTS__ = [];
    scene.bridge.onAudioEvent = (key, options) => {
      globalThis.__AUDIO_QA_EVENTS__.push({ key, options: options || null });
    };
  });

  const keyboard = await runKeyboardSequence(page);
  await page.waitForTimeout(1_400);
  const touch = await runTouchSequence(page);
  await page.waitForTimeout(1_400);
  const keyboardBurst = await runSameFrameKeyboardSequence(page);
  await page.waitForTimeout(1_400);
  const touchBurst = await runSameFrameTouchSequence(page);
  await waitForGrounded(page);
  const audioEvents = await page.evaluate(() => {
    const scene = globalThis.__JUMP_QA_GAME__.scene.getScene("Boltbound");
    const events = globalThis.__AUDIO_QA_EVENTS__;
    const onAudioEvent = (key, options) => events.push({ key, options: options || null });

    const portalSource = {
      id: "audio-portal",
      type: "portal",
      x: 400,
      y: 500,
      rotation: 90,
    };
    const portalLocal = {
      x: portalSource.x,
      y: portalSource.y,
      flipX: false,
      body: {
        enable: true,
        velocity: { x: 0, y: 0 },
        reset(x, y) {
          portalLocal.x = x;
          portalLocal.y = y;
        },
      },
      setPosition(x, y) { this.x = x; this.y = y; return this; },
      setMaxVelocity() { return this; },
      setVelocity(x, y) { this.body.velocity.x = x; this.body.velocity.y = y; return this; },
      setFlipX(value) { this.flipX = value; return this; },
    };
    scene.applyPortalTeleport.call({
      portals: [{
        ...portalSource,
        link: { source: portalSource, target: null, mode: "solo" },
      }],
      portalExitLockId: null,
      portalCooldownUntil: 0,
      isInsidePortal: () => true,
      effectSpeedUntil: -Infinity,
      lastMotionAt: 0,
      bridge: { onAudioEvent },
      mechanismElapsed: () => 100,
    }, portalLocal, 1_000);

    const deadLocal = {
      body: { enable: true },
      setVelocity() { return this; },
      setAlpha() { return this; },
      setAngle() { return this; },
      setDragX() { return this; },
    };
    scene.killLocalPlayer.call({
      deathSent: false,
      finishSent: false,
      roomState: { phase: "race" },
      myPlayerId: "audio-player",
      playerSprites: new Map([["audio-player", { sprite: deadLocal }]]),
      bridge: { onLocalDeath: () => true, onAudioEvent },
      effectSpeedUntil: -Infinity,
      resetJumpState() {},
    }, "audio-qa");

    scene.receiveBombBlast({
      x: 600,
      y: 500,
      radius: 220,
      sourcePlayerId: "audio-source",
      serverTime: 123_456,
      mapRevision: scene.mapRevision,
    });
    return events;
  });
  console.log(JSON.stringify({ keyboard, touch, keyboardBurst, touchBurst, audioEvents }, null, 2));
  assertSecondJump(keyboard, "keyboard");
  assertSecondJump(touch, "touch");
  assert.equal(
    keyboardBurst[1].airJumpsRemaining,
    0,
    "keyboard: two press edges delivered before the next frame must not collapse into one jump",
  );
  assert.equal(
    touchBurst[1].airJumpsRemaining,
    0,
    "touch: two press edges delivered before the next frame must not collapse into one jump",
  );
  const audioKeys = audioEvents.map((event) => event.key);
  assert.ok(audioKeys.filter((key) => key === "jump").length >= 4, "each real ground jump must emit jump audio");
  assert.ok(
    audioKeys.filter((key) => key === "double_jump").length >= 4,
    "each consumed air jump must emit double-jump audio",
  );
  assert.ok(audioKeys.filter((key) => key === "land").length >= 4, "real airborne landings must emit land audio");
  for (const key of ["portal", "death", "bomb"]) {
    assert.ok(audioKeys.includes(key), `actual ${key} Scene path must emit audio`);
  }
  const expectedBombDedupeKey = `audio-source:123456:${await page.evaluate(
    () => globalThis.__JUMP_QA_GAME__.scene.getScene("Boltbound").mapRevision,
  )}`;
  assert.ok(
    audioEvents.some((event) => event.key === "bomb" && event.options?.dedupeKey === expectedBombDedupeKey),
    `bomb audio must carry the authoritative dedupe key ${expectedBombDedupeKey}`,
  );
  console.log("real Edge keyboard and touch double-jump regression passed");
} finally {
  await browser?.close().catch(() => {});
  if (previewServer?.httpServer) {
    await new Promise((resolveClose) => {
      previewServer.httpServer.close(resolveClose);
    });
  }
  await stopChild(server);
}
