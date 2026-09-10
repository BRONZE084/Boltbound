import { ACTIVE_ITEMS, DEBUFF_IMMUNITY_MS, PIECES, PLAYER_COLLISION_BOUNDS, SPAWN, WORLD } from "../../shared/gameConfig.js";
import { dimensionsForPiece, normalizedRotation, portalLinksForPlacements, validatePlacementSafety } from "../../shared/placementRules.js";
import { buildItemTargetOptions } from "../../shared/itemTargets.js";
import { resolveBombBlast } from "../../server/bombLogic.js";

export const PLAYER_ID = "lab-player";
export const PARTNER_ID = "lab-partner";
export const PLACEMENT_ERRORS = {
  out_of_bounds: "零件或完整作用范围超出搭建边界。试试旋转或向场地中心移动。",
  reserved_zone: "出生区、终点保护区或角色附近需要留出空间。",
  piece_overlap: "零件、作用区域或传送出口与现有物体冲突。",
  invalid_piece: "请选择源码中已有的搭建零件。",
  invalid_position: "坐标必须位于搭建范围内，并吸附到 20 像素网格。",
  invalid_phase: "请先返回搭建模式。",
  placement_limit: "单个实验方案最多放置 300 件零件。请导出保存或删除部分零件。",
};

const clone = (value) => structuredClone(value);

export class LabSession {
  constructor() {
    this.blueprint = [];
    this.spawn = { ...SPAWN };
    this.undoStack = [];
    this.redoStack = [];
    this.sequence = 0;
    this.selectedPiece = "beam";
    this.state = {
      phase: "build", round: 1, mapRevision: 0, placements: [],
      players: [
        { id: PLAYER_ID, name: "实验员", styleIndex: 0, connected: true, status: "racing", score: 0 },
        { id: PARTNER_ID, name: "陪练", styleIndex: 1, connected: true, status: "racing", score: 0 },
      ],
      build: { pieces: { [PLAYER_ID]: "beam" }, decisions: {}, blockers: [] },
      race: { effects: {}, itemCooldowns: {}, countdownAt: Date.now() },
    };
    this.updateBlockers();
  }

  updateBlockers() {
    const bounds = PLAYER_COLLISION_BOUNDS;
    this.state.build.blockers = [
      { playerId: PLAYER_ID, ...this.spawn, width: bounds.left + bounds.right, height: bounds.top + bounds.bottom },
      { playerId: PARTNER_ID, x: SPAWN.x + 44, y: SPAWN.y - 8, width: bounds.left + bounds.right, height: bounds.top + bounds.bottom },
    ];
  }

  snapshot() { return clone({ blueprint: this.blueprint, spawn: this.spawn }); }

  remember() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  syncBlueprint() {
    this.state.placements = clone(this.blueprint);
    this.state.mapRevision += 1;
    this.updateBlockers();
  }

  selectPiece(type) {
    this.selectedPiece = Object.hasOwn(PIECES, type) ? type : null;
    this.state.build.pieces[PLAYER_ID] = this.selectedPiece;
  }

  normalizePlacement(input) {
    if (!Object.hasOwn(PIECES, input?.type)) return { error: "invalid_piece" };
    const rotation = normalizedRotation(input.rotation ?? 0);
    const { x, y } = input;
    if (rotation === null || !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 80 || x > WORLD.width - 80 || y < 160 || y > WORLD.groundY - 40 ||
      x % WORLD.grid !== 0 || y % WORLD.grid !== 0) return { error: "invalid_position" };
    return { placement: { type: input.type, x, y, rotation, ...dimensionsForPiece(input.type, rotation) } };
  }

  place(input) {
    if (this.state.phase !== "build") return { error: "invalid_phase" };
    if (this.blueprint.length >= 300) return { error: "placement_limit" };
    const normalized = this.normalizePlacement(input);
    if (normalized.error) return normalized;
    const error = validatePlacementSafety(normalized.placement, this.blueprint, this.state.build.blockers);
    if (error) return { error };
    this.remember();
    const placement = { ...normalized.placement, id: `lab-${++this.sequence}`, ownerId: PLAYER_ID, round: 1 };
    this.blueprint.push(placement);
    this.syncBlueprint();
    return { placement };
  }

  remove(id) {
    if (this.state.phase !== "build" || !this.blueprint.some((piece) => piece.id === id)) return false;
    const ids = new Set([id]);
    const portalLink = portalLinksForPlacements(this.blueprint).find((link) => link.source.id === id);
    if (portalLink?.target) ids.add(portalLink.target.id);
    this.remember();
    this.blueprint = this.blueprint.filter((piece) => !ids.has(piece.id));
    this.syncBlueprint();
    return true;
  }

