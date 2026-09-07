import { GOAL, PIECES, PLAYER_COLLISION_BOUNDS, WORLD } from "../shared/gameConfig.js";
import { portalExitForLink, portalLinksForPlacements } from "../shared/placementRules.js";

export const RACE_MOTION_LIMITS = Object.freeze({
  maxXSpeed: 900,
  maxYSpeed: 1_100,
  maxXDebt: 24,
  maxYDebt: 32,
  clockLeadMs: 250,
  elapsedToleranceMs: 2,
  portalExitPositionTolerance: 8,
  portalExitVelocityTolerance: 40,
  finishFreshMs: 500,
  finishEpsilon: 3,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteVelocity(value) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nextMovementDebt(guard, dx, dy, elapsedDeltaMs) {
  const seconds = Math.max(0, elapsedDeltaMs) / 1_000;
  const debtX = Math.max(
    0,
    Number(guard.debtX || 0) + Math.abs(dx) - RACE_MOTION_LIMITS.maxXSpeed * seconds,
  );
  const debtY = Math.max(
    0,
    Number(guard.debtY || 0) + Math.abs(dy) - RACE_MOTION_LIMITS.maxYSpeed * seconds,
  );
  if (debtX > RACE_MOTION_LIMITS.maxXDebt || debtY > RACE_MOTION_LIMITS.maxYDebt) {
    return null;
  }
  return { debtX, debtY };
}

function distanceToPortalEntry(lastMotion, source) {
  const dx = Number(source.x) - Number(lastMotion.x);
  const dy = Number(source.y) - Number(lastMotion.y);
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance)) return null;
  if (distance <= PIECES.portal.triggerRadius || distance < 0.001) return { dx: 0, dy: 0 };
  const ratio = (distance - PIECES.portal.triggerRadius) / distance;
  return { dx: Math.abs(dx) * ratio, dy: Math.abs(dy) * ratio };
}

function validatePortalSnap({ x, y, vx, vy, elapsedMs, elapsedDeltaMs, lastMotion, guard, placements }) {
  if (elapsedMs + RACE_MOTION_LIMITS.elapsedToleranceMs < Number(guard.portalCooldownUntil || 0)) {
    return null;
  }

  for (const link of portalLinksForPlacements(placements)) {
    const { source } = link;
    const exit = portalExitForLink(link);
    if (!exit) continue;
    const { direction, x: exitX, y: exitY } = exit;
    if (
      !Number.isFinite(exitX) ||
      !Number.isFinite(exitY) ||
      Math.abs(x - exitX) > RACE_MOTION_LIMITS.portalExitPositionTolerance ||
      Math.abs(y - exitY) > RACE_MOTION_LIMITS.portalExitPositionTolerance
    ) continue;

    const expectedVx = direction.x * PIECES.portal.exitSpeed;
    const expectedVy = direction.y * PIECES.portal.exitSpeed;
    if (
      Math.abs(vx - expectedVx) > RACE_MOTION_LIMITS.portalExitVelocityTolerance ||
      Math.abs(vy - expectedVy) > RACE_MOTION_LIMITS.portalExitVelocityTolerance
    ) continue;

    const entry = distanceToPortalEntry(lastMotion, source);
    if (!entry) continue;
    const debt = nextMovementDebt(guard, entry.dx, entry.dy, elapsedDeltaMs);
    if (!debt) continue;

    return {
      motion: {
        x: exitX,
        y: exitY,
        vx: expectedVx,
        vy: expectedVy,
        facing: direction.x ? (direction.x < 0 ? -1 : 1) : (Number(lastMotion.facing) < 0 ? -1 : 1),
        snap: true,
        elapsedMs,
      },
      guard: {
        ...guard,
        ...debt,
        lastElapsedMs: elapsedMs,
        portalCooldownUntil: elapsedMs + PIECES.portal.cooldownMs,
        acceptedCount: Number(guard.acceptedCount || 0) + 1,
      },
    };
  }
  return null;
}

export function createRaceMotionGuard(elapsedMs = 0) {
  const safeElapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;
  return {
    lastElapsedMs: safeElapsed,
    debtX: 0,
    debtY: 0,
    portalCooldownUntil: 0,
    acceptedCount: 0,
    lastCorrectionAt: 0,
  };
}

