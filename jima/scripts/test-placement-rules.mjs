import assert from "node:assert/strict";
import {
  BASE_PLATFORMS,
  GOAL,
  PIECES,
  PLAYER_COLLISION_BOUNDS,
  SPAWN,
  VIEWPORT,
  WORLD,
} from "../shared/gameConfig.js";
import {
  dimensionsForPiece,
  directionalRangeToBlocker,
  portalExitForLink,
  portalExitPosition,
  portalLinksForPlacements,
  portalModeForPlacement,
  validatePlacementSafety,
} from "../shared/placementRules.js";

assert.equal(WORLD.width, VIEWPORT.width, "the map must remain one fixed camera wide");
assert.equal(WORLD.height, VIEWPORT.height, "the map must remain one fixed camera tall");
assert.equal(BASE_PLATFORMS.length, 3, "the fixed screen should contain exactly three aerial platforms");
assert.equal(
  BASE_PLATFORMS.some((platform) => platform.id === "floor"),
  false,
  "the bottom of the screen must remain a lethal void instead of a solid floor",
);

const aerialRoute = [...BASE_PLATFORMS].sort((left, right) => left.x - right.x);
assert.deepEqual(
  aerialRoute.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
  [
    { id: "start-upper-left", x: 170, y: 196, width: 300, height: 32 },
    { id: "middle-step", x: 760, y: 436, width: 340, height: 32 },
    { id: "final-step", x: 1_440, y: 676, width: 320, height: 32 },
  ],
);
assert.deepEqual(
  aerialRoute.map((platform) => platform.y - platform.height / 2),
  [180, 420, 660],
);

// Match BoltboundScene's normal controls and its one mid-air jump.
const NORMAL_GRAVITY = 1_500;
const NORMAL_ACCELERATION = 1_800;
const NORMAL_SPEED_CAP = 330;
const NORMAL_JUMP_VELOCITY = 640;
const NORMAL_AIR_JUMP_VELOCITY = NORMAL_JUMP_VELOCITY * 0.9;
const landingSurfaces = aerialRoute.slice(1);
const expectedDrops = [240, 240];
const expectedGaps = [270, 350];
const expectedRequiredCenterTravel = [310, 390];
for (let index = 0; index < landingSurfaces.length; index += 1) {
  const previous = aerialRoute[index];
  const next = landingSurfaces[index];
  const previousTop = previous.y - previous.height / 2;
  const nextTop = next.y - next.height / 2;
  const previousRight = previous.x + previous.width / 2;
  const nextLeft = next.x - next.width / 2;
  const drop = nextTop - previousTop;
  const gap = nextLeft - previousRight;
  const requiredCenterTravel =
    nextLeft + PLAYER_COLLISION_BOUNDS.left -
    (previousRight - PLAYER_COLLISION_BOUNDS.right);
  assert.equal(drop, expectedDrops[index], "the descent must preserve its intended vertical spacing");
  assert.equal(gap, expectedGaps[index], "the descent must preserve its intended horizontal spacing");
  assert.equal(requiredCenterTravel, expectedRequiredCenterTravel[index]);

  const singleJumpSeconds = (
    NORMAL_JUMP_VELOCITY +
    Math.sqrt(NORMAL_JUMP_VELOCITY ** 2 + 2 * NORMAL_GRAVITY * drop)
  ) / NORMAL_GRAVITY;
  const singleJumpReach = NORMAL_SPEED_CAP * singleJumpSeconds;
  const apexSeconds = NORMAL_JUMP_VELOCITY / NORMAL_GRAVITY;
  const apexRise = NORMAL_JUMP_VELOCITY ** 2 / (2 * NORMAL_GRAVITY);
  const secondJumpSeconds = (
    NORMAL_AIR_JUMP_VELOCITY +
    Math.sqrt(NORMAL_AIR_JUMP_VELOCITY ** 2 + 2 * NORMAL_GRAVITY * (drop + apexRise))
  ) / NORMAL_GRAVITY;
  const doubleJumpReach = NORMAL_SPEED_CAP * (apexSeconds + secondJumpSeconds);
  if (index === 0) {
    assert.ok(requiredCenterTravel <= singleJumpReach, "the first gap must clear with one normal jump");
  } else {
    assert.ok(requiredCenterTravel > singleJumpReach, "the second gap should ask for the visible double jump");
    assert.ok(requiredCenterTravel <= doubleJumpReach, "the second gap must leave generous double-jump margin");
  }

  assert.ok(
    previous.width - PLAYER_COLLISION_BOUNDS.left - PLAYER_COLLISION_BOUNDS.right >
      (NORMAL_SPEED_CAP ** 2) / (2 * NORMAL_ACCELERATION),
    "each aerial platform must provide enough runway to reach normal speed",
  );
}
assert.ok(
  aerialRoute.every((platform) => platform.y + platform.height / 2 < WORLD.groundY),
  "every base platform must leave open void beneath it",
);
assert.ok(
  aerialRoute.every((platform) => platform.width < WORLD.width),
  "no base platform may recreate a continuous full-screen floor",
);

