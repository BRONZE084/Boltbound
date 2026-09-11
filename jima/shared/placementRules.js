import {
  BASE_PLATFORMS,
  GAME,
  GOAL,
  PIECES,
  PLAYER_COLLISION_BOUNDS,
  SPAWN,
  WORLD,
} from "./gameConfig.js";

const PLAYER_SPAWN_STEP_X = 44;
const PLAYER_SPAWN_STEP_Y = 8;
const SPAWN_PROTECTION_MARGIN = 16;
// The lab's construction category can share edges without an artificial gap.
const CONSTRUCTION_PIECE_TYPES = new Set(["beam", "crate", "barrier", "ice"]);
const lastSpawnX = SPAWN.x + (GAME.maxPlayers - 1) * PLAYER_SPAWN_STEP_X;
const highestSpawnY = SPAWN.y - (GAME.maxPlayers - 1) * PLAYER_SPAWN_STEP_Y;

const PROTECTED_ZONES = Object.freeze([
  Object.freeze({
    left: Math.max(0, SPAWN.x - PLAYER_COLLISION_BOUNDS.left - SPAWN_PROTECTION_MARGIN),
    right: Math.min(
      WORLD.width,
      lastSpawnX + PLAYER_COLLISION_BOUNDS.right + SPAWN_PROTECTION_MARGIN,
    ),
    top: Math.max(
      0,
      highestSpawnY - PLAYER_COLLISION_BOUNDS.top - SPAWN_PROTECTION_MARGIN,
    ),
    bottom: Math.min(
      WORLD.groundY,
      SPAWN.y + PLAYER_COLLISION_BOUNDS.bottom + SPAWN_PROTECTION_MARGIN,
    ),
  }),
  Object.freeze({ left: GOAL.x - 230, right: WORLD.width, top: 0, bottom: WORLD.groundY }),
]);

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
  else if (direction.y > 0) edgeDistance = WORLD.groundY - y;
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
    WORLD.groundY - PLAYER_COLLISION_BOUNDS.bottom,
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
  if (placement.type === "portal") {
    return safetyRectsForPlacementInTopology(placement, portalMode);
  }
  // A barrier occupies only its initial body during construction. Its separate
  // motion layer may cross other pieces; the full sweep still protects players
  // and reserved zones and must remain inside the world.
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
    candidate.y + candidate.height / 2 <= WORLD.groundY
  );
}

function rectIntersectsZone(candidate, zone) {
  return (
    candidate.x + candidate.width / 2 > zone.left &&
    candidate.x - candidate.width / 2 < zone.right &&
    candidate.y + candidate.height / 2 > zone.top &&
    candidate.y - candidate.height / 2 < zone.bottom
  );
}

export function validatePlacementSafety(placement, existingPlacements = [], buildBlockers = []) {
  const prospectivePlacements = [...existingPlacements, placement];
  const portalModes = portalModesForPlacements(prospectivePlacements);
  const candidatePortalMode = portalModes.get(placement) || null;
  if (placement.type === "portal") {
    const hasClampedExit = prospectivePlacements
      .filter((candidate) => candidate?.type === "portal")
      .some((portal) => {
        const mode = portalModes.get(portal);
        if (!["solo", "paired"].includes(mode)) return false;
        const exit = portalExitPosition(portal, mode);
        return !exit || exit.clamped;
      });
    if (hasClampedExit) return "out_of_bounds";
  }
  const safetyRects = safetyRectsForPlacementInTopology(placement, candidatePortalMode);
  if (!safetyRects.length || safetyRects.some((candidate) => !rectInsideWorld(candidate))) {
    return "out_of_bounds";
  }
  const protectionRects = placement.type === "blackhole"
    ? blockingRectsForPlacement(placement, candidatePortalMode)
    : safetyRects;
  if (protectionRects.some((candidate) => PROTECTED_ZONES.some((zone) => rectIntersectsZone(candidate, zone)))) {
    return "reserved_zone";
  }
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
      if (PROTECTED_ZONES.some((zone) => rectIntersectsZone(exitRect, zone))) return "reserved_zone";
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
  const platformSensitiveBody = [
    "barrier", "fan", "portal", "conveyor", "ice", "saw", "cannon", "laser", "bumper", "blackhole",
  ].includes(placement.type)
    ? bodyRect(placement)
    : null;
  if (
    platformSensitiveBody &&
    BASE_PLATFORM_RECTS.some((platform) => rectsOverlap(platformSensitiveBody, platform, 0))
  ) {
    return "piece_overlap";
  }
  const hasConflict = existingPlacements.some((other) => {
    const otherBlockingRects = blockingRectsForPlacement(other, portalModes.get(other) || null);
    // Remove extra clearance between construction pieces, never initial body
    // overlap or the space reserved for a portal exit.
    const margin = CONSTRUCTION_PIECE_TYPES.has(placement.type) && CONSTRUCTION_PIECE_TYPES.has(other.type)
      ? 0
      : 8;
    return blockingRects.some((candidate) =>
      otherBlockingRects.some((otherRect) => rectsOverlap(candidate, otherRect, margin)),
    );
  });
  return hasConflict ? "piece_overlap" : null;
}
