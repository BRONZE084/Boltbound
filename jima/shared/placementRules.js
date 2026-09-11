import {
  BASE_PLATFORMS,
  GOAL_BUILD_CLEARANCE,
  PIECES,
  PLAYER_COLLISION_BOUNDS,
  WORLD,
} from "./gameConfig.js";

// 实验台的搭建类零件允许边缘相接，不额外要求间隔。
const CONSTRUCTION_PIECE_TYPES = new Set(["beam", "crate", "barrier", "ice", "windmill", "rotatingCrate"]);

const BASE_PLATFORM_RECTS = Object.freeze(
  BASE_PLATFORMS.map((platform) => Object.freeze({ ...platform })),
);

export function normalizedRotation(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rotation = ((numeric % 360) + 360) % 360;
  return rotation % 90 === 0 ? rotation : null;
}

export function directionForRotation(rotation = 0) {
  const normalized = normalizedRotation(rotation) ?? 0;
  if (normalized === 90) return { x: 1, y: 0 };
  if (normalized === 180) return { x: 0, y: 1 };
  if (normalized === 270) return { x: -1, y: 0 };
  return { x: 0, y: -1 };
}

export function dimensionsForPiece(type, rotation = 0) {
  const piece = PIECES[type];
  const normalized = normalizedRotation(rotation);
  if (!piece || normalized === null) return null;
  return normalized % 180 === 90
    ? { width: piece.height, height: piece.width }
    : { width: piece.width, height: piece.height };
}

