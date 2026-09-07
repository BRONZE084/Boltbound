import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_PLATFORMS,
  GOAL,
  PIECES,
  PLAYER_COLLISION_BOUNDS,
  SPAWN,
} from "../shared/gameConfig.js";
import {
  RACE_MOTION_LIMITS,
  createRaceMotionGuard,
  isRaceFinishVerified,
  playerOverlapsGoal,
  validateRaceMotion,
} from "./raceValidation.js";

function baseMotion(overrides = {}) {
  return { x: SPAWN.x, y: SPAWN.y, vx: 0, vy: 0, facing: 1, at: 1_000, elapsedMs: 0, ...overrides };
}

function update(lastMotion, guard, overrides = {}, serverElapsedMs = 50, placements = []) {
  return validateRaceMotion({
    payload: {
      x: lastMotion.x + 45,
      y: lastMotion.y + 55,
      vx: 900,
      vy: 1_100,
      facing: 1,
      elapsedMs: 50,
      ...overrides,
    },
    lastMotion,
    guard,
    placements,
    serverElapsedMs,
  });
}

test("accepts all legitimate 50 ms speed caps and rejects excess debt", () => {
  const last = baseMotion();
  const guard = createRaceMotionGuard();
  const accepted = update(last, guard);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.guard.debtX, 0);
  assert.equal(accepted.guard.debtY, 0);

  assert.equal(update(last, guard, { x: last.x + 70 }).errorCode, "motion_too_fast");
  assert.equal(update(last, guard, { y: last.y + 88 }).errorCode, "motion_too_fast");
});

test("fixed error debt cannot be multiplied by high-frequency packets", () => {
  let last = baseMotion();
  let guard = createRaceMotionGuard();
  for (let index = 0; index < RACE_MOTION_LIMITS.maxXDebt; index += 1) {
    const result = update(last, guard, {
      x: last.x + 1,
      y: last.y,
      vx: 0,
      vy: 0,
      elapsedMs: 0,
    }, 0);
    assert.equal(result.ok, true);
    last = { ...result.motion, at: 1_000 };
    guard = result.guard;
  }
  const rejected = update(last, guard, {
    x: last.x + 1,
    y: last.y,
    vx: 0,
    vy: 0,
    elapsedMs: 0,
  }, 0);
  assert.equal(rejected.errorCode, "motion_too_fast");
});

test("client elapsed time permits buffered packets but rejects replay and future time", () => {
  let last = baseMotion();
  let guard = createRaceMotionGuard();
  for (const elapsedMs of [50, 100, 150]) {
    const result = update(last, guard, {
      x: last.x + 45,
      y: last.y,
      elapsedMs,
    }, 150);
    assert.equal(result.ok, true);
    last = { ...result.motion, at: 1_000 + elapsedMs };
    guard = result.guard;
  }
  assert.equal(update(last, guard, { elapsedMs: 100 }, 150).errorCode, "invalid_motion_time");
  assert.equal(update(last, guard, { elapsedMs: 500 }, 150).errorCode, "invalid_motion_time");
});

