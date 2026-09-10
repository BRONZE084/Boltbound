import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_ITEMS, PIECES, DEBUFF_IMMUNITY_MS } from "../../shared/gameConfig.js";
import { CATALOG } from "./catalog.js";
import { LabSession, PLAYER_ID, PARTNER_ID } from "./LabSession.js";

const piece = (type = "beam", x = 480, y = 320, rotation = 0) => ({ type, x, y, rotation });

test("catalog covers every original piece and item with original configuration objects", () => {
  const source = { ...PIECES, ...ACTIVE_ITEMS };
  assert.deepEqual(CATALOG.map((entry) => entry.type).sort(), Object.keys(source).sort());
  for (const entry of CATALOG) assert.equal(entry.config, source[entry.type]);
});

test("invalid placements never change the plan or undo history", () => {
  const lab = new LabSession();
  assert.ok(lab.place(piece()).placement);
  const before = lab.exportPlan();
  assert.equal(lab.place(piece()).error, "piece_overlap");
  assert.equal(lab.place(piece("beam", 1400, 320)).error, "reserved_zone");
  assert.equal(lab.place(piece("beam", 481, 320)).error, "invalid_position");
  assert.equal(lab.place(piece("turbo")).error, "invalid_piece");
  assert.deepEqual(lab.exportPlan(), before);
  assert.equal(lab.undoStack.length, 1);
});

test("delete, custom spawn, clear, undo and redo preserve a recoverable blueprint", () => {
  const lab = new LabSession();
  const placed = lab.place(piece("crate")).placement;
  lab.setSpawn({ x: 500, y: 200 });
  const saved = lab.exportPlan();
  lab.remove(placed.id);
  assert.equal(lab.blueprint.length, 0);
  lab.history("undo");
  assert.deepEqual(lab.exportPlan(), saved);
  lab.clear();
  lab.history("undo");
  assert.deepEqual(lab.exportPlan(), saved);
  lab.history("redo");
  assert.equal(lab.blueprint.length, 0);
  lab.place(piece());
  assert.equal(lab.history("redo"), false);
});

test("bomb damage is temporary, obeys real portal pairing, and cannot destroy the blueprint", () => {
  const lab = new LabSession();
  assert.ok(lab.place(piece("portal", 480, 320)).placement);
  assert.ok(lab.place(piece("portal", 1000, 320)).placement);
  const blueprint = lab.exportPlan();
  lab.enterMode("test", 1000);
  assert.equal(lab.place(piece()).error, "invalid_phase");
  const blast = lab.useItem("bomb", { position: { x: 480, y: 320 }, now: 1100 }).blast;
  assert.equal(blast.removedPlacementIds.length, 2);
  assert.equal(lab.state.placements.length, 0);
  assert.deepEqual(lab.exportPlan(), blueprint);
  lab.enterMode("build");
  assert.equal(lab.state.placements.length, 2);
});

test("all original active items apply to the correct actor using original durations", () => {
  for (const [type, config] of Object.entries(ACTIVE_ITEMS)) {
    const lab = new LabSession();
    lab.enterMode("test", 1000);
    const result = lab.useItem(type, { now: 1100 });
    assert.equal(result.error, undefined, type);
    if (type === "bomb") { assert.equal(result.blast.radius, config.radius); continue; }
    assert.equal(result.effect.targetPlayerId, PLAYER_ID);
    assert.equal(result.effect.sourcePlayerId, config.kind === "target_debuff" ? PARTNER_ID : PLAYER_ID);
    assert.equal(result.effect.endsAt - result.effect.startedAt, config.durationMs);
    if (config.kind === "target_debuff") {
      lab.clearEffects();
      assert.equal(lab.useItem(type, { received: false, now: 1200 }).targetId, PARTNER_ID);
    }
  }
});

test("deleting paired portals cannot leave an unimportable blocked solo exit", () => {
  const lab = new LabSession();
  lab.place(piece("portal", 480, 600));
  const second = lab.place(piece("portal", 1000, 320)).placement;
  lab.place(piece("beam", 480, 320));
  const before = lab.exportPlan();
  lab.remove(second.id);
  assert.equal(lab.blueprint.length, 1);
  const imported = new LabSession();
  imported.importPlan(lab.exportPlan());
  assert.deepEqual(imported.exportPlan(), lab.exportPlan());
  lab.history("undo");
  assert.deepEqual(lab.exportPlan(), before);
});

test("shield cleanses and blocks debuffs; debuffs respect expiry and immunity", () => {
  const lab = new LabSession();
  lab.enterMode("test", 1000);
  assert.ok(lab.useItem("slow", { now: 1100 }).effect);
  assert.ok(lab.useItem("shield", { now: 1200 }).effect);
  assert.equal(lab.state.race.effects[PLAYER_ID].debuff, null);
  assert.match(lab.useItem("reverse", { now: 2200 }).error, /护盾/);
  lab.clearEffects();
  const applied = lab.useItem("slow", { now: 5000 }).effect;
  assert.match(lab.useItem("gravity", { now: 6000 }).error, /已有负面效果/);
  assert.match(lab.useItem("gravity", { now: applied.endsAt + 1 }).error, /短暂无敌/);
  assert.ok(lab.useItem("gravity", { now: applied.endsAt + DEBUFF_IMMUNITY_MS + 1 }).effect);
});

test("cooldowns persist across item switching, while resetting restores unlimited supplies", () => {
  const lab = new LabSession();
  lab.enterMode("test", 1000);
  lab.useItem("turbo", { now: 1100 });
  assert.match(lab.useItem("jumpjet", { now: 1150 }).error, /冷却/);
  assert.match(lab.useItem("turbo", { now: 2100 }).error, /同类效果/);
  lab.clearEffects();
  assert.ok(lab.useItem("turbo", { now: 2100 }).effect);
  lab.state.players[0].status = "dead";
  assert.match(lab.useItem("bomb", { now: 4000 }).error, /死亡/);
  lab.enterMode("test", 5000);
  assert.ok(lab.useItem("turbo", { now: 5100 }).effect);
});

test("JSON round-trips source types, rotation and spawn; malformed imports are atomic", () => {
  const lab = new LabSession();
  lab.place(piece("beam", 480, 320, 90));
  lab.setSpawn({ x: 480, y: 210 });
  const plan = JSON.parse(JSON.stringify(lab.exportPlan()));
  const second = new LabSession();
  second.importPlan(plan);
  assert.deepEqual(second.exportPlan(), plan);
  for (const bad of [
    { ...plan, version: 100 },
    { ...plan, spawn: { x: "480", y: 210 } },
    { ...plan, placements: [...plan.placements, piece("invented")] },
    { ...plan, placements: [...plan.placements, piece("constructor")] },
    { ...plan, placements: [piece("beam", 1400, 320)] },
  ]) {
    const historySize = second.undoStack.length;
    assert.throws(() => second.importPlan(bad));
    assert.deepEqual(second.exportPlan(), plan);
    assert.equal(second.undoStack.length, historySize);
  }
});