  setSpawn(point) {
    if (this.state.phase !== "build" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    this.remember();
    this.spawn = { x: Math.max(24, Math.min(WORLD.width - 24, point.x)), y: Math.max(40, Math.min(WORLD.height - 50, point.y)) };
    this.updateBlockers();
    return true;
  }

  clear() {
    if (this.state.phase !== "build") return false;
    this.remember();
    this.blueprint = [];
    this.spawn = { ...SPAWN };
    this.syncBlueprint();
    return true;
  }

  history(direction) {
    if (this.state.phase !== "build") return false;
    const source = direction === "undo" ? this.undoStack : this.redoStack;
    const destination = direction === "undo" ? this.redoStack : this.undoStack;
    if (!source.length) return false;
    destination.push(this.snapshot());
    const previous = source.pop();
    this.blueprint = previous.blueprint;
    this.spawn = previous.spawn;
    this.syncBlueprint();
    return true;
  }

  enterMode(mode, now = Date.now()) {
    this.state = {
      ...this.state, phase: mode === "test" ? "race" : "build",
      players: this.state.players.map((player) => ({ ...player, status: "racing" })),
      race: { effects: {}, itemCooldowns: {}, countdownAt: now, mapRevision: this.state.mapRevision + 1 },
    };
    this.syncBlueprint();
  }

  clearEffects() {
    this.state.race.effects = {};
    this.state.race.itemCooldowns = {};
  }

  useItem(type, { received = true, position = this.spawn, now = Date.now() } = {}) {
    const config = Object.hasOwn(ACTIVE_ITEMS, type) ? ACTIVE_ITEMS[type] : null;
    if (!config || this.state.phase !== "race") return { error: "请先进入试用模式。" };
    if (this.state.players.find((player) => player.id === PLAYER_ID).status !== "racing") {
      return { error: "角色已死亡，请先复位角色。" };
    }
    const targeted = config.kind === "target_debuff";
    const sourceId = targeted && received ? PARTNER_ID : PLAYER_ID;
    const targetId = targeted && !received ? PARTNER_ID : PLAYER_ID;
    if ((this.state.race.itemCooldowns[sourceId] || 0) > now) return { error: "道具冷却中，请稍候。" };
    const effects = this.state.race.effects[targetId] ||= { self: null, debuff: null, immunityUntil: 0 };
    if (targeted) {
      const target = buildItemTargetOptions({ players: this.state.players, selfPlayerId: sourceId,
        effects: this.state.race.effects, now }).find((entry) => entry.playerId === targetId);
      if (!target?.selectable) return { error: target?.reasonLabel || "当前目标不可用。" };
    } else if (effects.self?.type === type && effects.self.endsAt > now) {
      return { error: "同类效果仍在生效，可清除效果后再次测试。" };
    }
    this.state.race.itemCooldowns[sourceId] = now + config.cooldownMs;
    if (type === "bomb") {
      const resolved = resolveBombBlast(this.state.placements, { ...position, radius: config.radius });
      this.state.placements = resolved.placements;
      if (resolved.removedPlacementIds.length) this.state.mapRevision += 1;
      this.state.race.mapRevision = this.state.mapRevision;
      return { blast: { ...position, radius: config.radius, ...resolved, sourcePlayerId: sourceId,
        mapRevision: this.state.mapRevision, serverTime: now }, targetId };
    }
    const effect = { type, sourcePlayerId: sourceId, targetPlayerId: targetId, startedAt: now, endsAt: now + config.durationMs };
    if (targeted) {
      effects.debuff = effect;
      effects.immunityUntil = effect.endsAt + DEBUFF_IMMUNITY_MS;
    } else {
      if (type === "shield" && effects.debuff?.endsAt > now) {
        effects.debuff = null;
        effects.immunityUntil = Math.max(effects.immunityUntil || 0, now + DEBUFF_IMMUNITY_MS);
      }
      effects.self = effect;
    }
    return { effect, targetId };
  }

  exportPlan() {
    return { format: "boltbound-trap-lab", version: 1, spawn: { ...this.spawn },
      placements: this.blueprint.map(({ type, x, y, rotation }) => ({ type, x, y, rotation })) };
  }

  importPlan(value) {
    if (this.state.phase !== "build") throw new Error("请先返回搭建模式。");
    if (value?.format !== "boltbound-trap-lab" || value.version !== 1 ||
      !Array.isArray(value.placements) || value.placements.length > 300) throw new Error("不是有效的实验方案（最多 300 件）。");
    const spawn = value.spawn;
    if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.y) ||
      spawn.x < 24 || spawn.x > WORLD.width - 24 || spawn.y < 40 || spawn.y > WORLD.height - 50) throw new Error("实验出生点无效。");
    // Validate the whole document before modifying the current experiment. A custom
    // spawn may intentionally be next to/inside a hazard to reproduce a collision.
    const placements = [];
    for (const input of value.placements) {
      const normalized = this.normalizePlacement(input);
      const error = normalized.error || validatePlacementSafety(normalized.placement, placements, []);
      if (error) throw new Error(PLACEMENT_ERRORS[error]);
      placements.push({ ...normalized.placement, id: `lab-${this.sequence + placements.length + 1}`, ownerId: PLAYER_ID, round: 1 });
    }
    this.remember();
    this.sequence += placements.length;
    this.blueprint = placements;
    this.spawn = { ...spawn };
    this.syncBlueprint();
  }
}
