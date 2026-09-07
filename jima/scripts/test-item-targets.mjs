import assert from "node:assert/strict";
import {
  buildItemTargetOptions,
  isTargetSelectionError,
} from "../shared/itemTargets.js";

const NOW = 10_000;

function player(id, status = "racing", extras = {}) {
  return { id, name: `Player ${id}`, status, connected: true, ...extras };
}

const visibleTargets = buildItemTargetOptions({
  selfPlayerId: "self",
  players: [
    player("self"),
    player("alpha"),
    { status: "racing" },
    player("bravo"),
    player("charlie"),
    player("delta"),
    player("echo"),
  ],
  now: NOW,
});
assert.deepEqual(
  visibleTargets.map(({ playerId, shortcut }) => ({ playerId, shortcut })),
  [
    { playerId: "alpha", shortcut: "1" },
    { playerId: "bravo", shortcut: "2" },
    { playerId: "charlie", shortcut: "3" },
    { playerId: "delta", shortcut: "4" },
    { playerId: "echo", shortcut: null },
  ],
  "shortcuts must be assigned to visible targets, not raw player-array positions",
);

const selfInMiddle = buildItemTargetOptions({
  selfPlayerId: "self",
  players: [player("alpha"), player("self"), player("bravo")],
  now: NOW,
});
assert.deepEqual(
  selfInMiddle.map(({ playerId, shortcut }) => ({ playerId, shortcut })),
  [
    { playerId: "alpha", shortcut: "1" },
    { playerId: "bravo", shortcut: "2" },
  ],
  "removing self in the middle must not leave a shortcut gap",
);

const stateOptions = buildItemTargetOptions({
  selfPlayerId: "self",
  players: [
    player("available", "racing", { styleIndex: 3 }),
    player("finished", "finished"),
    player("dead", "death"),
    player("offline", "racing", { connected: false }),
    player("waiting", "ready"),
    player("shielded"),
    player("debuffed"),
    player("immune"),
  ],
  effects: {
    shielded: { self: { type: "shield", endsAt: NOW + 800 } },
    debuffed: { debuff: { type: "heavy", endsAt: NOW + 700 } },
    immune: { debuff: { type: "heavy", endsAt: NOW - 1_000 } },
  },
  now: NOW,
});
const byId = Object.fromEntries(stateOptions.map((option) => [option.playerId, option]));
assert.deepEqual(
  Object.fromEntries(stateOptions.map(({ playerId, reasonCode }) => [playerId, reasonCode])),
  {
    available: "available",
    finished: "finished",
    dead: "dead",
    offline: "disconnected",
    waiting: "not_racing",
    shielded: "shielded",
    debuffed: "debuff_active",
    immune: "immune",
  },
);
assert.equal(byId.available.selectable, true);
assert.equal(byId.available.styleIndex, 3);
assert.equal(byId.finished.reasonLabel, "已到终点");
assert.equal(byId.dead.reasonLabel, "已出局");
assert.equal(byId.offline.reasonLabel, "已离线");
assert.equal(byId.waiting.reasonLabel, "尚未起跑");
assert.equal(byId.shielded.reasonLabel, "护盾生效中");
assert.equal(byId.shielded.remainingMs, 800);
assert.equal(byId.debuffed.reasonLabel, "已有负面效果");
assert.equal(byId.debuffed.remainingMs, 700);
assert.equal(byId.immune.reasonLabel, "短暂无敌 1s");
assert.equal(byId.immune.remainingMs, 500);
for (const option of stateOptions.filter(({ playerId }) => playerId !== "available")) {
  assert.equal(option.selectable, false, `${option.playerId} must not be selectable`);
}

const overridden = buildItemTargetOptions({
  players: [player("available"), player("finished", "finished"), player("unknown")],
  reasonOverrides: {
    available: "target_shielded",
    finished: "target_unavailable",
    unknown: "not_a_target_error",
  },
  now: NOW,
});
assert.deepEqual(
  overridden.map(({ playerId, reasonCode, selectable }) => ({ playerId, reasonCode, selectable })),
  [
    { playerId: "available", reasonCode: "shielded", selectable: false },
    { playerId: "finished", reasonCode: "finished", selectable: false },
    { playerId: "unknown", reasonCode: "available", selectable: true },
  ],
  "server rejection overrides must disable an available target without hiding a more specific state",
);

for (const code of [
  "target_unavailable",
  "target_shielded",
  "target_debuff_active",
  "target_immune",
]) {
  assert.equal(isTargetSelectionError(code), true, `${code} must be recognized`);
}
assert.equal(isTargetSelectionError("not_a_target_error"), false);
assert.equal(isTargetSelectionError(), false);

console.log("item targets: visible shortcuts, eligibility reasons, timers, and server overrides verified");
