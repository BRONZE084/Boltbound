import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_ITEMS, BASE_PLATFORMS, SPAWN } from "../shared/gameConfig.js";
import { portalLinksForPlacements } from "../shared/placementRules.js";
import {
  blastIntersectsPlacement,
  isPlayerPlacedObstacle,
  resolveBombBlast,
} from "./bombLogic.js";

function placed(overrides = {}) {
  return {
    id: "placed-a",
    ownerId: "player-a",
    type: "crate",
    x: 400,
    y: 500,
    width: 80,
    height: 80,
    rotation: 0,
    ...overrides,
  };
}

function portal(id, x, y, rotation = 90) {
  return placed({ id, type: "portal", x, y, width: 80, height: 120, rotation });
}

test("bomb config is an instant self item with a bounded blast radius", () => {
  assert.equal(ACTIVE_ITEMS.bomb.kind, "self_instant");
  assert.equal(ACTIVE_ITEMS.bomb.radius, 220);
  assert.equal(ACTIVE_ITEMS.shield.durationMs, 3_500);
});

test("blast uses circle versus obstacle AABB intersection, including edge contact", () => {
  assert.equal(blastIntersectsPlacement({ x: 100, y: 500, radius: 260 }, placed()), true);
  assert.equal(blastIntersectsPlacement({ x: 100, y: 500, radius: 259.9 }, placed()), false);
  assert.equal(blastIntersectsPlacement({ x: 400, y: 500, radius: 0 }, placed()), true);
  assert.equal(blastIntersectsPlacement({ x: NaN, y: 500, radius: 220 }, placed()), false);
});

test("bomb removes only player-owned placements and preserves order", () => {
  const nearby = placed();
  const far = placed({ id: "placed-b", x: 900 });
  const baseLike = { ...BASE_PLATFORMS[0] };
  const malformed = placed({ id: "", ownerId: "" });
  assert.equal(isPlayerPlacedObstacle(nearby), true);
  assert.equal(isPlayerPlacedObstacle(baseLike), false);

  const result = resolveBombBlast(
    [nearby, baseLike, far, malformed],
    { x: 400, y: 500, radius: ACTIVE_ITEMS.bomb.radius },
  );
  assert.deepEqual(result.removedPlacementIds, ["placed-a"]);
  assert.deepEqual(result.placements, [baseLike, far, malformed]);
});

test("portal blasts remove canonical groups while preserving survivor topology and order", () => {
  const first = portal("portal-1", 300, 300);
  const nearbyCrate = placed({ id: "nearby-crate", x: 240, y: 260 });
  const second = portal("portal-2", 800, 250, 180);
  const third = portal("portal-3", 500, 600);
  const fourth = portal("portal-4", 1_100, 300, 0);
  const solo = portal("portal-5", 900, 600);
  const farCrate = placed({ id: "far-crate", x: 1_400, y: 200 });
  const result = resolveBombBlast(
    [first, nearbyCrate, second, third, fourth, solo, farCrate],
    { ...SPAWN, radius: ACTIVE_ITEMS.bomb.radius },
  );

  assert.deepEqual(
    result.removedPlacementIds,
    ["portal-1", "nearby-crate", "portal-2"],
  );
  assert.deepEqual(result.placements, [third, fourth, solo, farCrate]);
  assert.deepEqual(
    portalLinksForPlacements(result.placements).map(({ source, target, mode, pairIndex }) => ({
      source: source.id,
      target: target?.id || null,
      mode,
      pairIndex,
    })),
    [
      { source: "portal-3", target: "portal-4", mode: "paired", pairIndex: 0 },
      { source: "portal-4", target: "portal-3", mode: "paired", pairIndex: 0 },
      { source: "portal-5", target: null, mode: "solo", pairIndex: 1 },
    ],
  );

  const soloResult = resolveBombBlast(
    result.placements,
    { x: solo.x, y: solo.y, radius: 0 },
  );
  assert.deepEqual(soloResult.removedPlacementIds, ["portal-5"]);
  assert.deepEqual(soloResult.placements, [third, fourth, farCrate]);

  const repeated = resolveBombBlast(
    soloResult.placements,
    { x: solo.x, y: solo.y, radius: 0 },
  );
  assert.deepEqual(repeated.removedPlacementIds, []);
  assert.deepEqual(repeated.placements, soloResult.placements);
});

test("empty blast is a valid no-op", () => {
  const far = placed({ id: "far", x: 1_200, y: 200 });
  const result = resolveBombBlast([far], { ...SPAWN, radius: ACTIVE_ITEMS.bomb.radius });
  assert.deepEqual(result.removedPlacementIds, []);
  assert.equal(result.placements[0], far);
});