function rect(x, y, width, height) {
  return { x, y, width, height };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function bodyRect(placement) {
  const dimensions = dimensionsForPiece(placement.type, placement.rotation);
  if (!dimensions) return null;
  return rect(
    Number(placement.x),
    Number(placement.y),
    Number(placement.width) || dimensions.width,
    Number(placement.height) || dimensions.height,
  );
}

function blockerRect(blocker) {
  const width = Number(blocker?.width);
  const height = Number(blocker?.height);
  const x = Number(blocker?.x);
  const y = Number(blocker?.y);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return rect(x, y, width, height);
}

export function directionalRangeToBlocker(
  x,
  y,
  direction,
  configuredRange,
  crossHalfWidth = 0,
  startDistance = 0,
  blockers = BASE_PLATFORM_RECTS,
) {
  if (![x, y, configuredRange, crossHalfWidth, startDistance].every(Number.isFinite)) return 0;
  let edgeDistance;
  if (direction.x > 0) edgeDistance = WORLD.width - x;
  else if (direction.x < 0) edgeDistance = x;
  else if (direction.y > 0) edgeDistance = WORLD.height - y;
  else edgeDistance = y;
  let range = Math.max(startDistance, Math.min(configuredRange, edgeDistance));
  for (const candidate of blockers) {
    const blocker = blockerRect(candidate);
    if (!blocker) continue;
    const crossDistance = direction.x ? Math.abs(blocker.y - y) : Math.abs(blocker.x - x);
    const crossExtent = (direction.x ? blocker.height : blocker.width) / 2 + crossHalfWidth;
    if (crossDistance > crossExtent) continue;
    let nearDistance;
    let farDistance;
    if (direction.x > 0) {
      nearDistance = blocker.x - blocker.width / 2 - x;
      farDistance = blocker.x + blocker.width / 2 - x;
    } else if (direction.x < 0) {
      nearDistance = x - (blocker.x + blocker.width / 2);
      farDistance = x - (blocker.x - blocker.width / 2);
    } else if (direction.y > 0) {
      nearDistance = blocker.y - blocker.height / 2 - y;
      farDistance = blocker.y + blocker.height / 2 - y;
    } else {
      nearDistance = y - (blocker.y + blocker.height / 2);
      farDistance = y - (blocker.y - blocker.height / 2);
    }
    if (nearDistance > startDistance && nearDistance < range) range = nearDistance;
    else if (nearDistance <= startDistance && farDistance >= startDistance) range = startDistance;
  }
  return Math.max(startDistance, range);
}

function directionalEffectRect(body, direction, range, width, crossHalfWidth, startDistance) {
  const start = startDistance;
  const end = directionalRangeToBlocker(
    body.x,
    body.y,
    direction,
    range,
    crossHalfWidth,
    startDistance,
  );
  const length = end - start;
  if (length <= 0) return null;
  const distance = start + length / 2;
  return rect(
    body.x + direction.x * distance,
    body.y + direction.y * distance,
    direction.x ? length : width,
    direction.x ? width : length,
  );
}

function effectWidthForPiece(type, piece) {
  if (type === "cannon") return piece.projectileRadius * 2 + 54;
  if (type === "laser") return piece.beamWidth + 54;
  return 0;
}

export function portalLinksForPlacements(placements = []) {
  const portals = placements.filter((placement) => placement?.type === "portal");
  const links = [];
  for (let index = 0; index + 1 < portals.length; index += 2) {
    const pairIndex = index / 2;
    links.push(
      { source: portals[index], target: portals[index + 1], mode: "paired", pairIndex },
      { source: portals[index + 1], target: portals[index], mode: "paired", pairIndex },
    );
  }
  if (portals.length % 2 === 1) {
    const tailIndex = portals.length - 1;
    links.push({
      source: portals[tailIndex],
      target: null,
      mode: "solo",
      pairIndex: Math.floor(tailIndex / 2),
    });
  }
  return links;
}

export function portalModeForPlacement(placement, placements = []) {
  if (placement?.type !== "portal") return null;
  const link = portalLinksForPlacements(placements).find((candidate) => candidate.source === placement);
  return link?.mode || "inactive";
}

export function portalExitPosition(portal, mode = "paired") {
  if (portal?.type !== "portal" || normalizedRotation(portal.rotation) === null) return null;
  const x = Number(portal.x);
  const y = Number(portal.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const requestedDirection = directionForRotation(portal.rotation);
  const distance = mode === "solo" ? PIECES.portal.soloDistance : PIECES.portal.exitOffset;
  const exact = {
    x: x + requestedDirection.x * distance,
    y: y + requestedDirection.y * distance,
  };
  const exitX = clamp(
    exact.x,
    PLAYER_COLLISION_BOUNDS.left,
    WORLD.width - PLAYER_COLLISION_BOUNDS.right,
  );
  const exitY = clamp(
    exact.y,
    PLAYER_COLLISION_BOUNDS.top,
    WORLD.height - PLAYER_COLLISION_BOUNDS.bottom,
  );
  const clamped = exitX !== exact.x || exitY !== exact.y;
  return {
    x: exitX,
    y: exitY,
    exact,
    clamped,
    requestedDirection,
    direction: clamped
      ? {
          x: requestedDirection.x === 0 ? 0 : -requestedDirection.x,
          y: requestedDirection.y === 0 ? 0 : -requestedDirection.y,
        }
      : requestedDirection,
  };
}

export function portalExitForLink(link) {
  if (!link || !["solo", "paired"].includes(link.mode)) return null;
  const anchor = link.mode === "solo" ? link.source : link.target;
  const exit = portalExitPosition(anchor, link.mode);
  return exit ? { ...exit, anchor } : null;
}

export function portalExitRect(portal, mode = "paired") {
  const exit = portalExitPosition(portal, mode);
  if (!exit) return null;
  const bounds = PLAYER_COLLISION_BOUNDS;
  return rect(
    exit.x + (bounds.right - bounds.left) / 2,
    exit.y + (bounds.bottom - bounds.top) / 2,
    bounds.left + bounds.right,
    bounds.top + bounds.bottom,
  );
}

function portalModesForPlacements(placements) {
  const modes = new Map(
    placements
      .filter((placement) => placement?.type === "portal")
      .map((portal) => [portal, "inactive"]),
  );
  for (const link of portalLinksForPlacements(placements)) modes.set(link.source, link.mode);
  return modes;
}

function safetyRectsForPlacementInTopology(placement, portalMode = null) {
  const piece = PIECES[placement.type];
  const body = bodyRect(placement);
  if (!piece || !body) return [];
  const direction = directionForRotation(placement.rotation);

  if (placement.type === "portal") {
    const exit = ["solo", "paired"].includes(portalMode)
      ? portalExitRect(placement, portalMode)
      : null;
    return exit ? [body, exit] : [body];
  }

  if (placement.type === "fan") {
    const depth = direction.x ? body.width : body.height;
    const front = depth / 2;
    const range = Math.max(0, piece.effectRange - front);
    const distance = front + range / 2;
    return [
      body,
      rect(
        body.x + direction.x * distance,
        body.y + direction.y * distance,
        direction.x ? range : piece.effectWidth,
        direction.x ? piece.effectWidth : range,
      ),
    ];
  }

  if (placement.type === "barrier") {
    const horizontal = (normalizedRotation(placement.rotation) ?? 0) % 180 === 0;
    return [
      rect(
        body.x,
        body.y,
        body.width + (horizontal ? piece.travelRange * 2 : 0),
        body.height + (horizontal ? 0 : piece.travelRange * 2),
      ),
    ];
  }

  if (placement.type === "blackhole") {
    return [rect(body.x, body.y, piece.effectRadius * 2, piece.effectRadius * 2)];
  }

  if (["cannon", "laser"].includes(placement.type)) {
    const effect = directionalEffectRect(
      body,
      direction,
      piece.range,
      effectWidthForPiece(placement.type, piece),
      placement.type === "cannon" ? piece.projectileRadius : piece.beamWidth / 2,
      piece.muzzleOffset,
    );
    return effect ? [body, effect] : [body];
  }

  if (placement.type === "bumper") {
    return [body, rect(body.x, body.y, piece.triggerRadius * 2, piece.triggerRadius * 2)];
  }

  return [body];
}

export function safetyRectsForPlacement(placement) {
  const portalMode = placement?.type === "portal" ? "solo" : null;
  return safetyRectsForPlacementInTopology(placement, portalMode);
}

function blockingRectsForPlacement(placement, portalMode = null) {
  if (placement.type === "windmill") {
    const piece = PIECES.windmill;
    return [0, 1, 2, 3].map((index) => {
      const angle = (Number(placement.rotation || 0) + index * 90) * Math.PI / 180;
      return rect(Number(placement.x) + Math.cos(angle) * piece.orbitRadius,
        Number(placement.y) + Math.sin(angle) * piece.orbitRadius, piece.platformWidth, piece.platformHeight);
    });
  }

  if (placement.type === "portal") {
    return safetyRectsForPlacementInTopology(placement, portalMode);
  }
  // 搭建时只检查路障初始实体的占用范围，独立运动层允许其穿过其他零件。
  // 运动轨迹和作用范围不占用搭建位置，运行时仍与人物交互。
  const body = bodyRect(placement);
  return body ? [body] : [];
}

export function rectsOverlap(a, b, margin = 8) {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width + margin &&
    Math.abs(a.y - b.y) * 2 < a.height + b.height + margin
  );
}

function rectInsideWorld(candidate) {
  return (
    candidate.x - candidate.width / 2 >= 0 &&
    candidate.x + candidate.width / 2 <= WORLD.width &&
    candidate.y - candidate.height / 2 >= 0 &&
    candidate.y + candidate.height / 2 <= WORLD.height
  );
}

// 以零件中心判断画面边界，边缘允许零件部分伸出；碰撞另行检查。
export function placementCenterInsideWorld({ x, y }) {
  return Number.isFinite(x) && Number.isFinite(y) &&
    x >= 0 && x <= WORLD.width && y >= 0 && y <= WORLD.height;
}

// 只保护旗子碰撞体，运动件按实际行程检查，避免多算不会到达的位置。
export function placementBlocksGoal(placement) {
  let candidates = blockingRectsForPlacement(placement);
  const body = bodyRect(placement);
  if (!body) return false;
  if (placement.type === "barrier") {
    const horizontal = (normalizedRotation(placement.rotation) ?? 0) % 180 === 0;
    const travel = Math.max(0, Math.min(PIECES.barrier.travelRange,
      horizontal ? body.x - body.width / 2 : body.y - body.height / 2,
      horizontal ? WORLD.width - body.x - body.width / 2 : WORLD.height - body.y - body.height / 2));
    candidates = [rect(body.x, body.y, body.width + (horizontal ? travel * 2 : 0),
      body.height + (horizontal ? 0 : travel * 2))];
  } else if (placement.type === "windmill") {
    // 四个平台保持水平：用平台半尺寸扩展旗子，再检查平台中心的圆形轨迹。
    const left = GOAL_BUILD_CLEARANCE.left - PIECES.windmill.platformWidth / 2 - body.x;
    const right = GOAL_BUILD_CLEARANCE.right + PIECES.windmill.platformWidth / 2 - body.x;
    const top = GOAL_BUILD_CLEARANCE.top - PIECES.windmill.platformHeight / 2 - body.y;
    const bottom = GOAL_BUILD_CLEARANCE.bottom + PIECES.windmill.platformHeight / 2 - body.y;
    const nearest = Math.hypot(clamp(0, left, right), clamp(0, top, bottom));
    const farthest = Math.hypot(Math.max(Math.abs(left), Math.abs(right)), Math.max(Math.abs(top), Math.abs(bottom)));
    return nearest < PIECES.windmill.orbitRadius && farthest > PIECES.windmill.orbitRadius;
  } else if (placement.type === "rotatingCrate") {
    const radius = Math.hypot(PIECES.rotatingCrate.width, PIECES.rotatingCrate.height) / 2;
    const nearestX = clamp(body.x, GOAL_BUILD_CLEARANCE.left, GOAL_BUILD_CLEARANCE.right);
    const nearestY = clamp(body.y, GOAL_BUILD_CLEARANCE.top, GOAL_BUILD_CLEARANCE.bottom);
    return Math.hypot(body.x - nearestX, body.y - nearestY) < radius;
  }
  return candidates.some((candidate) =>
    candidate.x + candidate.width / 2 > GOAL_BUILD_CLEARANCE.left &&
    candidate.x - candidate.width / 2 < GOAL_BUILD_CLEARANCE.right &&
    candidate.y + candidate.height / 2 > GOAL_BUILD_CLEARANCE.top &&
    candidate.y - candidate.height / 2 < GOAL_BUILD_CLEARANCE.bottom);
}

export function validatePlacementSafety(placement, existingPlacements = [], buildBlockers = [], { allowGoalOverlap = false } = {}) {
  const prospectivePlacements = [...existingPlacements, placement];
  const portalModes = portalModesForPlacements(prospectivePlacements);
  const candidatePortalMode = portalModes.get(placement) || null;
  const body = bodyRect(placement);
  if (!body || !placementCenterInsideWorld(body)) return "out_of_bounds";
  if (!allowGoalOverlap && placementBlocksGoal(placement)) return "goal_blocked";
  // 其余区域只检查当前人物、零件实体及传送出口。
  const protectionRects = blockingRectsForPlacement(placement, candidatePortalMode);
  const blocksVisiblePlayer = buildBlockers.some((blocker) => {
    if (blocker?.blocksPlacement === false) return false;
    const blockerRect = rect(
      Number(blocker?.x),
      Number(blocker?.y),
      Number(blocker?.width),
      Number(blocker?.height),
    );
    if (
      !Number.isFinite(blockerRect.x) ||
      !Number.isFinite(blockerRect.y) ||
      !Number.isFinite(blockerRect.width) ||
      !Number.isFinite(blockerRect.height) ||
      blockerRect.width <= 0 ||
      blockerRect.height <= 0
    ) return false;
    return protectionRects.some((candidate) => rectsOverlap(candidate, blockerRect, 16));
  });

  if (placement.type === "portal") {
    for (const portal of prospectivePlacements.filter((candidate) => candidate?.type === "portal")) {
      const mode = portalModes.get(portal);
      if (!["solo", "paired"].includes(mode)) continue;
      const exitRect = portalExitRect(portal, mode);
      if (!exitRect || !rectInsideWorld(exitRect)) return "out_of_bounds";
      if (BASE_PLATFORM_RECTS.some((platform) => rectsOverlap(exitRect, platform, 0))) {
        return "piece_overlap";
      }
      const blocksPlayer = buildBlockers.some((blocker) => {
        if (blocker?.blocksPlacement === false) return false;
        const blockerRect = rect(
          Number(blocker?.x),
          Number(blocker?.y),
          Number(blocker?.width),
          Number(blocker?.height),
        );
        return (
          Number.isFinite(blockerRect.x) &&
          Number.isFinite(blockerRect.y) &&
          Number.isFinite(blockerRect.width) &&
          Number.isFinite(blockerRect.height) &&
          blockerRect.width > 0 &&
          blockerRect.height > 0 &&
          rectsOverlap(exitRect, blockerRect, 16)
        );
      });
      if (blocksPlayer) return "reserved_zone";

      const exitBlocked = prospectivePlacements.some((other) => {
        if (other === portal) return false;
        const otherMode = portalModes.get(other) || null;
        return blockingRectsForPlacement(other, otherMode)
          .some((otherRect) => rectsOverlap(exitRect, otherRect));
      });
      if (exitBlocked) return "piece_overlap";
    }
  }
  if (blocksVisiblePlayer) return "reserved_zone";

  const blockingRects = blockingRectsForPlacement(placement, candidatePortalMode);
  const platformSensitiveBodies = [
    "barrier", "fan", "portal", "conveyor", "ice", "saw", "cannon", "laser", "bumper", "blackhole", "windmill", "rotatingCrate",
  ].includes(placement.type)
    ? blockingRects
    : [];
  if (
    platformSensitiveBodies.some((candidate) => BASE_PLATFORM_RECTS.some((platform) => rectsOverlap(candidate, platform, 0)))
  ) {
    return "piece_overlap";
  }
  const hasConflict = existingPlacements.some((other) => {
    const otherBlockingRects = blockingRectsForPlacement(other, portalModes.get(other) || null);
    // 搭建类零件可贴边接合，仍禁止初始实体重叠或侵占传送门出口。
    const margin = CONSTRUCTION_PIECE_TYPES.has(placement.type) && CONSTRUCTION_PIECE_TYPES.has(other.type)
      ? 0
      : 8;
    return blockingRects.some((candidate) =>
      otherBlockingRects.some((otherRect) => rectsOverlap(candidate, otherRect, margin)),
    );
  });
  return hasConflict ? "piece_overlap" : null;
}
