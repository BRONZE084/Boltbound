import {
  BASE_PLATFORMS,
  GOAL,
  PLAYER_COLLISION_BOUNDS,
  SPAWN,
} from "../shared/gameConfig.js";

const EDGE_CLEARANCE = 10;

function appendDistinct(points, point) {
  const previous = points.at(-1);
  if (previous && previous.x === point.x && previous.y === point.y) return;
  points.push(Object.freeze(point));
}

function standingY(platform) {
  return platform.y - platform.height / 2 - PLAYER_COLLISION_BOUNDS.bottom;
}

export function createBotRaceRoute(platforms = BASE_PLATFORMS, spawn = SPAWN) {
  const routePlatforms = [...platforms].sort((left, right) => left.x - right.x);
  if (routePlatforms.length === 0) {
    return Object.freeze([
      Object.freeze({ x: Number(spawn.x), y: Number(spawn.y) }),
      Object.freeze({ x: GOAL.x, y: GOAL.y }),
    ]);
  }

  const points = [];
  appendDistinct(points, { x: Number(spawn.x), y: Number(spawn.y) });
  for (const [index, platform] of routePlatforms.entries()) {
    const platformY = standingY(platform);
    if (index > 0) appendDistinct(points, { x: platform.x, y: platformY });
    const next = routePlatforms[index + 1];
    if (!next) {
      appendDistinct(points, { x: GOAL.x, y: platformY });
      break;
    }

    const rightEdge = platform.x + platform.width / 2;
    appendDistinct(points, {
      x: rightEdge - PLAYER_COLLISION_BOUNDS.right - EDGE_CLEARANCE,
      y: platformY,
    });
    const clearX = rightEdge + PLAYER_COLLISION_BOUNDS.left + EDGE_CLEARANCE;
    appendDistinct(points, {
      x: clearX,
      y: platformY,
    });
    appendDistinct(points, {
      x: clearX,
      y: platformY + 8,
    });

    appendDistinct(points, { x: next.x, y: standingY(next) });
  }
  return Object.freeze(points);
}

export function routeDistance(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
  }
  return total;
}

export function sampleBotRaceRoute(points, progress, durationMs) {
  const total = routeDistance(points);
  const clampedProgress = Math.max(0, Math.min(1, Number(progress) || 0));
  if (points.length === 0 || total <= 0) {
    return { x: SPAWN.x, y: SPAWN.y, vx: 0, vy: 0 };
  }
  if (clampedProgress >= 1) {
    const last = points.at(-1);
    return { x: last.x, y: last.y, vx: 0, vy: 0 };
  }

  let remaining = total * clampedProgress;
  const speed = total / Math.max(0.001, Number(durationMs) / 1_000);
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (remaining > length) {
      remaining -= length;
      continue;
    }
    const ratio = length > 0 ? remaining / length : 0;
    return {
      x: start.x + dx * ratio,
      y: start.y + dy * ratio,
      vx: length > 0 ? (dx / length) * speed : 0,
      vy: length > 0 ? (dy / length) * speed : 0,
    };
  }

  const last = points.at(-1);
  return { x: last.x, y: last.y, vx: 0, vy: 0 };
}