const finalPlatform = aerialRoute.at(-1);
const finalLeft = finalPlatform.x - finalPlatform.width / 2;
const finalRight = finalPlatform.x + finalPlatform.width / 2;
const finalTop = finalPlatform.y - finalPlatform.height / 2;
assert.equal(GOAL.y + GOAL.height / 2, finalTop, "the goal must rest on the final platform");
assert.ok(GOAL.x - GOAL.width / 2 >= finalLeft);
assert.ok(GOAL.x + GOAL.width / 2 <= finalRight);
const startPlatform = aerialRoute[0];
for (let index = 0; index < 4; index += 1) {
  const playerX = SPAWN.x + index * 44;
  const playerY = SPAWN.y - index * 8;
  assert.ok(playerX - PLAYER_COLLISION_BOUNDS.left >= startPlatform.x - startPlatform.width / 2);
  assert.ok(playerX + PLAYER_COLLISION_BOUNDS.right <= startPlatform.x + startPlatform.width / 2);
  assert.ok(playerY + PLAYER_COLLISION_BOUNDS.bottom <= startPlatform.y - startPlatform.height / 2);
  assert.equal(
    validatePlacementSafety({ type: "crate", x: playerX, y: playerY, rotation: 0 }, [], []),
    "reserved_zone",
    "all four initial player collision boxes must remain protected",
  );
}
assert.equal(WORLD.grid, 20, "fine snapping must support every platform top and piece height");

const goalColumnHigh = {
  type: "spikes",
  x: GOAL.x - 30,
  y: 200,
  rotation: 0,
};
assert.equal(validatePlacementSafety(goalColumnHigh, [], []), "reserved_zone");

const normalBuildArea = {
  type: "beam",
  x: 800,
  y: 250,
  rotation: 0,
};
assert.equal(validatePlacementSafety(normalBuildArea, [], []), null);

const visuallyEmptyWestSky = {
  type: "fan",
  x: 220,
  y: 260,
  rotation: 90,
};
assert.equal(
  validatePlacementSafety(visuallyEmptyWestSky, [], []),
  null,
  "empty sky below the spawn platform must not be reserved as a full-height column",
);
const visiblePracticeBlockers = [0, 1].map((index) => ({
  x: SPAWN.x + index * 44,
  y: SPAWN.y - index * 8,
  width: 72,
  height: 104,
}));
assert.equal(
  validatePlacementSafety(visuallyEmptyWestSky, [], visiblePracticeBlockers),
  null,
  "visible-size human and bot blockers must not recreate the screenshot false positive",
);
assert.equal(
  validatePlacementSafety({ type: "fan", x: 120, y: 160, rotation: 90 }, [], visiblePracticeBlockers),
  "reserved_zone",
  "a piece directly covering a visible player remains forbidden",
);
assert.equal(
  validatePlacementSafety(visuallyEmptyWestSky, [], [{
    x: 400,
    y: 260,
    width: PLAYER_COLLISION_BOUNDS.left + PLAYER_COLLISION_BOUNDS.right,
    height: PLAYER_COLLISION_BOUNDS.top + PLAYER_COLLISION_BOUNDS.bottom,
  }]),
  "reserved_zone",
  "the same fan must still reject a visible player inside its effect range",
);

const previousRoundCorpse = {
  playerId: "dead-player",
  x: 800,
  y: 300,
  width: 72,
  height: 104,
  blocksPlacement: false,
};
const liveBuildPlayer = {
  ...previousRoundCorpse,
  playerId: "live-player",
  blocksPlacement: true,
};
const placementOverPreviousCorpse = { type: "crate", x: 800, y: 300, rotation: 0 };
assert.equal(
  validatePlacementSafety(placementOverPreviousCorpse, [], [previousRoundCorpse]),
  null,
  "a previous-round corpse must not reserve otherwise empty build space",
);
assert.equal(
  validatePlacementSafety(placementOverPreviousCorpse, [], [liveBuildPlayer]),
  "reserved_zone",
  "a live visible player must remain protected during building",
);
assert.equal(
  validatePlacementSafety(
    placementOverPreviousCorpse,
    [{ id: "real-device", type: "bumper", x: 800, y: 300, rotation: 0 }],
    [previousRoundCorpse],
  ),
  "piece_overlap",
  "ignoring a corpse must not allow overlap with a real placed device",
);