test("only a reachable paired portal can produce a canonical snap", () => {
  const placements = [
    { type: "portal", x: 500, y: 500, rotation: 0 },
    { type: "portal", x: 1_000, y: 500, rotation: 90 },
  ];
  const last = baseMotion({ x: 500 - PIECES.portal.triggerRadius, y: 500 });
  const guard = createRaceMotionGuard();
  const accepted = update(last, guard, {
    x: 1_000 + PIECES.portal.exitOffset,
    y: 500,
    vx: PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, placements);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.motion.snap, true);
  assert.equal(accepted.motion.x, 1_000 + PIECES.portal.exitOffset);

  assert.equal(update(last, guard, {
    x: accepted.motion.x + 9,
    y: accepted.motion.y,
    vx: PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, placements).errorCode, "invalid_portal_snap");
  assert.equal(update(baseMotion(), guard, {
    x: accepted.motion.x,
    y: accepted.motion.y,
    vx: PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, placements).errorCode, "invalid_portal_snap");
});

test("a single portal produces canonical snaps in all four directions", () => {
  const cases = [
    { rotation: 0, x: 800, y: 120, vx: 0, vy: -PIECES.portal.exitSpeed },
    { rotation: 90, x: 1_080, y: 400, vx: PIECES.portal.exitSpeed, vy: 0 },
    { rotation: 180, x: 800, y: 680, vx: 0, vy: PIECES.portal.exitSpeed },
    { rotation: 270, x: 520, y: 400, vx: -PIECES.portal.exitSpeed, vy: 0 },
  ];

  for (const expected of cases) {
    const portal = { type: "portal", x: 800, y: 400, rotation: expected.rotation };
    const last = baseMotion({ x: portal.x - PIECES.portal.triggerRadius, y: portal.y });
    const accepted = update(last, createRaceMotionGuard(), {
      x: expected.x + 4,
      y: expected.y - 3,
      vx: expected.vx + (expected.vx ? 20 : 0),
      vy: expected.vy + (expected.vy ? 20 : 0),
      elapsedMs: 50,
      snap: true,
    }, 50, [portal]);
    assert.equal(accepted.ok, true);
    assert.deepEqual(
      {
        x: accepted.motion.x,
        y: accepted.motion.y,
        vx: accepted.motion.vx,
        vy: accepted.motion.vy,
        snap: accepted.motion.snap,
      },
      {
        x: expected.x,
        y: expected.y,
        vx: expected.vx,
        vy: expected.vy,
        snap: true,
      },
    );
  }
});

test("clamped legacy portals launch inward and reject outward velocity", () => {
  const edgePortal = { type: "portal", x: 800, y: 160, rotation: 0 };
  const edgeLast = baseMotion({
    x: edgePortal.x - PIECES.portal.triggerRadius,
    y: edgePortal.y,
  });
  const clamped = update(edgeLast, createRaceMotionGuard(), {
    x: edgePortal.x,
    y: PLAYER_COLLISION_BOUNDS.top,
    vx: 0,
    vy: PIECES.portal.exitSpeed,
    elapsedMs: 50,
    snap: true,
  }, 50, [edgePortal]);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.motion.y, PLAYER_COLLISION_BOUNDS.top);
  assert.equal(clamped.motion.vy, PIECES.portal.exitSpeed);

  assert.equal(update(edgeLast, createRaceMotionGuard(), {
    x: edgePortal.x,
    y: PLAYER_COLLISION_BOUNDS.top,
    vx: 0,
    vy: -PIECES.portal.exitSpeed,
    elapsedMs: 50,
    snap: true,
  }, 50, [edgePortal]).errorCode, "invalid_portal_snap");

  const paired = [
    { type: "portal", x: 800, y: 400, rotation: 0 },
    { type: "portal", x: 1_520, y: 400, rotation: 90 },
  ];
  const pairedLast = baseMotion({
    x: paired[0].x - PIECES.portal.triggerRadius,
    y: paired[0].y,
  });
  const pairedClamp = update(pairedLast, createRaceMotionGuard(), {
    x: 1_600 - PLAYER_COLLISION_BOUNDS.right,
    y: paired[1].y,
    vx: -PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, paired);
  assert.equal(pairedClamp.ok, true);
  assert.equal(pairedClamp.motion.vx, -PIECES.portal.exitSpeed);

  const solo = { type: "portal", x: 800, y: 400, rotation: 90 };
  const soloLast = baseMotion({ x: solo.x - PIECES.portal.triggerRadius, y: solo.y });
  assert.equal(update(soloLast, createRaceMotionGuard(), {
    x: solo.x + PIECES.portal.exitOffset,
    y: solo.y,
    vx: PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, [solo]).errorCode, "invalid_portal_snap");
});

test("an odd portal tail remains solo while forged paired exits are rejected", () => {
  const placements = [
    { type: "portal", x: 500, y: 500, rotation: 0 },
    { type: "portal", x: 1_000, y: 500, rotation: 90 },
    { type: "portal", x: 800, y: 400, rotation: 90 },
  ];
  const tail = placements[2];
  const last = baseMotion({ x: tail.x - PIECES.portal.triggerRadius, y: tail.y });
  const accepted = update(last, createRaceMotionGuard(), {
    x: tail.x + PIECES.portal.soloDistance,
    y: tail.y,
    vx: PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, placements);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.motion.x, tail.x + PIECES.portal.soloDistance);

  assert.equal(update(last, createRaceMotionGuard(), {
    x: tail.x + PIECES.portal.exitOffset,
    y: tail.y,
    vx: PIECES.portal.exitSpeed,
    vy: 0,
    elapsedMs: 50,
    snap: true,
  }, 50, placements).errorCode, "invalid_portal_snap");
});

test("normal packets cannot claim snap without any portal", () => {
  const result = update(baseMotion(), createRaceMotionGuard(), {
    snap: true,
    elapsedMs: 50,
  });
  assert.equal(result.errorCode, "invalid_portal_snap");
});

test("finish requires a fresh accepted motion with full goal AABB overlap", () => {
  const now = 10_000;
  const guard = { ...createRaceMotionGuard(), acceptedCount: 1 };
  const left = GOAL.x - GOAL.width / 2 - 20 - RACE_MOTION_LIMITS.finishEpsilon;
  const top = GOAL.y - GOAL.height / 2 - 38 - RACE_MOTION_LIMITS.finishEpsilon;
  const touching = baseMotion({ x: left, y: top, at: now });
  assert.equal(playerOverlapsGoal(touching), true);
  assert.equal(isRaceFinishVerified({ lastMotion: touching, guard, now }), true);
  assert.equal(playerOverlapsGoal({ ...touching, x: left - 0.1 }), false);
  assert.equal(playerOverlapsGoal({ ...touching, y: GOAL.y - GOAL.height / 2 - 42 }), false);
  assert.equal(isRaceFinishVerified({ lastMotion: { ...touching, at: now - 501 }, guard, now }), false);
  assert.equal(isRaceFinishVerified({ lastMotion: touching, guard: createRaceMotionGuard(), now }), false);
});

test("a player standing on the final platform overlaps the supported goal", () => {
  const finalPlatform = BASE_PLATFORMS.find((platform) => platform.id === "final-step");
  assert.ok(finalPlatform);
  const platformLeft = finalPlatform.x - finalPlatform.width / 2;
  const platformRight = finalPlatform.x + finalPlatform.width / 2;
  const platformTop = finalPlatform.y - finalPlatform.height / 2;
  const standing = {
    x: GOAL.x,
    y: platformTop - PLAYER_COLLISION_BOUNDS.bottom,
  };

  assert.equal(GOAL.y + GOAL.height / 2, platformTop);
  assert.ok(standing.x - PLAYER_COLLISION_BOUNDS.left >= platformLeft);
  assert.ok(standing.x + PLAYER_COLLISION_BOUNDS.right <= platformRight);
  assert.equal(playerOverlapsGoal(standing), true);
});

test("non-finite and world-exterior positions are rejected", () => {
  const last = baseMotion();
  const guard = createRaceMotionGuard();
  assert.equal(update(last, guard, { x: Number.NaN }).errorCode, "invalid_motion");
  assert.equal(update(last, guard, { x: 1_701 }).errorCode, "motion_out_of_bounds");
});
