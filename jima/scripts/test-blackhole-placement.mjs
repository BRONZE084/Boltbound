import assert from "node:assert/strict";

import { BASE_PLATFORMS } from "../shared/gameConfig.js";
import { validatePlacementSafety } from "../shared/placementRules.js";

const effectOnlyPlayer = { type: "blackhole", x: 800, y: 300, rotation: 0 };
assert.equal(
  validatePlacementSafety(effectOnlyPlayer, [], [{ x: 800, y: 430, width: 72, height: 104 }]),
  null,
  "the attraction radius may cover a visible player",
);
assert.equal(
  validatePlacementSafety(effectOnlyPlayer, [], [{ x: 800, y: 300, width: 72, height: 104 }]),
  "reserved_zone",
  "the solid body may not cover a visible player",
);

assert.equal(
  validatePlacementSafety({ type: "blackhole", x: 430, y: 200, rotation: 0 }, [], []),
  null,
  "the attraction radius may reach the local spawn envelope",
);
assert.equal(
  validatePlacementSafety({ type: "blackhole", x: 280, y: 100, rotation: 0 }, [], []),
  null,
  "出生区空位允许放置，实际人物和固定平台仍单独检查",
);
assert.equal(
  validatePlacementSafety({ type: "blackhole", x: 1_100, y: 300, rotation: 0 }, [], []),
  null,
  "the attraction radius may reach the finish protection column",
);
assert.equal(
  validatePlacementSafety({ type: "blackhole", x: 1_240, y: 300, rotation: 0 }, [], []),
  null,
  "终点区域的空位允许放置",
);

const middlePlatform = BASE_PLATFORMS.find((platform) => platform.id === "middle-step");
assert.ok(middlePlatform);
assert.equal(
  validatePlacementSafety({
    type: "blackhole",
    x: middlePlatform.x,
    y: middlePlatform.y,
    rotation: 0,
  }, [], []),
  "piece_overlap",
  "the solid body may not cover a fixed platform",
);
assert.equal(
  validatePlacementSafety(effectOnlyPlayer, [
    { id: "far-crate", type: "crate", x: 940, y: 300, rotation: 0 },
  ], []),
  null,
  "the attraction radius may cover another placed piece",
);
assert.equal(
  validatePlacementSafety(effectOnlyPlayer, [
    { id: "body-crate", type: "crate", x: 800, y: 300, rotation: 0 },
  ], []),
  "piece_overlap",
  "the solid body may not cover another placed piece",
);
assert.equal(
  validatePlacementSafety({ type: "blackhole", x: 180, y: 300, rotation: 0 }, [], []),
  null,
  "吸引范围超出画面不影响放置",
);

console.log("black hole placement: effect range and solid-body safety verified");