const blackholeNearVisiblePlayer = {
  type: "blackhole",
  x: 800,
  y: 300,
  rotation: 0,
};
assert.equal(
  validatePlacementSafety(blackholeNearVisiblePlayer, [], [{
    x: 800,
    y: 430,
    width: 72,
    height: 104,
  }]),
  null,
  "a black hole attraction radius may cover a player when its solid body does not",
);

const center = { type: "portal", x: 800, y: 400, rotation: 0 };
const directionCases = [
  { rotation: 0, x: 800, y: 400 - PIECES.portal.soloDistance, dx: 0, dy: -1 },
  { rotation: 90, x: 800 + PIECES.portal.soloDistance, y: 400, dx: 1, dy: 0 },
  { rotation: 180, x: 800, y: 400 + PIECES.portal.soloDistance, dx: 0, dy: 1 },
  { rotation: 270, x: 800 - PIECES.portal.soloDistance, y: 400, dx: -1, dy: 0 },
];
for (const expected of directionCases) {
  const exit = portalExitPosition({ ...center, rotation: expected.rotation }, "solo");
  assert.equal(exit.clamped, false);
  assert.deepEqual(exit.requestedDirection, exit.direction);
  assert.deepEqual(
    { x: exit.x, y: exit.y, dx: exit.direction.x, dy: exit.direction.y },
    { x: expected.x, y: expected.y, dx: expected.dx, dy: expected.dy },
  );
}

const edgeCases = [
  {
    portal: { ...center, y: 160, rotation: 0 },
    position: { x: 800, y: PLAYER_COLLISION_BOUNDS.top },
    exact: { x: 800, y: 160 - PIECES.portal.soloDistance },
    requested: { x: 0, y: -1 },
    launch: { x: 0, y: 1 },
  },
  {
    portal: { ...center, y: 700, rotation: 180 },
    position: { x: 800, y: WORLD.groundY - PLAYER_COLLISION_BOUNDS.bottom },
    exact: { x: 800, y: 700 + PIECES.portal.soloDistance },
    requested: { x: 0, y: 1 },
    launch: { x: 0, y: -1 },
  },
  {
    portal: { ...center, x: 1_500, rotation: 90 },
    position: { x: WORLD.width - PLAYER_COLLISION_BOUNDS.right, y: 400 },
    exact: { x: 1_500 + PIECES.portal.soloDistance, y: 400 },
    requested: { x: 1, y: 0 },
    launch: { x: -1, y: 0 },
  },
  {
    portal: { ...center, x: 100, rotation: 270 },
    position: { x: PLAYER_COLLISION_BOUNDS.left, y: 400 },
    exact: { x: 100 - PIECES.portal.soloDistance, y: 400 },
    requested: { x: -1, y: 0 },
    launch: { x: 1, y: 0 },
  },
];
for (const expected of edgeCases) {
  const exit = portalExitPosition(expected.portal, "solo");
  assert.equal(exit.clamped, true);
  assert.deepEqual({ x: exit.x, y: exit.y }, expected.position);
  assert.deepEqual(exit.exact, expected.exact);
  assert.deepEqual(exit.requestedDirection, expected.requested);
  assert.deepEqual(exit.direction, expected.launch);
  assert.equal(validatePlacementSafety(expected.portal, [], []), "out_of_bounds");
}

const pairedEdgePortal = { type: "portal", x: 1_520, y: 400, rotation: 90 };
const pairedEdgeExit = portalExitPosition(pairedEdgePortal, "paired");
assert.equal(pairedEdgeExit.clamped, true);
assert.deepEqual(pairedEdgeExit.exact, { x: 1_520 + PIECES.portal.exitOffset, y: 400 });
assert.deepEqual(pairedEdgeExit.direction, { x: -1, y: 0 });
assert.equal(
  validatePlacementSafety(pairedEdgePortal, [
    { type: "portal", x: 800, y: 400, rotation: 0 },
  ], []),
  "out_of_bounds",
);

