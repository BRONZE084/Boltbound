import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenePath = fileURLToPath(new URL("../src/game/BoltboundScene.js", import.meta.url));
const source = readFileSync(scenePath, "utf8");

function createJumpState() {
  return {
    airJumpsRemaining: 1,
    keyboardWasDown: false,
    touchWasDown: false,
    queued: false,
    jumps: [],
  };
}

function jumpFrame(state, { grounded = false, keyboard = false, touch = false } = {}) {
  if (grounded) state.airJumpsRemaining = 1;
  const pressed =
    (keyboard && !state.keyboardWasDown) ||
    (touch && !state.touchWasDown);
  if (pressed) state.queued = true;
  if (state.queued && grounded) {
    state.jumps.push("ground");
    state.queued = false;
  } else if (state.queued && state.airJumpsRemaining > 0) {
    state.jumps.push("air");
    state.airJumpsRemaining -= 1;
    state.queued = false;
  }
  state.keyboardWasDown = keyboard;
  state.touchWasDown = touch;
}

const keyboardState = createJumpState();
jumpFrame(keyboardState, { grounded: true, keyboard: true });
jumpFrame(keyboardState, { keyboard: true });
jumpFrame(keyboardState, { keyboard: false });
jumpFrame(keyboardState, { keyboard: true });
jumpFrame(keyboardState, { keyboard: false });
jumpFrame(keyboardState, { keyboard: true });
assert.deepEqual(keyboardState.jumps, ["ground", "air"], "one hold must not repeat and a third jump is forbidden");

keyboardState.queued = false;
jumpFrame(keyboardState, { grounded: true, keyboard: false });
jumpFrame(keyboardState, { keyboard: true });
assert.deepEqual(keyboardState.jumps, ["ground", "air", "air"], "landing must restore one air jump");

const touchState = createJumpState();
jumpFrame(touchState, { grounded: true, touch: true });
jumpFrame(touchState, { touch: true });
jumpFrame(touchState, { touch: false });
jumpFrame(touchState, { touch: true });
jumpFrame(touchState, { touch: false });
jumpFrame(touchState, { touch: true });
assert.deepEqual(touchState.jumps, ["ground", "air"], "touch must also be edge-triggered");

function queuedJumpFrame(state, { grounded, presses = 0 }) {
  const landedNow = grounded && !state.wasGrounded;
  if (landedNow) {
    state.groundJumpCommitted = false;
    state.airJumpsRemaining = 1;
  }
  state.queue = Math.min(2, state.queue + presses);
  if (state.queue > 0) {
    state.queue -= 1;
    if (!state.groundJumpCommitted && grounded) {
      state.jumps.push("ground");
      state.groundJumpCommitted = true;
    } else if (state.airJumpsRemaining > 0) {
      state.jumps.push("air");
      state.airJumpsRemaining -= 1;
    }
  }
  state.wasGrounded = grounded;
}

const residualGroundState = {
  airJumpsRemaining: 1,
  groundJumpCommitted: false,
  wasGrounded: false,
  queue: 0,
  jumps: [],
};
queuedJumpFrame(residualGroundState, { grounded: true, presses: 2 });
queuedJumpFrame(residualGroundState, { grounded: true });
queuedJumpFrame(residualGroundState, { grounded: true });
assert.deepEqual(
  residualGroundState.jumps,
  ["ground", "air"],
  "two queued presses across residual grounded frames must become ground plus air jump",
);
assert.equal(residualGroundState.airJumpsRemaining, 0, "continuous grounded frames must not refill the air jump");
queuedJumpFrame(residualGroundState, { grounded: false });
queuedJumpFrame(residualGroundState, { grounded: true });
assert.equal(residualGroundState.airJumpsRemaining, 1, "a real airborne-to-ground transition must refill the air jump");

for (const required of [
  "AIR_JUMPS_PER_AIRTIME = 1",
  "AIR_JUMP_VELOCITY_FACTOR",
  "this.touchJumpPressed = true",
  "this.airJumpsRemaining -= 1",
  "this.jumpPressQueue = Math.min(2, this.jumpPressQueue + 1)",
  "this.consumeJumpPress()",
  "this.queueJumpPress();",
  "this.keyboardJumpEventsBound = Boolean(keyboard)",
  "const landedNow = !this.wasGrounded",
  "!this.groundJumpCommitted &&",
  "this.groundJumpCommitted = true",
  "resetJumpState({ preserveHeld: true })",
  "receiveBombBlast(blast)",
  "blast.placements.map",
  "this.mapRevision = revision",
  "this.showBombExplosion",
]) {
  assert.ok(source.includes(required), `scene is missing ${required}`);
}

