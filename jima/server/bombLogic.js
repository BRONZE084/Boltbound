import { PIECES } from "../shared/gameConfig.js";
import {
  dimensionsForPiece,
  portalLinksForPlacements,
} from "../shared/placementRules.js";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function placementRect(placement) {
  const dimensions = dimensionsForPiece(placement?.type, placement?.rotation);
  const x = finiteNumber(placement?.x);
  const y = finiteNumber(placement?.y);
  const width = finiteNumber(placement?.width) ?? dimensions?.width;
  const height = finiteNumber(placement?.height) ?? dimensions?.height;
  if (x === null || y === null || !width || !height || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function blastIntersectsPlacement(blast, placement) {
  const x = finiteNumber(blast?.x);
  const y = finiteNumber(blast?.y);
  const radius = finiteNumber(blast?.radius);
  const body = placementRect(placement);
  if (x === null || y === null || radius === null || radius < 0 || !body) return false;
  const nearestX = Math.max(body.x - body.width / 2, Math.min(x, body.x + body.width / 2));
  const nearestY = Math.max(body.y - body.height / 2, Math.min(y, body.y + body.height / 2));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

export function isPlayerPlacedObstacle(placement) {
  return Boolean(
    placement &&
    PIECES[placement.type] &&
    typeof placement.id === "string" &&
    placement.id &&
    typeof placement.ownerId === "string" &&
    placement.ownerId,
  );
}

function portalGroupRemovals(placements, blast) {
  const groups = new Map();
  for (const link of portalLinksForPlacements(placements)) {
    const group = groups.get(link.pairIndex) || new Set();
    group.add(link.source);
    if (link.target) group.add(link.target);
    groups.set(link.pairIndex, group);
  }
  const removals = new Set();
  for (const group of groups.values()) {
    if (![...group].some((placement) =>
      isPlayerPlacedObstacle(placement) && blastIntersectsPlacement(blast, placement))) continue;
    for (const placement of group) {
      if (isPlayerPlacedObstacle(placement)) removals.add(placement);
    }
  }
  return removals;
}

export function resolveBombBlast(placements = [], blast = {}) {
  const portalRemovals = portalGroupRemovals(placements, blast);
  const keptPlacements = [];
  const removedPlacementIds = [];
  for (const placement of placements) {
    const remove = isPlayerPlacedObstacle(placement) && (
      placement.type === "portal"
        ? portalRemovals.has(placement)
        : blastIntersectsPlacement(blast, placement)
    );
    if (remove) {
      removedPlacementIds.push(placement.id);
    } else {
      keptPlacements.push(placement);
    }
  }
  return { placements: keptPlacements, removedPlacementIds };
}