const soloPortal = { type: "portal", x: 600, y: 200, rotation: 90 };
const soloLinks = portalLinksForPlacements([soloPortal]);
assert.equal(soloLinks.length, 1);
assert.equal(soloLinks[0].mode, "solo");
assert.equal(soloLinks[0].source, soloPortal);
assert.equal(soloLinks[0].target, null);
assert.equal(portalExitForLink(soloLinks[0]).x, soloPortal.x + PIECES.portal.soloDistance);

const pairedPortal = { type: "portal", x: 1_100, y: 400, rotation: 270 };
const pairedLinks = portalLinksForPlacements([soloPortal, pairedPortal]);
assert.equal(pairedLinks.length, 2);
assert.equal(pairedLinks[0].target, pairedPortal);
assert.equal(pairedLinks[1].target, soloPortal);
assert.equal(portalExitForLink(pairedLinks[0]).x, pairedPortal.x - PIECES.portal.exitOffset);

const oddTail = { type: "portal", x: 800, y: 240, rotation: 180 };
const oddLinks = portalLinksForPlacements([soloPortal, pairedPortal, oddTail]);
assert.equal(oddLinks.length, 3);
assert.equal(portalModeForPlacement(oddTail, [soloPortal, pairedPortal, oddTail]), "solo");
assert.equal(oddLinks[2].source, oddTail);
assert.equal(oddLinks[2].target, null);
assert.equal(portalExitForLink(oddLinks[2]).y, oddTail.y + PIECES.portal.soloDistance);

assert.equal(validatePlacementSafety(soloPortal, [], []), null);
assert.equal(
  validatePlacementSafety(soloPortal, [
    { type: "crate", x: soloPortal.x + PIECES.portal.soloDistance, y: soloPortal.y, rotation: 0 },
  ], []),
  "piece_overlap",
);
assert.equal(
  validatePlacementSafety(soloPortal, [], [{
    x: soloPortal.x + PIECES.portal.soloDistance,
    y: soloPortal.y,
    width: PLAYER_COLLISION_BOUNDS.left + PLAYER_COLLISION_BOUNDS.right,
    height: PLAYER_COLLISION_BOUNDS.top + PLAYER_COLLISION_BOUNDS.bottom,
  }]),
  "reserved_zone",
);
assert.equal(
  validatePlacementSafety({ type: "portal", x: 1_100, y: 400, rotation: 90 }, [], []),
  "reserved_zone",
);
assert.equal(
  validatePlacementSafety({ type: "portal", x: 1_200, y: 580, rotation: 90 }, [], []),
  "reserved_zone",
  "a portal exit inside the finish column remains forbidden",
);

const transitionsFromSolo = { type: "portal", x: 600, y: 260, rotation: 90 };
const newlyBlockedPairedExit = { type: "crate", x: 720, y: 260, rotation: 0 };
assert.equal(validatePlacementSafety(transitionsFromSolo, [newlyBlockedPairedExit], []), null);
assert.equal(
  validatePlacementSafety(
    { type: "portal", x: 1_000, y: 400, rotation: 90 },
    [transitionsFromSolo, newlyBlockedPairedExit],
    [],
  ),
  "piece_overlap",
  "pairing a solo portal must revalidate its shorter exit against existing pieces",
);

const clippedRange = directionalRangeToBlocker(
  1_100,
  700,
  { x: 1, y: 0 },
  PIECES.laser.range,
  PIECES.laser.beamWidth / 2,
  PIECES.laser.muzzleOffset,
);
assert.equal(clippedRange, 180, "the short final platform should stop the beam at x=1280");
assert.ok(
  clippedRange < PIECES.laser.range / 2,
  "a horizontal laser must not seal the entire aerial route across the screen",
);
const laserBehindBaseBlocker = { type: "laser", x: 1_100, y: 700, rotation: 90 };
assert.equal(
  validatePlacementSafety(laserBehindBaseBlocker, [], [
    { x: 1_400, y: 700, width: 128, height: 160 },
  ]),
  null,
  "a player behind a solid base platform must not invalidate the laser",
);
assert.equal(
  validatePlacementSafety(laserBehindBaseBlocker, [], [
    { x: 1_200, y: 700, width: 40, height: 80 },
  ]),
  "reserved_zone",
  "a visible player before the first blocker remains protected",
);
assert.equal(
  validatePlacementSafety({ type: "cannon", x: 1_100, y: 700, rotation: 90 }, [], []),
  null,
  "cannon and laser corridors share the same real occlusion",
);