assert.ok(
  !source.includes("(keyboardJumpDown && !this.keyboardJumpWasDown) || this.touchJumpPressed"),
  "jump edges must not collapse into one per-frame boolean",
);
assert.ok(
  !source.includes(".rectangle(WORLD.width / 2, 115, WORLD.width - 96, 6"),
  "scene must not redraw the removed sky separator line",
);
assert.ok(
  source.includes("sprite.setCollideWorldBounds(false)"),
  "racing players must be able to fall through the bottom world boundary",
);
assert.ok(
  source.includes('if (local.y > WORLD.height + 90) this.killLocalPlayer("fall")'),
  "falling below the world must eliminate the local racer",
);

const alignStart = source.indexOf("  alignPlayersToBuildBlockers()");
const alignEnd = source.indexOf("  pieceDimensions(", alignStart);
assert.ok(alignStart >= 0 && alignEnd > alignStart, "build blocker alignment method must be present");
const alignFunctionSource = source.slice(alignStart, alignEnd).trim().replace(
  /^alignPlayersToBuildBlockers\(\)/,
  "function alignPlayersToBuildBlockers()",
);
const alignPlayersToBuildBlockers = new Function(`return (${alignFunctionSource});`)();

function visibleNode() {
  return {
    visible: true,
    x: 0,
    y: 0,
    alpha: 1,
    setVisible(value) { this.visible = value; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setAlpha(value) { this.alpha = value; return this; },
    setAngle() { return this; },
    setFlipX() { return this; },
    setScale() { return this; },
    setCollideWorldBounds() { return this; },
    setVelocity() { return this; },
    setDragX() { return this; },
  };
}

const deadSprite = visibleNode();
deadSprite.body = { enable: true };
const deadLabel = visibleNode();
const deadEffect = visibleNode();
const liveSprite = visibleNode();
liveSprite.body = {
  enable: true,
  reset(x, y) { liveSprite.x = x; liveSprite.y = y; },
};
liveSprite.setVelocity = () => liveSprite;
const liveLabel = visibleNode();
const buildAlignmentScene = {
  roomState: {
    build: {
      blockers: [
        { playerId: "dead", x: 600, y: 995, blocksPlacement: false },
        { playerId: "live", x: 800, y: 320, blocksPlacement: true },
      ],
    },
  },
  myPlayerId: "dead",
  playerSprites: new Map([
    ["dead", { sprite: deadSprite, label: deadLabel, effectIcons: [deadEffect] }],
    ["live", { sprite: liveSprite, label: liveLabel, effectIcons: [] }],
  ]),
  remoteTargets: new Map(),
  createRemoteMotionState() { return {}; },
};
alignPlayersToBuildBlockers.call(buildAlignmentScene);
assert.equal(deadSprite.visible, false, "a previous-round corpse sprite must be hidden during building");
assert.equal(deadLabel.visible, false, "a previous-round corpse label must be hidden during building");
assert.equal(deadEffect.visible, false, "a previous-round corpse effect icon must be hidden during building");
assert.equal(deadSprite.body.enable, false, "a hidden corpse must not retain a colliding physics body");
deadSprite.body.enable = true;
alignPlayersToBuildBlockers.call(buildAlignmentScene);
assert.equal(deadSprite.body.enable, false, "a refreshed build state must disable the corpse body again");
assert.equal(liveSprite.visible, true, "a live build player must remain visible");
assert.deepEqual({ x: liveSprite.x, y: liveSprite.y }, { x: 800, y: 320 });

const resetStart = source.indexOf("  resetForRace()");
const resetEnd = source.indexOf("  canBuildNow()", resetStart);
assert.ok(resetStart >= 0 && resetEnd > resetStart, "race reset method must be present");
const resetFunctionSource = source.slice(resetStart, resetEnd).trim().replace(
  /^resetForRace\(\)/,
  "function resetForRace()",
);
const resetForRace = new Function("SPAWN", "PLAYER_DRAG_X", `return (${resetFunctionSource});`)(
  { x: 80, y: 142 },
  900,
);
Object.assign(buildAlignmentScene, {
  finishSent: true,
  deathSent: true,
  resetJumpState() {},
  resetMechanismRuntime() {},
});
resetForRace.call(buildAlignmentScene);
assert.equal(deadSprite.visible, true, "race reset must restore a corpse hidden during build");
assert.equal(deadLabel.visible, true, "race reset must restore the hidden corpse label");
assert.equal(deadEffect.visible, true, "race reset must restore hidden effect icons");
assert.equal(deadSprite.body.enable, true, "race reset must re-enable the restored player's physics body");


const bombStart = source.indexOf("  receiveBombBlast(blast)");
const bombEnd = source.indexOf("  receivePeerMotion(motion)", bombStart);
assert.ok(bombStart >= 0 && bombEnd > bombStart, "bomb handler boundaries must be present");
const bombHandler = source.slice(bombStart, bombEnd);
assert.ok(bombHandler.includes("this.rebuildMap();"), "bomb must rebuild the authoritative placement map");
for (const forbidden of ["resetForRace", "syncPlayers", "setPosition(", "setVelocity("]) {
  assert.ok(!bombHandler.includes(forbidden), `bomb rebuild must preserve live players: ${forbidden}`);
}

const bombFunctionSource = bombHandler.trim().replace(
  /^receiveBombBlast\(blast\)/,
  "function receiveBombBlast(blast)",
);
const bombFunction = new Function(
  "Phaser",
  "ACTIVE_ITEMS",
  "WORLD",
  `return (${bombFunctionSource});`,
)(
  { Math: { Clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)) } },
  { bomb: { radius: 220 } },
  { width: 1_600, height: 900 },
);