export function validateRaceMotion({ payload, lastMotion, guard, placements = [], serverElapsedMs }) {
  const x = Number(payload?.x);
  const y = Number(payload?.y);
  const elapsed = Number(payload?.elapsedMs);
  const vx = finiteVelocity(payload?.vx);
  const vy = finiteVelocity(payload?.vy);
  if (![x, y, elapsed, vx, vy].every(Number.isFinite)) {
    return { ok: false, errorCode: "invalid_motion" };
  }
  if (
    x < -100 || x > WORLD.width + 100 ||
    y < -200 || y > WORLD.height + 300
  ) return { ok: false, errorCode: "motion_out_of_bounds" };

  const baseGuard = guard || createRaceMotionGuard();
  const previousElapsed = Math.max(0, Number(baseGuard.lastElapsedMs) || 0);
  const safeServerElapsed = Math.max(0, Number(serverElapsedMs) || 0);
  if (
    elapsed < -RACE_MOTION_LIMITS.elapsedToleranceMs ||
    elapsed + RACE_MOTION_LIMITS.elapsedToleranceMs < previousElapsed ||
    elapsed > safeServerElapsed + RACE_MOTION_LIMITS.clockLeadMs
  ) return { ok: false, errorCode: "invalid_motion_time" };

  const effectiveElapsed = Math.max(previousElapsed, elapsed);
  const elapsedDeltaMs = effectiveElapsed - previousElapsed;
  if (payload?.snap === true) {
    const portal = validatePortalSnap({
      x,
      y,
      vx,
      vy,
      elapsedMs: effectiveElapsed,
      elapsedDeltaMs,
      lastMotion,
      guard: baseGuard,
      placements,
    });
    return portal ? { ok: true, ...portal } : { ok: false, errorCode: "invalid_portal_snap" };
  }

  const debt = nextMovementDebt(
    baseGuard,
    x - Number(lastMotion.x),
    y - Number(lastMotion.y),
    elapsedDeltaMs,
  );
  if (!debt) return { ok: false, errorCode: "motion_too_fast" };

  return {
    ok: true,
    motion: {
      x,
      y,
      vx: clamp(vx, -RACE_MOTION_LIMITS.maxXSpeed, RACE_MOTION_LIMITS.maxXSpeed),
      vy: clamp(vy, -RACE_MOTION_LIMITS.maxYSpeed, RACE_MOTION_LIMITS.maxYSpeed),
      facing: Number(payload.facing) < 0 ? -1 : 1,
      snap: false,
      elapsedMs: effectiveElapsed,
    },
    guard: {
      ...baseGuard,
      ...debt,
      lastElapsedMs: effectiveElapsed,
      acceptedCount: Number(baseGuard.acceptedCount || 0) + 1,
    },
  };
}

export function playerOverlapsGoal(motion, goal = GOAL) {
  const x = Number(motion?.x);
  const y = Number(motion?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const epsilon = RACE_MOTION_LIMITS.finishEpsilon;
  const goalLeft = goal.x - goal.width / 2;
  const goalRight = goal.x + goal.width / 2;
  const goalTop = goal.y - goal.height / 2;
  const goalBottom = goal.y + goal.height / 2;
  return (
    x + PLAYER_COLLISION_BOUNDS.right >= goalLeft - epsilon &&
    x - PLAYER_COLLISION_BOUNDS.left <= goalRight + epsilon &&
    y + PLAYER_COLLISION_BOUNDS.bottom >= goalTop - epsilon &&
    y - PLAYER_COLLISION_BOUNDS.top <= goalBottom + epsilon
  );
}

export function isRaceFinishVerified({ lastMotion, guard, now = Date.now(), goal = GOAL }) {
  const motionAt = Number(lastMotion?.at);
  if (!guard || Number(guard.acceptedCount) < 1 || !Number.isFinite(motionAt)) return false;
  const age = now - motionAt;
  if (age < 0 || age > RACE_MOTION_LIMITS.finishFreshMs) return false;
  return playerOverlapsGoal(lastMotion, goal);
}