// 搭建零件旋转后仍可贴边叠放、拼接，且不受放置先后顺序影响；
// 实体发生实际穿入时，必须拒绝放置。
function assertPlacementPair(first, second, expected, message) {
  assert.equal(validatePlacementSafety(second, [first]), expected, message);
  assert.equal(validatePlacementSafety(first, [second]), expected, `${message}（反向放置顺序）`);
}

for (const firstType of ["beam", "crate", "ice"]) {
  for (const secondType of ["beam", "crate", "ice"]) {
    for (const firstRotation of [0, 90, 180, 270]) {
      for (const secondRotation of [0, 90, 180, 270]) {
        const first = { type: firstType, x: 480, y: 600, rotation: firstRotation };
        const second = { type: secondType, x: 480, y: 600, rotation: secondRotation };
        const firstSize = dimensionsForPiece(firstType, firstRotation);
        const secondSize = dimensionsForPiece(secondType, secondRotation);
        for (const [axis, edgeOffset] of [
          ["y", -(firstSize.height + secondSize.height) / 2],
          ["x", (firstSize.width + secondSize.width) / 2],
        ]) {
          const touching = { ...second, [axis]: first[axis] + edgeOffset };
          const label = `${firstType}@${firstRotation} / ${secondType}@${secondRotation} 沿 ${axis} 轴`;
          assertPlacementPair(first, touching, null, `${label}：边缘相接时允许放置`);
          assertPlacementPair(first, { ...touching, [axis]: touching[axis] - Math.sign(edgeOffset) },
            "piece_overlap", `${label}：即使仅穿入 1 像素也应拒绝放置`);
        }
      }
    }
  }
}

const horizontalBarrier = { type: "barrier", x: 480, y: 600, rotation: 0 };
const verticalBarrier = { type: "barrier", x: 480, y: 560, rotation: 90 };
for (const type of ["beam", "crate", "barrier", "ice"]) {
  assertPlacementPair(horizontalBarrier, { type, x: 480, y: 580 - PIECES[type].height / 2, rotation: 0 },
    null, `${type} 可以贴在横向路障运动轨迹的上方`);
  assertPlacementPair(verticalBarrier, { type, x: 500 + PIECES[type].height / 2, y: 560, rotation: 90 },
    null, `${type} 可以贴在纵向路障运动轨迹的侧边`);
}
assertPlacementPair(horizontalBarrier, { type: "crate", x: 600, y: 600, rotation: 0 },
  null, "路障的独立图层允许其横向穿过方箱");
assertPlacementPair(verticalBarrier, { type: "crate", x: 480, y: 440, rotation: 0 },
  null, "路障的独立图层允许其纵向穿过方箱");
assertPlacementPair(horizontalBarrier, { type: "crate", x: 580, y: 600, rotation: 0 },
  "piece_overlap", "路障的初始实体仍不能与其他零件重叠");
assertPlacementPair(horizontalBarrier, { type: "spikes", x: 660, y: 600, rotation: 0 },
  null, "路障的运动轨迹也可以穿过其他类别的零件");
assert.equal(validatePlacementSafety(horizontalBarrier, [], [{ x: 650, y: 600, width: 40, height: 67 }]),
  "reserved_zone", "路障的完整运动轨迹仍须避开当前可见人物");
assert.equal(validatePlacementSafety({ type: "barrier", x: 1100, y: 600, rotation: 0 }),
  "reserved_zone", "路障的完整运动轨迹不能进入终点保护区");
assert.equal(validatePlacementSafety({ type: "barrier", x: 480, y: 720, rotation: 90 }),
  "out_of_bounds", "路障的完整运动轨迹不能超出地图边界");
assertPlacementPair(horizontalBarrier, { type: "crate", x: 720, y: 600, rotation: 0 },
  null, "方箱可以与路障完整运动轨迹的外缘相接");
assertPlacementPair({ type: "beam", x: 480, y: 600, rotation: 0 },
  { type: "spikes", x: 480, y: 560, rotation: 0 },
  "piece_overlap", "搭建类叠放规则保留其他类别零件的间隔要求");
assert.equal(validatePlacementSafety({ type: "crate", x: 480, y: 260, rotation: 0 },
  [{ type: "beam", x: 480, y: 320, rotation: 0 }],
  [{ x: 480, y: 260, width: 40, height: 67 }]), "reserved_zone",
  "叠放不能绕过对当前可见人物的保护");

console.log("放置规则验证通过：坠落死亡、三平台下降路线、局部保护、遮挡与搭建叠放");