const livePlayer = { x: 620, y: 510, vx: 180, vy: -240 };
const bombScene = {
  roomState: {
    phase: "race",
    placements: [{ id: "old", type: "beam" }],
    mapRevision: 3,
    race: { mapRevision: 3 },
    livePlayer,
  },
  mapRevision: 3,
  rebuildCount: 0,
  explosions: [],
  audioEvents: [],
  rebuildMap() { this.rebuildCount += 1; },
  showBombExplosion(...args) { this.explosions.push(args); },
  bridge: {
    onAudioEvent(key, options) { bombScene.audioEvents.push({ key, options }); },
  },
};
assert.equal(bombFunction.call(bombScene, {
  x: 640,
  y: 520,
  radius: 220,
  sourcePlayerId: "audio-source",
  serverTime: 123_456,
  placements: [{ id: "kept", type: "spring" }],
  mapRevision: 4,
}), true);
assert.equal(bombScene.rebuildCount, 1);
assert.deepEqual(bombScene.roomState.placements, [{ id: "kept", type: "spring" }]);
assert.equal(bombScene.roomState.mapRevision, 4);
assert.equal(bombScene.roomState.race.mapRevision, 4);
assert.equal(bombScene.roomState.livePlayer, livePlayer, "map rebuild must preserve the live player object");
assert.deepEqual(livePlayer, { x: 620, y: 510, vx: 180, vy: -240 });

assert.equal(bombFunction.call(bombScene, {
  x: 640,
  y: 520,
  radius: 220,
  sourcePlayerId: "audio-source",
  serverTime: 123_456,
  placements: [{ id: "kept", type: "spring" }],
  mapRevision: 4,
}), true, "an empty blast on the current revision still renders");
assert.equal(bombScene.rebuildCount, 1, "an empty blast must not rebuild an unchanged map");
assert.equal(bombScene.explosions.length, 2);
assert.deepEqual(bombScene.audioEvents, [
  { key: "bomb", options: { dedupeKey: "audio-source:123456:4" } },
  { key: "bomb", options: { dedupeKey: "audio-source:123456:4" } },
], "accepted duplicate deliveries must carry the same audio dedupe key");
assert.equal(bombFunction.call(bombScene, { x: 0, y: 0, mapRevision: 2 }), false);
assert.equal(bombScene.explosions.length, 2, "stale blasts must be ignored");
assert.equal(bombScene.audioEvents.length, 2, "stale blasts must not emit audio");

console.log("double jump and bomb scene contract tests passed");
