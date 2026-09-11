import Phaser from "phaser";
import {
  ACTIVE_ITEMS,
  BASE_PLATFORMS,
  GOAL,
  PIECES,
  PLAYER_COLLISION_BOUNDS,
  PLAYER_STYLES,
  SPAWN,
  VIEWPORT,
  WORLD,
} from "../../shared/gameConfig.js";
import { GAME_ASSETS, PIECE_TEXTURE_KEYS } from "../../shared/gameAssets.js";
import {
  directionalRangeToBlocker,
  portalExitForLink,
  portalExitPosition,
  portalLinksForPlacements,
  portalModeForPlacement,
  validatePlacementSafety,
} from "../../shared/placementRules.js";

const assetForPiece = PIECE_TEXTURE_KEYS;

function assetPath(name) {
  return globalThis.__ZAOLU_MINIGAME__ ? `assets/${name}.png` : `/assets/${name}.svg`;
}

function inactiveKey() {
  return { isDown: false, on: () => {} };
}

const JUMP_BUFFER_MS = 120;
const COYOTE_MS = 100;
const AIR_JUMPS_PER_AIRTIME = 1;
const AIR_JUMP_VELOCITY_FACTOR = 0.9;
const LAND_AUDIO_MIN_AIR_MS = 80;
const FAN_LINE_COUNT = 6;
const EFFECT_MAX_X_SPEED = 760;
const EFFECT_MAX_Y_SPEED = 1_100;
const PLAYER_DRAG_X = 1_300;
const MECHANISM_STAGGER_MS = 173;
const PORTAL_PAIR_COLORS = [0x38b9b5, 0xf0644b, 0xe6b940, 0x78a95f];
const PORTAL_SOLO_COLOR = 0x5fd3c6;
const LOCAL_MOTION_INTERVAL_MS = 50;
const REMOTE_ADAPTIVE_DELAY_INITIAL_MS = 200;
const REMOTE_ADAPTIVE_DELAY_MIN_MS = 180;
const REMOTE_ADAPTIVE_DELAY_MAX_MS = 240;
const REMOTE_DELAY_MARGIN_MS = 40;
const REMOTE_DELAY_RISE_PER_FRAME = 0.18;
const REMOTE_EXTRAPOLATION_LIMIT_MS = 180;
const REMOTE_SNAP_DISTANCE = 240;
const REMOTE_CORRECTION_RATE = 24;
const REMOTE_SAMPLE_LIMIT = 14;
const REMOTE_TRANSIT_SAMPLE_LIMIT = 24;

function normalizeRotation(rotation = 0) {
  return ((Math.round(Number(rotation) / 90) * 90) % 360 + 360) % 360;
}

function forwardForRotation(rotation = 0) {
  switch (normalizeRotation(rotation)) {
    case 90: return { x: 1, y: 0 };
    case 180: return { x: 0, y: 1 };
    case 270: return { x: -1, y: 0 };
    default: return { x: 0, y: -1 };
  }
}

function barrierAxisForRotation(rotation = 0) {
  switch (normalizeRotation(rotation)) {
    case 90: return { x: 0, y: 1 };
    case 180: return { x: -1, y: 0 };
    case 270: return { x: 0, y: -1 };
    default: return { x: 1, y: 0 };
  }
}

function conveyorDirectionForRotation(rotation = 0) {
  switch (normalizeRotation(rotation)) {
    case 90: return { x: 0, y: 1 };
    case 180: return { x: -1, y: 0 };
    case 270: return { x: 0, y: -1 };
    default: return { x: 1, y: 0 };
  }
}

function mechanismCycle(elapsed, placementIndex, period) {
  const shifted = elapsed + placementIndex * MECHANISM_STAGGER_MS;
  return ((shifted % period) + period) % period;
}

function segmentHitsBody(local, startX, startY, endX, endY, padding) {
  const body = local?.body;
  if (!body) return false;
  const bounds = new Phaser.Geom.Rectangle(
    body.x - padding,
    body.y - padding,
    body.width + padding * 2,
    body.height + padding * 2,
  );
  if (Phaser.Geom.Rectangle.Contains(bounds, endX, endY)) return true;
  return Phaser.Geom.Intersects.LineToRectangle(
    new Phaser.Geom.Line(startX, startY, endX, endY),
    bounds,
  );
}

function playerExtentAlong(local, axis) {
  const halfWidth = (local?.body?.width || 54) / 2;
  const halfHeight = (local?.body?.height || 86) / 2;
  return Math.abs(axis.x) * halfWidth + Math.abs(axis.y) * halfHeight;
}

function percentile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
}

function hermiteNoOvershoot(first, second, alpha, axis) {
  const velocityKey = axis === "x" ? "vx" : "vy";
  const start = first[axis];
  const end = second[axis];
  const displacement = end - start;
  if (Math.abs(displacement) < 0.0001) return start;

  const spanSeconds = Math.max(1, second.at - first.at) / 1_000;
  let startSlope = (first[velocityKey] * spanSeconds) / displacement;
  let endSlope = (second[velocityKey] * spanSeconds) / displacement;
  if (startSlope < 0) startSlope = 0;
  if (endSlope < 0) endSlope = 0;
  const slopeMagnitude = Math.hypot(startSlope, endSlope);
  if (slopeMagnitude > 3) {
    const scale = 3 / slopeMagnitude;
    startSlope *= scale;
    endSlope *= scale;
  }

  const startTangent = startSlope * displacement;
  const endTangent = endSlope * displacement;
  const squared = alpha * alpha;
  const cubed = squared * alpha;
  return (
    (2 * cubed - 3 * squared + 1) * start +
    (cubed - 2 * squared + alpha) * startTangent +
    (-2 * cubed + 3 * squared) * end +
    (cubed - squared) * endTangent
  );
}

export class BoltboundScene extends Phaser.Scene {
  constructor(bridge) {
    super("Boltbound");
    this.bridge = bridge;
    this.renderProfile = bridge?.renderProfile || {
      key: "balanced",
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      zoom: 1,
    };
    this.roomState = null;
    this.myPlayerId = null;
    this.playerSprites = new Map();
    this.remoteTargets = new Map();
    this.mapDecorations = [];
    this.preview = null;
    this.previewFrame = null;
    this.previewEffect = null;
    this.previewDrag = null;
    this.previewPress = null;
    this.previewPointer = null;
    this.previewRotation = 0;
    this.previewValid = false;
    this.mapRevision = -1;
    this.readyRaceKey = null;
    this.lastMotionAt = 0;
    this.finishSent = false;
    this.deathSent = false;
    this.jumpWasDown = false;
    this.keyboardJumpWasDown = false;
    this.touchJumpPressed = false;
    this.jumpPressQueue = 0;
    this.keyboardJumpEventsBound = false;
    this.jumpQueuedAt = -Infinity;
    this.lastGroundedAt = -Infinity;
    this.wasGrounded = false;
    this.hasGroundContact = false;
    this.airborneSince = -Infinity;
    this.airJumpsRemaining = AIR_JUMPS_PER_AIRTIME;
    this.groundJumpCommitted = false;
    this.touch = { left: false, right: false, jump: false };
    this.serverTimeOffset = 0;
    this.serverTimeBestRtt = Number.POSITIVE_INFINITY;
    this.hasServerTimeSample = false;
    this.serverTimeFallbackSet = false;
    this.movingBarriers = [];
    this.fanEffects = [];
    this.blackHoles = [];
    this.portals = [];
    this.portalCooldownUntil = 0;
    this.portalExitLockId = null;
    this.conveyors = [];
    this.saws = [];
    this.cannons = [];
    this.lasers = [];
    this.bumpers = [];
    this.bumperContacts = new Set();
    this.iceContactUntil = -Infinity;
    this.conveyorContact = null;
    this.effectSpeedUntil = -Infinity;
    this.fogRects = [];
    this.bombEffects = [];
  }

  preload() {
    for (const asset of GAME_ASSETS) {
      this.load.image(asset.textureKey, assetPath(asset.fileBase));
    }
  }

  create() {
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.applyRenderProfile(this.renderProfile);
    this.cameras.main.setScroll(0, 0);
    this.add
      .image(VIEWPORT.width / 2, VIEWPORT.height / 2, "yard")
      .setDisplaySize(VIEWPORT.width, VIEWPORT.height);
    this.buildGrid = this.add
      .grid(
        WORLD.width / 2,
        WORLD.height / 2,
        WORLD.width,
        WORLD.height,
        WORLD.grid,
        WORLD.grid,
        0xffffff,
        0,
        0xffffff,
        0.1,
      )
      .setDepth(1)
      .setVisible(false);
    this.platformGroup = this.physics.add.staticGroup();
    this.springGroup = this.physics.add.staticGroup();
    this.hazardGroup = this.physics.add.staticGroup();
    // 路障显示在已放置零件的后方，仅与人物进行碰撞解算。
    // 独立物理组不注册与地图、其他零件或自身组之间的碰撞。
    this.barrierLayer = this.add.layer().setDepth(4.5);
    this.barrierGroup = this.physics.add.group({ allowGravity: false, immovable: true });
    this.conveyorGroup = this.physics.add.staticGroup();
    this.iceGroup = this.physics.add.staticGroup();

    this.goal = this.physics.add
      .staticImage(GOAL.x, GOAL.y, "goal")
      .setDisplaySize(GOAL.width, GOAL.height)
      .setDepth(5);
    this.goal.refreshBody();

    const keyboard = this.input.keyboard;
    this.cursors = keyboard?.createCursorKeys() || {
      left: inactiveKey(),
      right: inactiveKey(),
      up: inactiveKey(),
    };
    this.keys = keyboard?.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      jump: Phaser.Input.Keyboard.KeyCodes.W,
      jumpAlt: Phaser.Input.Keyboard.KeyCodes.SPACE,
      item: Phaser.Input.Keyboard.KeyCodes.Q,
      target1: Phaser.Input.Keyboard.KeyCodes.ONE,
      target2: Phaser.Input.Keyboard.KeyCodes.TWO,
      target3: Phaser.Input.Keyboard.KeyCodes.THREE,
      target4: Phaser.Input.Keyboard.KeyCodes.FOUR,
    }) || {
      left: inactiveKey(),
      right: inactiveKey(),
      jump: inactiveKey(),
      jumpAlt: inactiveKey(),
      item: inactiveKey(),
      target1: inactiveKey(),
      target2: inactiveKey(),
      target3: inactiveKey(),
      target4: inactiveKey(),
    };
    this.keyboardJumpEventsBound = Boolean(keyboard);
    if (keyboard) {
      for (const key of new Set([this.cursors.up, this.keys.jump, this.keys.jumpAlt])) {
        key.on("down", (_pressed, event) => {
          if (!event?.repeat) this.queueJumpPress();
        });
      }
    }
    this.keys.jumpAlt.on("down", (_key, event) => {
      if (!this.canBuildNow() || event?.repeat) return;
      event?.preventDefault();
      this.rotatePreview();
    });
    this.keys.item.on("down", (_key, event) => {
      if (event?.repeat || this.roomState?.phase !== "race") return;
      event?.preventDefault();
      this.bridge.onItemUseRequested?.();
    });
    [this.keys.target1, this.keys.target2, this.keys.target3, this.keys.target4]
      .forEach((key, index) => key.on("down", (_pressed, event) => {
        if (event?.repeat || this.roomState?.phase !== "race") return;
        event?.preventDefault();
        this.bridge.onItemTargetIndex?.(index);
      }));

    this.input.on("pointermove", (pointer) => this.handlePreviewPointerMove(pointer));
    this.input.on("pointerdown", (pointer) => this.handlePreviewPointerDown(pointer));
    this.input.on("pointerup", (pointer) => this.finishPreviewPress(pointer));
    this.input.on("pointerupoutside", (pointer) => {
      this.cancelPreviewGesture(pointer);
      this.finishPreviewPress(pointer);
    });
    this.input.on("dragstart", (pointer, gameObject) => this.startPreviewDrag(pointer, gameObject));
    this.input.on("drag", (pointer, gameObject, dragX, dragY) => this.dragPreview(pointer, gameObject, dragX, dragY));
    this.input.on("gameout", () => this.cancelPreviewGesture());
    this.input.on("dragend", (pointer, gameObject) => this.finishPreviewDrag(pointer, gameObject));

    this.fogRects = Array.from({ length: 4 }, () =>
      this.add.rectangle(0, 0, 1, 1, 0x0b2022, 0.72)
        .setDepth(80)
        .setScrollFactor(0)
        .setVisible(false));
    this.rebuildMap();
    this.isReady = true;
    if (this.pendingState) {
      const { state, playerId } = this.pendingState;
      this.pendingState = null;
      this.applyRoomState(state, playerId);
    }
    this.bridge.onSceneReady?.();
  }

  applyRenderProfile(profile = {}) {
    const width = Math.round(Number(profile.width));
    const height = Math.round(Number(profile.height));
    const zoom = Number(profile.zoom);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(zoom) ||
      width <= 0 ||
      height <= 0 ||
      zoom <= 0 ||
      Math.abs(width / zoom - VIEWPORT.width) > 0.01 ||
      Math.abs(height / zoom - VIEWPORT.height) > 0.01
    ) return false;

    this.renderProfile = { key: String(profile.key || "balanced"), width, height, zoom };
    if (!this.scale || !this.cameras?.main) return true;
    this.scale.setGameSize(width, height);
    const camera = this.cameras.main;
    camera.setViewport(0, 0, width, height);
    camera.setZoom(zoom);
    camera.setBounds(0, 0, WORLD.width, WORLD.height);
    camera.setScroll(0, 0);
    return {
      width: this.game.canvas.width,
      height: this.game.canvas.height,
      zoom: camera.zoom,
      scrollX: camera.scrollX,
      scrollY: camera.scrollY,
    };
  }

  resetServerTimeSync() {
    this.serverTimeBestRtt = Number.POSITIVE_INFINITY;
    this.hasServerTimeSample = false;
    this.serverTimeFallbackSet = false;
  }

  setServerTimeOffset(offset, rtt) {
    if (
      !Number.isFinite(offset) ||
      !Number.isFinite(rtt) ||
      rtt < 0 ||
      rtt >= this.serverTimeBestRtt
    ) return;
    this.serverTimeOffset = offset;
    this.serverTimeBestRtt = rtt;
    this.hasServerTimeSample = true;
    this.serverTimeFallbackSet = true;
  }

  applyRoomState(state, playerId) {
    if (!this.isReady) {
      this.pendingState = { state, playerId };
      return;
    }

    const previousPhase = this.roomState?.phase;
    const previousRound = this.roomState?.round;
    if (!this.hasServerTimeSample && !this.serverTimeFallbackSet && Number.isFinite(state.serverNow)) {
      this.serverTimeOffset = state.serverNow - Date.now();
      this.serverTimeFallbackSet = true;
    }
    this.roomState = state;
    this.myPlayerId = playerId;
    if (
      previousPhase &&
      previousPhase !== state.phase &&
      !["race_loading", "race_countdown", "race"].includes(state.phase)
    ) this.resetJumpState({ preserveHeld: true });

    const mapChanged = state.mapRevision !== this.mapRevision;
    if (mapChanged) {
      this.mapRevision = state.mapRevision;
      this.rebuildMap();
    }

    this.syncPlayers();
    this.syncItemEffectVisuals();
    if (state.phase === "build") this.alignPlayersToBuildBlockers();

    if (
      ["race_loading", "race_countdown"].includes(state.phase) &&
      (previousPhase !== state.phase || previousRound !== state.round)
    ) {
      this.resetForRace();
    }

    const readyRaceKey = `${state.round}:${state.mapRevision}`;
    if (
      state.phase === "race_loading" &&
      (previousPhase !== "race_loading" || this.readyRaceKey !== readyRaceKey)
    ) {
      this.readyRaceKey = readyRaceKey;
      this.time.delayedCall(60, () => {
        const currentKey = `${this.roomState?.round}:${this.roomState?.mapRevision}`;
        if (this.roomState?.phase === "race_loading" && currentKey === readyRaceKey) {
          const accepted = this.bridge.onRaceReady?.(state.mapRevision);
          if (accepted === false && this.readyRaceKey === readyRaceKey) {
            this.readyRaceKey = null;
          }
        }
      });
    }

    const me = state.players.find((player) => player.id === playerId);
    if (me?.status === "finished") this.finishSent = true;
    if (me?.status === "dead") this.deathSent = true;
    if (me) {
      const local = this.playerSprites.get(playerId)?.sprite;
      if (local?.body) {
        const shouldFreeze =
          ["dead", "timed_out"].includes(me.status) ||
          (me.status === "finished" && state.phase !== "race");
        if (shouldFreeze) {
          local.setAcceleration(0, 0);
          local.setVelocity(0, 0);
          local.setDragX(PLAYER_DRAG_X);
          local.body.enable = false;
          local.setAlpha(me.status === "finished" ? 1 : 0.35);
        } else if (me.status === "finished" && state.phase === "race") {
          local.body.enable = true;
          local.setAlpha(1);
          local.setCollideWorldBounds(true);
        }
      }
    }

    if (state.phase !== "build") this.destroyPreview();
    else {
      this.ensurePreview();
      if (mapChanged && this.preview) this.movePreview(this.preview.x, this.preview.y, true);
    }

    this.buildGrid?.setVisible(
      state.phase === "build" && this.canBuildNow(),
    );
  }

  clearRoomState() {
    this.clearBombEffects();
    this.roomState = null;
    this.myPlayerId = null;
    this.readyRaceKey = null;
    this.finishSent = false;
    this.deathSent = false;
    this.touch = { left: false, right: false, jump: false };
    this.resetJumpState();
    this.destroyPreview();
    this.buildGrid?.setVisible(false);
    this.hideFogOverlay();
    this.cameras.main.stopFollow();
    this.cameras.main.setDeadzone();
    this.cameras.main.setScroll(0, 0);
    for (const entry of this.playerSprites.values()) {
      entry.sprite.destroy();
      entry.label.destroy();
      for (const icon of entry.effectIcons || []) icon.destroy();
    }
    this.playerSprites.clear();
    this.remoteTargets.clear();
    this.mapRevision = -1;
    this.rebuildMap();
  }

  prepareForRoomResume() {
    this.readyRaceKey = null;
    this.lastMotionAt = 0;
    this.finishSent = false;
    this.deathSent = false;
    this.touch = { left: false, right: false, jump: false };
    this.resetJumpState();
  }

  restoreLocalMotion(motion) {
    if (this.roomState?.phase !== "race" || !motion) return false;
    const me = this.roomState.players?.find((player) => player.id === this.myPlayerId);
    if (!["racing", "finished"].includes(me?.status)) return false;
    if (me.status === "racing") {
      this.finishSent = false;
      this.deathSent = false;
    }
    const entry = this.playerSprites.get(this.myPlayerId);
    const local = entry?.sprite;
    const x = Number(motion.x);
    const y = Number(motion.y);
    if (!local?.body || !Number.isFinite(x) || !Number.isFinite(y)) return false;

    const safeX = Phaser.Math.Clamp(x, 0, WORLD.width);
    const safeY = Phaser.Math.Clamp(y, -100, WORLD.height + 120);
    local.body.enable = true;
    local.setPosition(safeX, safeY);
    local.body.reset(safeX, safeY);
    local.setVelocity(
      Phaser.Math.Clamp(Number(motion.vx) || 0, -900, 900),
      Phaser.Math.Clamp(Number(motion.vy) || 0, -1_400, 1_400),
    );
    local.setFlipX(Number(motion.facing) < 0);
    local.setCollideWorldBounds(me.status === "finished");
    entry.label.setPosition(safeX, safeY - 58);
    this.lastMotionAt = 0;
    return true;
  }

  receiveRaceCorrection(correction) {
    if (
      this.roomState?.phase !== "race" ||
      Number(correction?.round) !== Number(this.roomState.round) ||
      Number(correction?.mapRevision) !== Number(this.roomState.mapRevision)
    ) return false;
    const restored = this.restoreLocalMotion(correction);
    if (restored) this.rejectLocalFinish();
    return restored;
  }

  rejectLocalFinish() {
    const me = this.roomState?.players?.find((player) => player.id === this.myPlayerId);
    if (this.roomState?.phase !== "race" || me?.status !== "racing") return false;
    this.finishSent = false;
    this.playerSprites.get(this.myPlayerId)?.sprite?.setCollideWorldBounds(false);
    return true;
  }

  syncPlayers() {
    const activeIds = new Set(this.roomState.players.map((player) => player.id));
    for (const [playerId, entry] of this.playerSprites) {
      if (!activeIds.has(playerId)) {
        entry.sprite.destroy();
        entry.label.destroy();
        for (const icon of entry.effectIcons || []) icon.destroy();
        this.playerSprites.delete(playerId);
        this.remoteTargets.delete(playerId);
      }
    }

    this.roomState.players.forEach((player, index) => {
      if (this.playerSprites.has(player.id)) return;
      const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
      const x = SPAWN.x + index * 44;
      const y = SPAWN.y - index * 8;
      let sprite;
      if (player.id === this.myPlayerId) {
        sprite = this.physics.add.sprite(x, y, style.key).setDepth(8).setScale(0.72);
        sprite.setCollideWorldBounds(false);
        sprite.body.setSize(54, 86).setOffset(21, 19);
        sprite.setBounce(0.02);
        sprite.setDragX(PLAYER_DRAG_X);
        this.physics.add.collider(sprite, this.platformGroup);
        this.physics.add.collider(sprite, this.barrierGroup);
        this.physics.add.collider(sprite, this.springGroup, (local, spring) => {
          this.bounceLocalPlayer(local, spring);
        });
        this.physics.add.collider(sprite, this.conveyorGroup, (local, conveyor) => {
          this.pushLocalPlayer(local, conveyor);
        });
        this.physics.add.collider(sprite, this.iceGroup, () => {
          this.iceContactUntil = this.time.now + PIECES.ice.contactGraceMs;
        });
        this.physics.add.overlap(sprite, this.hazardGroup, () => this.killLocalPlayer("hazard"));
        this.physics.add.overlap(sprite, this.goal, () => this.finishLocalPlayer());
      } else {
        sprite = this.add.sprite(x, y, style.key).setDepth(7).setScale(0.72);
        this.remoteTargets.set(player.id, this.createRemoteMotionState(x, y));
      }
      const labelTextColor = player.styleIndex % PLAYER_STYLES.length === 2 ? "#243534" : "#fffdf7";
      const label = this.add
        .text(x, y - 56, player.name, {
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: "15px",
          fontStyle: "bold",
          color: labelTextColor,
          backgroundColor: style.color,
          padding: { x: 8, y: 3 },
        })
        .setOrigin(0.5)
        .setShadow(0, 2, "#243534", 0, false, true)
        .setDepth(9);
      this.playerSprites.set(player.id, { sprite, label, effectIcons: [], effectKey: "" });
    });
  }

  serverNow() {
    return Date.now() + this.serverTimeOffset;
  }

  activeItemEffect(playerId, slot, now = this.serverNow()) {
    const effect = this.roomState?.race?.effects?.[playerId]?.[slot];
    if (!effect || !ACTIVE_ITEMS[effect.type]) return null;
    return Number(effect.startedAt) <= now && Number(effect.endsAt) > now ? effect : null;
  }

  syncItemEffectVisuals() {
    const now = this.serverNow();
    for (const [playerId, entry] of this.playerSprites) {
      const effects = [
        this.activeItemEffect(playerId, "self", now),
        this.activeItemEffect(playerId, "debuff", now),
      ].filter(Boolean);
      const key = effects.map((effect) => `${effect.type}:${effect.endsAt}`).join("|");
      if (entry.effectKey === key) continue;
      for (const icon of entry.effectIcons || []) icon.destroy();
      entry.effectIcons = effects.map((effect) =>
        this.add.image(entry.sprite.x, entry.sprite.y - 88, `piece-${effect.type}`)
          .setDisplaySize(30, 30)
          .setDepth(10));
      entry.effectKey = key;
    }
  }

  hideFogOverlay() {
    for (const rectangle of this.fogRects) rectangle.setVisible(false);
  }

  updateFogOverlay(local) {
    const fogged =
      this.roomState?.phase === "race" &&
      this.isLocalControllable() &&
      this.activeItemEffect(this.myPlayerId, "debuff")?.type === "fog";
    if (!fogged || !local) {
      this.hideFogOverlay();
      return;
    }
    const halfWidth = 230;
    const halfHeight = 175;
    const left = Phaser.Math.Clamp(local.x - halfWidth, 0, VIEWPORT.width);
    const right = Phaser.Math.Clamp(local.x + halfWidth, 0, VIEWPORT.width);
    const top = Phaser.Math.Clamp(local.y - halfHeight, 0, VIEWPORT.height);
    const bottom = Phaser.Math.Clamp(local.y + halfHeight, 0, VIEWPORT.height);
    const layouts = [
      [left / 2, VIEWPORT.height / 2, left, VIEWPORT.height],
      [(right + VIEWPORT.width) / 2, VIEWPORT.height / 2, VIEWPORT.width - right, VIEWPORT.height],
      [(left + right) / 2, top / 2, right - left, top],
      [(left + right) / 2, (bottom + VIEWPORT.height) / 2, right - left, VIEWPORT.height - bottom],
    ];
    this.fogRects.forEach((rectangle, index) => {
      const [x, y, width, height] = layouts[index];
      rectangle.setPosition(x, y).setDisplaySize(Math.max(1, width), Math.max(1, height)).setVisible(true);
    });
  }

  createRemoteMotionState(x, y, facing = 1) {
    return {
      samples: [],
      transitSamples: [],
      lastAt: Number.NEGATIVE_INFINITY,
      x,
      y,
      facing: facing < 0 ? -1 : 1,
      interpolationDelayMs: REMOTE_ADAPTIVE_DELAY_INITIAL_MS,
      targetInterpolationDelayMs: REMOTE_ADAPTIVE_DELAY_INITIAL_MS,
    };
  }

  alignPlayersToBuildBlockers() {
    const blockers = this.roomState?.build?.blockers;
    if (!Array.isArray(blockers)) return;
    for (const blocker of blockers) {
      const entry = this.playerSprites.get(blocker.playerId);
      const x = Number(blocker.x);
      const y = Number(blocker.y);
      if (!entry || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const visible = blocker.blocksPlacement !== false;
      entry.sprite.setVisible(visible);
      entry.label.setVisible(visible);
      for (const icon of entry.effectIcons || []) icon.setVisible(visible);
      if (!visible) {
        if (entry.sprite.body) entry.sprite.body.enable = false;
        continue;
      }
      entry.sprite.setPosition(x, y);
      if (entry.sprite.body?.enable) {
        entry.sprite.body.reset(x, y);
        entry.sprite.setVelocity(0, 0);
      }
      entry.label.setPosition(x, y - 58);
      if (blocker.playerId !== this.myPlayerId) {
        this.remoteTargets.set(
          blocker.playerId,
          this.createRemoteMotionState(x, y, entry.sprite.flipX ? -1 : 1),
        );
      }
    }
  }

  pieceDimensions(type, rotation = 0) {
    const piece = PIECES[type];
    if (!piece) return null;
    if (rotation % 180 === 90) {
      return { width: piece.height, height: piece.width };
    }
    return { width: piece.width, height: piece.height };
  }

  rebuildMap() {
    if (!this.platformGroup) return;
    for (const decoration of this.mapDecorations) decoration.destroy();
    this.mapDecorations = [];
    this.barrierGroup?.clear(true, true);
    this.conveyorGroup?.clear(true, true);
    this.iceGroup?.clear(true, true);
    this.movingBarriers = [];
    this.fanEffects = [];
    this.blackHoles = [];
    this.portals = [];
    this.conveyors = [];
    this.saws = [];
    this.cannons = [];
    this.lasers = [];
    this.bumpers = [];
    this.bumperContacts.clear();
    this.iceContactUntil = -Infinity;
    this.conveyorContact = null;
    this.effectSpeedUntil = -Infinity;
    this.portalCooldownUntil = 0;
    this.portalExitLockId = null;
    this.platformGroup.clear(true, true);
    this.springGroup.clear(true, true);
    this.hazardGroup.clear(true, true);

    for (const platform of BASE_PLATFORMS) {
      const body = this.add
        .rectangle(platform.x, platform.y, platform.width, platform.height, 0x435b58)
        .setStrokeStyle(6, 0x243534)
        .setDepth(3);
      this.platformGroup.add(body);
      body.body.updateFromGameObject();

      const cap = this.add
        .rectangle(
          platform.x,
          platform.y - platform.height / 2 + 10,
          platform.width - 8,
          18,
          0xf4c84a,
        )
        .setDepth(4);
      const lip = this.add
        .rectangle(
          platform.x,
          platform.y - platform.height / 2 + 25,
          platform.width - 16,
          10,
          0xb96e45,
        )
        .setDepth(4);
      this.mapDecorations.push(cap, lip);

      const boltY = platform.y - platform.height / 2 + 10;
      for (const boltX of [platform.x - platform.width / 2 + 18, platform.x + platform.width / 2 - 18]) {
        const bolt = this.add.circle(boltX, boltY, 5, 0xfff4d8).setStrokeStyle(3, 0x243534).setDepth(5);
        this.mapDecorations.push(bolt);
      }

      if (platform.height >= 80) {
        const brace = this.add
          .rectangle(platform.x, platform.y + 10, 12, Math.min(76, platform.height - 30), 0x2f4543)
          .setAngle(platform.x < WORLD.width / 2 ? -24 : 24)
          .setDepth(4);
        this.mapDecorations.push(brace);
      }
    }

    for (const [placementIndex, placement] of (this.roomState?.placements || []).entries()) {
      const key = assetForPiece[placement.type];
      const dimensions = this.pieceDimensions(placement.type, placement.rotation);
      if (!key || !dimensions) continue;
      if (placement.type === "barrier") {
        const width = placement.width || dimensions.width;
        const height = placement.height || dimensions.height;
        const barrier = this.physics.add.image(placement.x, placement.y, key);
        this.barrierLayer.add(barrier);
        barrier
          .setDisplaySize(PIECES.barrier.width, PIECES.barrier.height)
          .setAngle(placement.rotation || 0)
          .setImmovable(true)
          .setPushable(false);
        barrier.body.setAllowGravity(false);
        this.barrierGroup.add(barrier);
        barrier.body.setSize(width, height, true);
        barrier.body.setDirectControl(true);
        barrier.body.updateFromGameObject();
        const axis = barrierAxisForRotation(placement.rotation);
        this.movingBarriers.push({
          sprite: barrier,
          baseX: placement.x,
          baseY: placement.y,
          width,
          height,
          axis,
          travel: this.barrierTravelRange(placement, { width, height }, axis),
          placementIndex,
        });
        continue;
      }

      const image = this.add.image(placement.x, placement.y, key).setDepth(5);
      image.setDisplaySize(PIECES[placement.type].width, PIECES[placement.type].height);
      image.setAngle(placement.rotation || 0);
      this.mapDecorations.push(image);


      if (placement.type === "fan") {
        const graphics = this.add.graphics().setDepth(4);
        this.mapDecorations.push(graphics);
        this.fanEffects.push({ ...placement, graphics });
      }
      if (placement.type === "blackhole") {
        const graphics = this.add.graphics().setDepth(4);
        this.mapDecorations.push(graphics);
        this.blackHoles.push({ ...placement, graphics });
        continue;
      }
      if (placement.type === "portal") {
        const graphics = this.add.graphics().setDepth(4);
        this.mapDecorations.push(graphics);
        this.portals.push({
          ...placement,
          id: `portal-${placementIndex}`,
          image,
          graphics,
          target: null,
          link: null,
          mode: "inactive",
          pairColor: 0x71817f,
          pairIndex: null,
        });
        continue;
      }

      if (placement.type === "conveyor") {
        const graphics = this.add.graphics().setDepth(6);
        this.mapDecorations.push(graphics);
        this.conveyors.push({ ...placement, placementIndex, image, graphics });
      }
      if (placement.type === "saw") {
        this.saws.push({ ...placement, placementIndex, image });
      }
      if (placement.type === "cannon") {
        const graphics = this.add.graphics().setDepth(7);
        this.mapDecorations.push(graphics);
        this.cannons.push({ ...placement, placementIndex, image, graphics });
      }
      if (placement.type === "laser") {
        const graphics = this.add.graphics().setDepth(6);
        this.mapDecorations.push(graphics);
        this.lasers.push({ ...placement, placementIndex, image, graphics });
      }
      if (placement.type === "bumper") {
        const graphics = this.add.graphics().setDepth(6);
        this.mapDecorations.push(graphics);
        this.bumpers.push({
          ...placement,
          id: `bumper-${placementIndex}`,
          placementIndex,
          image,
          graphics,
        });
      }

      if (["saw", "bumper"].includes(placement.type)) continue;

      const hitbox = this.add
        .rectangle(
          placement.x,
          placement.y,
          placement.width || dimensions.width,
          placement.height || dimensions.height,
          0x000000,
          0,
        )
        .setVisible(false);
      hitbox.pieceRotation = placement.rotation || 0;
      hitbox.pieceType = placement.type;
      if (placement.type === "spikes") {
        this.hazardGroup.add(hitbox);
      } else if (placement.type === "spring") {
        this.springGroup.add(hitbox);
      } else if (placement.type === "conveyor") {
        this.conveyorGroup.add(hitbox);
      } else if (placement.type === "ice") {
        this.iceGroup.add(hitbox);
      } else {
        this.platformGroup.add(hitbox);
      }
      hitbox.body.updateFromGameObject();
    }
    this.pairPortals();
    this.resetMechanismRuntime();
  }

  barrierTravelRange(placement, dimensions, axis) {
    const configured = PIECES.barrier.travelRange;
    if (axis.x !== 0) {
      const left = placement.x - dimensions.width / 2;
      const right = WORLD.width - placement.x - dimensions.width / 2;
      return Math.max(0, Math.min(configured, left, right));
    }
    const up = placement.y - dimensions.height / 2;
    const down = WORLD.height - placement.y - dimensions.height / 2;
    return Math.max(0, Math.min(configured, up, down));
  }

  pairPortals() {
    for (const portal of this.portals) {
      portal.target = null;
      portal.link = null;
      portal.mode = "inactive";
      portal.pairColor = 0x71817f;
      portal.pairIndex = null;
      portal.image.setAlpha(0.42).setTint(0x71817f);
    }

    for (const link of portalLinksForPlacements(this.portals)) {
      const portal = link.source;
      const color = link.mode === "solo"
        ? PORTAL_SOLO_COLOR
        : PORTAL_PAIR_COLORS[link.pairIndex % PORTAL_PAIR_COLORS.length];
      portal.target = link.target;
      portal.link = link;
      portal.mode = link.mode;
      portal.pairColor = color;
      portal.pairIndex = link.pairIndex;
      portal.image.setAlpha(1).setTint(color);
    }
  }

  resetMechanismRuntime() {
    this.portalCooldownUntil = 0;
    this.portalExitLockId = null;
    this.bumperContacts.clear();
    this.iceContactUntil = -Infinity;
    this.conveyorContact = null;
    this.effectSpeedUntil = -Infinity;
    for (const barrier of this.movingBarriers) {
      barrier.sprite.body.reset(barrier.baseX, barrier.baseY);
    }
    for (const saw of this.saws) saw.image.setAngle(saw.rotation || 0);
    for (const cannon of this.cannons) cannon.graphics.clear();
    for (const laser of this.lasers) laser.graphics.clear();
    for (const bumper of this.bumpers) bumper.graphics.clear();
    const local = this.playerSprites.get(this.myPlayerId)?.sprite;
    if (local?.body) {
      local.setDragX(PLAYER_DRAG_X);
      local.setGravityY(0);
    }
  }

  resetForRace() {
    this.finishSent = false;
    this.deathSent = false;
    this.resetJumpState({ preserveHeld: true });
    this.resetMechanismRuntime();
    const playerEntries = [...this.playerSprites.entries()];
    playerEntries.forEach(([playerId, entry], index) => {
      const x = SPAWN.x + index * 44;
      const y = SPAWN.y - index * 8;
      entry.sprite
        .setVisible(true)
        .setPosition(x, y).setAlpha(1).setAngle(0).setFlipX(false).setScale(0.72);
      entry.label.setVisible(true).setPosition(x, y - 58);
      for (const icon of entry.effectIcons || []) icon.setVisible(true);
      if (entry.sprite.body) {
        entry.sprite.setCollideWorldBounds(false);
        entry.sprite.body.enable = true;
        entry.sprite.setVelocity(0, 0);
        entry.sprite.setDragX(PLAYER_DRAG_X);
      } else {
        this.remoteTargets.set(playerId, this.createRemoteMotionState(x, y));
      }
    });
  }

  canBuildNow() {
    const build = this.roomState?.build;
    return (
      this.roomState?.phase === "build" &&
      Boolean(PIECES[build?.pieces?.[this.myPlayerId]]) &&
      !build?.decisions?.[this.myPlayerId]
    );
  }

  handlePreviewPointerMove(pointer) {
    if (this.previewPress && this.previewPress.pointerId !== pointer.id) return;
    this.previewPointer = pointer;
    if (!this.previewDrag) {
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.movePreview(worldPoint.x, worldPoint.y);
    }
  }

  handlePreviewPointerDown(pointer) {
    if (!pointer.primaryDown || !this.preview || !this.canBuildNow()) return;
    if (this.previewPress && this.previewPress.pointerId !== pointer.id) return;
    this.previewPress = {
      pointerId: pointer.id,
      cancelled: false,
    };
    this.previewPointer = pointer;
    if (!this.previewDrag) {
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.movePreview(worldPoint.x, worldPoint.y, true);
    }
  }

  startPreviewDrag(pointer, gameObject) {
    if (gameObject !== this.preview || !this.canBuildNow()) return;
    if (this.previewPress && this.previewPress.pointerId !== pointer.id) return;
    if (!this.previewPress) {
      this.previewPress = {
        pointerId: pointer.id,
        cancelled: false,
      };
    }
    this.previewDrag = {
      pointerId: pointer.id,
      cancelled: false,
    };
    this.previewPointer = pointer;
  }

  dragPreview(pointer, gameObject, dragX, dragY) {
    const drag = this.previewDrag;
    if (!drag || gameObject !== this.preview || drag.pointerId !== pointer.id) return;
    this.previewPointer = pointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.movePreview(worldPoint.x, worldPoint.y, true);
  }

  cancelPreviewGesture(pointer) {
    const pointerId = pointer?.id;
    if (this.previewDrag && (pointerId === undefined || this.previewDrag.pointerId === pointerId)) {
      this.previewDrag.cancelled = true;
    }
    if (this.previewPress && (pointerId === undefined || this.previewPress.pointerId === pointerId)) {
      this.previewPress.cancelled = true;
    }
    if (pointerId === undefined || this.previewPointer?.id === pointerId) this.previewPointer = null;
  }

  isPointerInsideCanvas(pointer) {
    return (
      Number.isFinite(pointer.x) &&
      Number.isFinite(pointer.y) &&
      pointer.x >= 0 &&
      pointer.x <= this.scale.width &&
      pointer.y >= 0 &&
      pointer.y <= this.scale.height
    );
  }

  finishPreviewDrag(pointer, gameObject) {
    const drag = this.previewDrag;
    if (!drag || gameObject !== this.preview || drag.pointerId !== pointer.id) return;
    this.previewDrag = null;
    if (
      drag.cancelled ||
      pointer.wasCanceled ||
      !this.isPointerInsideCanvas(pointer)
    ) {
      this.cancelPreviewGesture(pointer);
    }
    if (!this.previewPress) this.previewPointer = null;
  }

  finishPreviewPress(pointer) {
    const press = this.previewPress;
    if (!press || press.pointerId !== pointer.id) return;
    this.previewPress = null;
    this.previewPointer = null;
    if (
      !this.canBuildNow() ||
      press.cancelled ||
      pointer.wasCanceled ||
      !this.isPointerInsideCanvas(pointer)
    ) return;
    if (!this.previewValid) {
      this.pulseInvalidPreview();
      return;
    }
    const placement = this.getPlacement();
    if (placement) this.bridge.onPlacementRequested?.(placement);
  }

  ensurePreview() {
    if (!this.canBuildNow()) {
      this.destroyPreview();
      return;
    }
    const type = this.roomState.build.pieces[this.myPlayerId];
    if (this.preview?.pieceType === type) return;
    this.destroyPreview();
    this.previewRotation = 0;
    const dimensions = this.pieceDimensions(type, this.previewRotation);
    const cameraCenter = this.cameras.main.midPoint;
    this.previewEffect = this.add.graphics().setDepth(10);
    this.previewFrame = this.add
      .rectangle(cameraCenter.x, cameraCenter.y, dimensions.width + 20, dimensions.height + 20, 0x78a95f, 0.1)
      .setStrokeStyle(5, 0xfff4d8, 0.95)
      .setDepth(11);
    this.preview = this.add
      .image(cameraCenter.x, cameraCenter.y, assetForPiece[type])
      .setDisplaySize(PIECES[type].width, PIECES[type].height)
      .setAlpha(0.72)
      .setDepth(12)
      .setInteractive({ useHandCursor: true });
    this.input.setDraggable(this.preview);
    this.preview.pieceType = type;
    this.movePreview(cameraCenter.x, cameraCenter.y, true);
    this.bridge.onPreviewRotated?.(this.previewRotation);
  }

  movePreview(worldX, worldY, commit = false) {
    if (!this.preview || !this.canBuildNow()) return;
    const x = Phaser.Math.Snap.To(Phaser.Math.Clamp(worldX, 80, WORLD.width - 80), WORLD.grid);
    const y = Phaser.Math.Snap.To(Phaser.Math.Clamp(worldY, 160, WORLD.groundY - 40), WORLD.grid);
    this.preview.setPosition(x, y);
    this.previewValid = this.validatePreview(x, y);
    this.refreshPreviewFeedback(commit);
    this.bridge.onPreviewChanged?.(this.previewValid);
  }

  refreshPreviewFeedback(commit = true) {
    if (!this.preview || !this.previewFrame) return;
    const dimensions = this.pieceDimensions(this.preview.pieceType, this.previewRotation);
    const color = this.previewValid ? 0x78a95f : 0xf0644b;
    this.refreshPreviewEffect(color);
    this.preview.setTint(this.previewValid ? 0xffffff : 0xf0644b);
    this.preview.setAlpha(commit ? 0.92 : 0.72);
    this.previewFrame
      .setPosition(this.preview.x, this.preview.y)
      .setDisplaySize(dimensions.width + 20, dimensions.height + 20)
      .setFillStyle(color, this.previewValid ? 0.1 : 0.17)
      .setStrokeStyle(5, this.previewValid ? 0xfff4d8 : 0xf0644b, 0.95)
      .setAlpha(commit ? 1 : 0.78);
  }

  refreshPreviewEffect(color) {
    if (!this.previewEffect || !this.preview) return;
    const type = this.preview.pieceType;
    const x = this.preview.x;
    const y = this.preview.y;
    this.previewEffect.clear();
    this.previewEffect.fillStyle(color, 0.08);
    this.previewEffect.lineStyle(3, color, 0.52);
    if (type === "fan") {
      const direction = forwardForRotation(this.previewRotation);
      const side = { x: -direction.y, y: direction.x };
      const start = 40;
      const end = PIECES.fan.effectRange;
      const half = PIECES.fan.effectWidth / 2;
      const points = [
        { x: x + direction.x * start + side.x * half, y: y + direction.y * start + side.y * half },
        { x: x + direction.x * end + side.x * half, y: y + direction.y * end + side.y * half },
        { x: x + direction.x * end - side.x * half, y: y + direction.y * end - side.y * half },
        { x: x + direction.x * start - side.x * half, y: y + direction.y * start - side.y * half },
      ];
      this.previewEffect.fillPoints(points, true);
      this.previewEffect.strokePoints(points, true);
    } else if (type === "barrier") {
      const axis = barrierAxisForRotation(this.previewRotation);
      const dimensions = this.pieceDimensions(type, this.previewRotation);
      const travel = this.barrierTravelRange({ x, y }, dimensions, axis);
      const startX = x - axis.x * travel;
      const startY = y - axis.y * travel;
      const endX = x + axis.x * travel;
      const endY = y + axis.y * travel;
      this.previewEffect.lineStyle(7, color, 0.42);
      this.previewEffect.lineBetween(startX, startY, endX, endY);
      this.previewEffect.strokeRect(startX - dimensions.width / 2, startY - dimensions.height / 2, dimensions.width, dimensions.height);
      this.previewEffect.strokeRect(endX - dimensions.width / 2, endY - dimensions.height / 2, dimensions.width, dimensions.height);
    } else if (type === "blackhole") {
      this.previewEffect.fillStyle(color, 0.07);
      this.previewEffect.fillCircle(x, y, PIECES.blackhole.effectRadius);
      this.previewEffect.lineStyle(3, color, 0.5);
      this.previewEffect.strokeCircle(x, y, PIECES.blackhole.effectRadius);
      this.previewEffect.fillStyle(color, 0.32);
      this.previewEffect.fillCircle(x, y, PIECES.blackhole.coreRadius);
    } else if (type === "portal") {
      const candidate = { type, x, y, rotation: this.previewRotation };
      const topology = [...(this.roomState?.placements || []), candidate];
      const mode = portalModeForPlacement(candidate, topology);
      this.previewEffect.strokeCircle(x, y, PIECES.portal.triggerRadius);
      if (mode === "inactive") {
        this.previewEffect.lineStyle(3, 0x71817f, 0.42);
        this.previewEffect.strokeCircle(x, y, PIECES.portal.triggerRadius + 8);
      } else {
        const exit = portalExitPosition(candidate, mode);
        const { direction, requestedDirection } = exit;
        const side = { x: -direction.y, y: direction.x };
        this.previewEffect.lineBetween(
          x + requestedDirection.x * 30,
          y + requestedDirection.y * 30,
          exit.x,
          exit.y,
        );
        this.previewEffect.fillStyle(color, 0.82);
        this.previewEffect.fillTriangle(
          exit.x,
          exit.y,
          exit.x - direction.x * 22 + side.x * 11,
          exit.y - direction.y * 22 + side.y * 11,
          exit.x - direction.x * 22 - side.x * 11,
          exit.y - direction.y * 22 - side.y * 11,
        );
        this.previewEffect.strokeRect(
          exit.x - PLAYER_COLLISION_BOUNDS.left,
          exit.y - PLAYER_COLLISION_BOUNDS.top,
          PLAYER_COLLISION_BOUNDS.left + PLAYER_COLLISION_BOUNDS.right,
          PLAYER_COLLISION_BOUNDS.top + PLAYER_COLLISION_BOUNDS.bottom,
        );
      }
    } else if (type === "conveyor") {
      const direction = conveyorDirectionForRotation(this.previewRotation);
      const length = PIECES.conveyor.width / 2 - 18;
      const startX = x - direction.x * length;
      const startY = y - direction.y * length;
      const endX = x + direction.x * length;
      const endY = y + direction.y * length;
      this.previewEffect.lineStyle(8, color, 0.4);
      this.previewEffect.lineBetween(startX, startY, endX, endY);
      this.previewEffect.fillStyle(color, 0.82);
      this.previewEffect.fillTriangle(
        endX,
        endY,
        endX - direction.x * 22 - direction.y * 12,
        endY - direction.y * 22 + direction.x * 12,
        endX - direction.x * 22 + direction.y * 12,
        endY - direction.y * 22 - direction.x * 12,
      );
    } else if (type === "saw") {
      this.previewEffect.strokeCircle(x, y, PIECES.saw.bladeRadius);
    } else if (["cannon", "laser"].includes(type)) {
      const piece = PIECES[type];
      const direction = forwardForRotation(this.previewRotation);
      const halfWidth = type === "cannon" ? piece.projectileRadius : piece.beamWidth / 2;
      const range = directionalRangeToBlocker(x, y, direction, piece.range, halfWidth, piece.muzzleOffset);
      const startX = x + direction.x * piece.muzzleOffset;
      const startY = y + direction.y * piece.muzzleOffset;
      const endX = x + direction.x * range;
      const endY = y + direction.y * range;
      this.previewEffect.lineStyle(type === "laser" ? piece.beamWidth : 5, color, 0.32);
      this.previewEffect.lineBetween(startX, startY, endX, endY);
      this.previewEffect.fillStyle(color, 0.82);
      this.previewEffect.fillCircle(endX, endY, type === "cannon" ? piece.projectileRadius : 7);
    } else if (type === "bumper") {
      this.previewEffect.fillStyle(color, 0.07);
      this.previewEffect.fillCircle(x, y, PIECES.bumper.triggerRadius);
      this.previewEffect.lineStyle(3, color, 0.56);
      this.previewEffect.strokeCircle(x, y, PIECES.bumper.triggerRadius);
    }
  }

  pulseInvalidPreview() {
    if (!this.previewFrame) return;
    this.tweens.killTweensOf(this.previewFrame);
    this.previewFrame.setAlpha(1);
    this.tweens.add({
      targets: this.previewFrame,
      alpha: 0.25,
      duration: 70,
      yoyo: true,
      repeat: 1,
    });
  }

  validatePreview(x, y) {
    const dimensions = this.pieceDimensions(this.preview.pieceType, this.previewRotation);
    const candidate = {
      type: this.preview.pieceType,
      rotation: this.previewRotation,
      x,
      y,
      ...dimensions,
    };
    return !validatePlacementSafety(
      candidate,
      this.roomState?.placements || [],
      this.roomState?.build?.blockers || [],
    );
  }

  rotatePreview() {
    if (!this.preview || !PIECES[this.preview.pieceType].rotatable) return;
    this.previewRotation = (this.previewRotation + 90) % 360;
    this.preview.setAngle(this.previewRotation);
    this.previewValid = this.validatePreview(this.preview.x, this.preview.y);
    this.refreshPreviewFeedback(true);
    this.tweens.add({ targets: this.previewFrame, alpha: 0.62, duration: 80, yoyo: true });
    this.bridge.onPreviewChanged?.(this.previewValid);
    this.bridge.onPreviewRotated?.(this.previewRotation);
  }

  getPlacement() {
    if (!this.preview || !this.previewValid) return null;
    return {
      type: this.preview.pieceType,
      x: this.preview.x,
      y: this.preview.y,
      rotation: this.previewRotation,
    };
  }

  destroyPreview() {
    this.tweens?.killTweensOf(this.preview);
    this.tweens?.killTweensOf(this.previewFrame);
    if (this.preview) this.preview.destroy();
    if (this.previewFrame) this.previewFrame.destroy();
    if (this.previewEffect) this.previewEffect.destroy();
    this.preview = null;
    this.previewFrame = null;
    this.previewEffect = null;
    this.previewDrag = null;
    this.previewPress = null;
    this.previewPointer = null;
    this.previewValid = false;
    this.bridge.onPreviewChanged?.(false);
  }

  keyboardJumpDown() {
    return Boolean(
      this.cursors?.up?.isDown ||
      this.keys?.jump?.isDown ||
      this.keys?.jumpAlt?.isDown
    );
  }

  queueJumpPress() {
    if (!this.isLocalControllable()) return false;
    this.jumpPressQueue = Math.min(2, this.jumpPressQueue + 1);
    return true;
  }

  consumeJumpPress() {
    if (this.jumpPressQueue <= 0) return false;
    this.jumpPressQueue -= 1;
    return true;
  }

  resetJumpState({ preserveHeld = false } = {}) {
    const keyboardDown = preserveHeld && this.keyboardJumpDown();
    const jumpDown = keyboardDown || (preserveHeld && Boolean(this.touch.jump));
    this.keyboardJumpWasDown = keyboardDown;
    this.jumpWasDown = jumpDown;
    this.touchJumpPressed = false;
    this.jumpPressQueue = 0;
    this.jumpQueuedAt = -Infinity;
    this.lastGroundedAt = -Infinity;
    this.wasGrounded = false;
    this.hasGroundContact = false;
    this.airborneSince = -Infinity;
    this.airJumpsRemaining = AIR_JUMPS_PER_AIRTIME;
    this.groundJumpCommitted = false;
  }

  setTouchControl(control, pressed) {
    if (!(control in this.touch)) return;
    const nextPressed = Boolean(pressed);
    if (control === "jump" && nextPressed && !this.touch.jump) {
      this.touchJumpPressed = true;
      this.queueJumpPress();
    }
    this.touch[control] = nextPressed;
  }

  clearBombEffects() {
    for (const effect of this.bombEffects) {
      this.tweens?.killTweensOf(effect);
      effect.destroy();
    }
    this.bombEffects = [];
  }

  showBombExplosion(x, y, radius) {
    if (!this.add || !this.tweens) return;
    const graphics = this.add.graphics().setPosition(x, y).setDepth(95);
    graphics.fillStyle(0xf0644b, 0.2);
    graphics.fillCircle(0, 0, radius);
    graphics.lineStyle(10, 0xffd35a, 0.95);
    graphics.strokeCircle(0, 0, radius * 0.45);
    graphics.lineStyle(5, 0xfff4d8, 0.86);
    graphics.strokeCircle(0, 0, radius * 0.82);
    for (let index = 0; index < 12; index += 1) {
      const angle = (Math.PI * 2 * index) / 12;
      const inner = radius * 0.34;
      const outer = radius * (0.72 + (index % 3) * 0.08);
      graphics.lineStyle(5, index % 2 ? 0xffd35a : 0xf0644b, 0.92);
      graphics.lineBetween(
        Math.cos(angle) * inner,
        Math.sin(angle) * inner,
        Math.cos(angle) * outer,
        Math.sin(angle) * outer,
      );
    }
    this.bombEffects.push(graphics);
    this.tweens.add({
      targets: graphics,
      scaleX: 1.18,
      scaleY: 1.18,
      alpha: 0,
      duration: 520,
      ease: "Cubic.easeOut",
      onComplete: () => {
        this.bombEffects = this.bombEffects.filter((effect) => effect !== graphics);
        graphics.destroy();
      },
    });
  }

  receiveBombBlast(blast) {
    if (!this.roomState || !blast || this.roomState.phase !== "race") return false;
    const x = Number(blast.x);
    const y = Number(blast.y);
    const radius = Phaser.Math.Clamp(
      Number(blast.radius) || Number(ACTIVE_ITEMS.bomb?.radius) || 220,
      40,
      480,
    );
    const revision = Number(blast.mapRevision);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(revision)) return false;
    if (revision < this.mapRevision) return false;

    if (revision > this.mapRevision) {
      if (!Array.isArray(blast.placements)) return false;
      this.roomState = {
        ...this.roomState,
        placements: blast.placements.map((placement) => ({ ...placement })),
        mapRevision: revision,
        race: this.roomState.race
          ? { ...this.roomState.race, mapRevision: revision }
          : this.roomState.race,
      };
      this.mapRevision = revision;
      this.rebuildMap();
    }
    this.showBombExplosion(
      Phaser.Math.Clamp(x, 0, WORLD.width),
      Phaser.Math.Clamp(y, 0, WORLD.height),
      radius,
    );
    this.bridge.onAudioEvent?.("bomb", {
      dedupeKey: `${blast.sourcePlayerId}:${blast.serverTime}:${revision}`,
    });
    return true;
  }

  receivePeerMotion(motion) {
    if (this.roomState?.phase !== "race") return;
    if (motion.playerId === this.myPlayerId) return;
    const player = this.roomState.players.find((candidate) => candidate.id === motion.playerId);
    if (!player || !["racing", "finished"].includes(player.status)) return;
    const entry = this.playerSprites.get(motion.playerId);
    const x = Number(motion.x);
    const y = Number(motion.y);
    const at = Number.isFinite(Number(motion.at))
      ? Number(motion.at)
      : Date.now() + this.serverTimeOffset;
    if (!entry || !Number.isFinite(x) || !Number.isFinite(y)) return;

    const state = this.remoteTargets.get(motion.playerId) ||
      this.createRemoteMotionState(entry.sprite.x, entry.sprite.y, motion.facing);
    if (at < state.lastAt) return;
    const transitMs = Phaser.Math.Clamp(this.serverNow() - at, 0, 400);
    state.transitSamples.push(transitMs);
    if (state.transitSamples.length > REMOTE_TRANSIT_SAMPLE_LIMIT) {
      state.transitSamples.shift();
    }
    state.targetInterpolationDelayMs = Math.max(
      state.targetInterpolationDelayMs,
      Phaser.Math.Clamp(
        percentile(state.transitSamples, 0.9) + REMOTE_DELAY_MARGIN_MS,
        REMOTE_ADAPTIVE_DELAY_MIN_MS,
        REMOTE_ADAPTIVE_DELAY_MAX_MS,
      ),
    );
    const sample = {
      x,
      y,
      vx: Phaser.Math.Clamp(Number(motion.vx) || 0, -900, 900),
      vy: Phaser.Math.Clamp(Number(motion.vy) || 0, -1_400, 1_400),
      facing: Number(motion.facing) < 0 ? -1 : 1,
      at,
    };
    const distance = Phaser.Math.Distance.Between(entry.sprite.x, entry.sprite.y, x, y);
    const firstDistantSample = !state.samples.length && distance >= REMOTE_SNAP_DISTANCE;
    if (motion.snap || firstDistantSample) {
      state.samples = [sample];
      state.lastAt = at;
      state.x = x;
      state.y = y;
      state.facing = sample.facing;
      entry.sprite.setPosition(x, y).setFlipX(sample.facing < 0);
      entry.label.setPosition(x, y - 58);
      this.remoteTargets.set(motion.playerId, state);
      return;
    }

    if (at === state.lastAt && state.samples.length) state.samples[state.samples.length - 1] = sample;
    else state.samples.push(sample);
    if (state.samples.length > REMOTE_SAMPLE_LIMIT) {
      state.samples.splice(0, state.samples.length - REMOTE_SAMPLE_LIMIT);
    }
    state.lastAt = at;
    state.x = x;
    state.y = y;
    state.facing = sample.facing;
    this.remoteTargets.set(motion.playerId, state);
  }

  updateRemotePlayers(delta) {
    if (this.roomState?.phase !== "race") return;
    const serverNow = this.serverNow();
    const frameDelta = Phaser.Math.Clamp(delta, 0, 50);
    const correction = 1 - Math.exp(
      -REMOTE_CORRECTION_RATE * (frameDelta / 1_000),
    );
    for (const [playerId, state] of this.remoteTargets) {
      const entry = this.playerSprites.get(playerId);
      if (!entry || playerId === this.myPlayerId || !state.samples?.length) continue;
      state.interpolationDelayMs += Phaser.Math.Clamp(
        state.targetInterpolationDelayMs - state.interpolationDelayMs,
        0,
        frameDelta * REMOTE_DELAY_RISE_PER_FRAME,
      );
      const renderAt = serverNow - state.interpolationDelayMs;
      while (state.samples.length >= 2 && state.samples[1].at <= renderAt) state.samples.shift();

      const first = state.samples[0];
      const second = state.samples[1];
      let x = first.x;
      let y = first.y;
      let facing = first.facing;
      if (second && renderAt >= first.at) {
        const span = Math.max(1, second.at - first.at);
        const alpha = Phaser.Math.Clamp((renderAt - first.at) / span, 0, 1);
        x = hermiteNoOvershoot(first, second, alpha, "x");
        y = hermiteNoOvershoot(first, second, alpha, "y");
        facing = alpha < 0.5 ? first.facing : second.facing;
      } else if (!second && renderAt > first.at) {
        const extrapolationMs = Math.min(
          REMOTE_EXTRAPOLATION_LIMIT_MS,
          renderAt - first.at,
        );
        x += first.vx * (extrapolationMs / 1_000);
        y += first.vy * (extrapolationMs / 1_000);
      }
      x = Phaser.Math.Clamp(x, -80, WORLD.width + 80);
      y = Phaser.Math.Clamp(y, -160, WORLD.height + 160);

      entry.sprite.setPosition(
        Phaser.Math.Linear(entry.sprite.x, x, correction),
        Phaser.Math.Linear(entry.sprite.y, y, correction),
      );
      entry.sprite.setFlipX(facing < 0);
    }
  }

  mechanismElapsed(time) {
    const countdownAt = Number(this.roomState?.race?.countdownAt);
    if (Number.isFinite(countdownAt)) {
      return Math.max(0, Date.now() + this.serverTimeOffset - countdownAt);
    }
    return time;
  }

  updateMovingBarriers(time) {
    const racing = this.roomState?.phase === "race";
    const elapsed = racing ? this.mechanismElapsed(time) : 0;
    for (const barrier of this.movingBarriers) {
      const period = PIECES.barrier.periodMs;
      const omega = (Math.PI * 2) / period;
      const phase = elapsed * omega;
      const offset = Math.sin(phase) * barrier.travel;
      const x = barrier.baseX + barrier.axis.x * offset;
      const y = barrier.baseY + barrier.axis.y * offset;
      barrier.sprite.setPosition(x, y);
      barrier.sprite.body.updateFromGameObject();
    }
  }

  updateFanVisuals(time) {
    const range = PIECES.fan.effectRange;
    const width = PIECES.fan.effectWidth;
    for (const fan of this.fanEffects) {
      const direction = forwardForRotation(fan.rotation);
      const side = { x: -direction.y, y: direction.x };
      fan.graphics.clear();
      for (let index = 0; index < FAN_LINE_COUNT; index += 1) {
        const progress = ((time * 0.00048 + index / FAN_LINE_COUNT) % 1 + 1) % 1;
        const distance = 48 + progress * (range - 48);
        const lane = (index - (FAN_LINE_COUNT - 1) / 2) * (width / FAN_LINE_COUNT);
        const sway = Math.sin(time * 0.004 + index * 1.7) * 7;
        const x = fan.x + direction.x * distance + side.x * (lane + sway);
        const y = fan.y + direction.y * distance + side.y * (lane + sway);
        const length = 24 + (index % 2) * 12;
        const alpha = 0.18 + (1 - progress) * 0.5;
        fan.graphics.lineStyle(5, 0xd7f3ed, alpha);
        fan.graphics.lineBetween(x, y, x + direction.x * length, y + direction.y * length);
      }
    }
  }

  updateBlackHoleVisuals(time) {
    const radius = PIECES.blackhole.effectRadius;
    for (const hole of this.blackHoles) {
      hole.graphics.clear();
      const phase = (time * 0.055) % 28;
      for (let ring = 0; ring < 3; ring += 1) {
        const ringRadius = PIECES.blackhole.coreRadius + 18 + ((phase + ring * 24) % 72);
        const alpha = Math.max(0.08, 0.52 - ringRadius / 230);
        hole.graphics.lineStyle(4, ring % 2 ? 0xf0644b : 0x38b9b5, alpha);
        hole.graphics.strokeCircle(hole.x, hole.y, ringRadius);
      }
      hole.graphics.fillStyle(0x172b2c, 0.88);
      hole.graphics.fillCircle(hole.x, hole.y, PIECES.blackhole.coreRadius);
      hole.graphics.lineStyle(2, 0xd7f3ed, 0.1);
      hole.graphics.strokeCircle(hole.x, hole.y, radius);
    }
  }

  updatePortalVisuals(time) {
    for (const portal of this.portals) {
      portal.graphics.clear();
      const active = Boolean(portal.link);
      const color = active ? portal.pairColor : 0x71817f;
      const pulse = active
        ? 0.72 + Math.sin(time * 0.007 + Number(portal.pairIndex || 0)) * 0.16
        : 0.24;
      portal.graphics.lineStyle(5, color, pulse);
      portal.graphics.strokeCircle(portal.x, portal.y, PIECES.portal.triggerRadius);
      if (active) {
        const exit = portalExitPosition(portal, portal.mode);
        const { direction, requestedDirection } = exit;
        const side = { x: -direction.y, y: direction.x };
        const startX = portal.x + requestedDirection.x * 30;
        const startY = portal.y + requestedDirection.y * 30;
        portal.graphics.lineStyle(portal.mode === "solo" ? 8 : 7, color, 0.78);
        portal.graphics.lineBetween(startX, startY, exit.x, exit.y);
        portal.graphics.fillStyle(color, 0.92);
        portal.graphics.fillTriangle(
          exit.x,
          exit.y,
          exit.x - direction.x * 22 + side.x * 11,
          exit.y - direction.y * 22 + side.y * 11,
          exit.x - direction.x * 22 - side.x * 11,
          exit.y - direction.y * 22 - side.y * 11,
        );
        portal.graphics.lineStyle(3, color, 0.72);
        portal.graphics.strokeRect(
          exit.x - PLAYER_COLLISION_BOUNDS.left,
          exit.y - PLAYER_COLLISION_BOUNDS.top,
          PLAYER_COLLISION_BOUNDS.left + PLAYER_COLLISION_BOUNDS.right,
          PLAYER_COLLISION_BOUNDS.top + PLAYER_COLLISION_BOUNDS.bottom,
        );
      } else {
        portal.graphics.lineStyle(3, 0x71817f, 0.32);
        portal.graphics.strokeCircle(portal.x, portal.y, PIECES.portal.triggerRadius + 8);
      }
    }
  }

  updateConveyorVisuals(time) {
    const racing = this.roomState?.phase === "race";
    const elapsed = racing ? this.mechanismElapsed(time) : 0;
    const travelLength = PIECES.conveyor.width - 32;
    for (const conveyor of this.conveyors) {
      const direction = conveyorDirectionForRotation(conveyor.rotation);
      const side = { x: -direction.y, y: direction.x };
      const progress = racing
        ? mechanismCycle(elapsed, conveyor.placementIndex, 700) / 700
        : 0;
      conveyor.graphics.clear();
      conveyor.graphics.lineStyle(4, 0xfff4d8, racing ? 0.76 : 0.46);
      for (let marker = 0; marker < 4; marker += 1) {
        const along = -travelLength / 2 + ((marker / 4 + progress) % 1) * travelLength;
        const tipX = conveyor.x + direction.x * along;
        const tipY = conveyor.y + direction.y * along;
        const backX = tipX - direction.x * 13;
        const backY = tipY - direction.y * 13;
        conveyor.graphics.lineBetween(backX + side.x * 7, backY + side.y * 7, tipX, tipY);
        conveyor.graphics.lineBetween(backX - side.x * 7, backY - side.y * 7, tipX, tipY);
      }
    }
  }

  updateSawVisuals(time) {
    const racing = this.roomState?.phase === "race";
    const elapsed = racing ? this.mechanismElapsed(time) : 0;
    for (const saw of this.saws) {
      const spin = racing
        ? ((elapsed + saw.placementIndex * MECHANISM_STAGGER_MS) / PIECES.saw.spinPeriodMs) * 360
        : 0;
      saw.image.setAngle((saw.rotation || 0) + spin);
    }
  }

  updateCannonMechanisms(time, delta, local) {
    const racing = this.roomState?.phase === "race";
    const elapsed = racing ? this.mechanismElapsed(time) : 0;
    const piece = PIECES.cannon;
    for (const cannon of this.cannons) {
      cannon.graphics.clear();
      if (!racing) continue;
      const direction = forwardForRotation(cannon.rotation);
      const range = directionalRangeToBlocker(
        cannon.x,
        cannon.y,
        direction,
        piece.range,
        piece.projectileRadius,
        piece.muzzleOffset,
      );
      const startX = cannon.x + direction.x * piece.muzzleOffset;
      const startY = cannon.y + direction.y * piece.muzzleOffset;
      const cycle = mechanismCycle(elapsed, cannon.placementIndex, piece.periodMs);
      if (cycle < piece.warningMs) {
        const warningAlpha = 0.18 + (cycle / piece.warningMs) * 0.48;
        cannon.graphics.lineStyle(3, 0xf4c84a, warningAlpha);
        cannon.graphics.lineBetween(
          startX,
          startY,
          cannon.x + direction.x * range,
          cannon.y + direction.y * range,
        );
        continue;
      }
      const shotAge = cycle - piece.warningMs;
      const flightMs = ((range - piece.muzzleOffset) / piece.projectileSpeed) * 1_000;
      if (shotAge > flightMs) continue;
      const currentDistance = Math.min(
        range,
        piece.muzzleOffset + (shotAge / 1_000) * piece.projectileSpeed,
      );
      const previousAge = Math.max(0, shotAge - Math.max(0, Number(delta) || 0));
      const previousDistance = Math.min(
        range,
        piece.muzzleOffset + (previousAge / 1_000) * piece.projectileSpeed,
      );
      const currentX = cannon.x + direction.x * currentDistance;
      const currentY = cannon.y + direction.y * currentDistance;
      const previousX = cannon.x + direction.x * previousDistance;
      const previousY = cannon.y + direction.y * previousDistance;
      cannon.graphics.lineStyle(7, 0xf0644b, 0.34);
      cannon.graphics.lineBetween(previousX, previousY, currentX, currentY);
      cannon.graphics.fillStyle(0xfff4d8, 0.96);
      cannon.graphics.fillCircle(currentX, currentY, piece.projectileRadius);
      cannon.graphics.lineStyle(3, 0x243534, 0.9);
      cannon.graphics.strokeCircle(currentX, currentY, piece.projectileRadius);
      if (
        local?.body?.enable &&
        this.isLocalControllable() &&
        segmentHitsBody(
          local,
          previousX,
          previousY,
          currentX,
          currentY,
          piece.projectileRadius,
        )
      ) {
        this.killLocalPlayer("cannon");
      }
    }
  }

  updateLaserMechanisms(time, local) {
    const racing = this.roomState?.phase === "race";
    const elapsed = racing ? this.mechanismElapsed(time) : 0;
    const piece = PIECES.laser;
    for (const laser of this.lasers) {
      laser.graphics.clear();
      if (!racing) continue;
      const direction = forwardForRotation(laser.rotation);
      const side = { x: -direction.y, y: direction.x };
      const range = directionalRangeToBlocker(
        laser.x,
        laser.y,
        direction,
        piece.range,
        piece.beamWidth / 2,
        piece.muzzleOffset,
      );
      const startX = laser.x + direction.x * piece.muzzleOffset;
      const startY = laser.y + direction.y * piece.muzzleOffset;
      const endX = laser.x + direction.x * range;
      const endY = laser.y + direction.y * range;
      const cycle = mechanismCycle(elapsed, laser.placementIndex, piece.periodMs);
      if (cycle < piece.warningMs) {
        const pulse = 0.28 + Math.sin((cycle / piece.warningMs) * Math.PI * 5) * 0.16;
        laser.graphics.lineStyle(4, 0xf4c84a, pulse);
        laser.graphics.lineBetween(startX, startY, endX, endY);
        continue;
      }
      if (cycle >= piece.warningMs + piece.activeMs) continue;
      laser.graphics.lineStyle(piece.beamWidth + 10, 0xf0644b, 0.2);
      laser.graphics.lineBetween(startX, startY, endX, endY);
      laser.graphics.lineStyle(piece.beamWidth, 0xf0644b, 0.9);
      laser.graphics.lineBetween(startX, startY, endX, endY);
      laser.graphics.lineStyle(4, 0xfff4d8, 0.96);
      laser.graphics.lineBetween(startX, startY, endX, endY);
      if (!local?.body?.enable || !this.isLocalControllable()) continue;
      const dx = local.x - laser.x;
      const dy = local.y - laser.y;
      const forwardDistance = dx * direction.x + dy * direction.y;
      const lateralDistance = Math.abs(dx * side.x + dy * side.y);
      const forwardExtent = playerExtentAlong(local, direction);
      const lateralExtent = playerExtentAlong(local, side);
      if (
        forwardDistance + forwardExtent >= piece.muzzleOffset &&
        forwardDistance - forwardExtent <= range &&
        lateralDistance <= piece.beamWidth / 2 + lateralExtent
      ) {
        this.killLocalPlayer("laser");
      }
    }
  }

  updateBumperVisuals(time) {
    const racing = this.roomState?.phase === "race";
    const elapsed = racing ? this.mechanismElapsed(time) : 0;
    for (const bumper of this.bumpers) {
      bumper.graphics.clear();
      if (!racing) continue;
      const progress = mechanismCycle(elapsed, bumper.placementIndex, 1_100) / 1_100;
      const radius = PIECES.bumper.triggerRadius - 14 + progress * 14;
      bumper.graphics.lineStyle(4, 0x38b9b5, 0.5 * (1 - progress));
      bumper.graphics.strokeCircle(bumper.x, bumper.y, radius);
    }
  }

  applyFanForces(local, deltaMs) {
    const seconds = Phaser.Math.Clamp(deltaMs, 0, 40) / 1_000;
    for (const fan of this.fanEffects) {
      const direction = forwardForRotation(fan.rotation);
      const side = { x: -direction.y, y: direction.x };
      const dx = local.x - fan.x;
      const dy = local.y - fan.y;
      const forwardDistance = dx * direction.x + dy * direction.y;
      if (forwardDistance < PIECES.fan.height / 2 || forwardDistance > PIECES.fan.effectRange) continue;
      const lateralDistance = Math.abs(dx * side.x + dy * side.y);
      if (lateralDistance > PIECES.fan.effectWidth / 2) continue;
      const falloff = 1 - forwardDistance / PIECES.fan.effectRange;
      const impulse = PIECES.fan.force * (0.38 + falloff * 0.62) * seconds;
      local.setMaxVelocity(EFFECT_MAX_X_SPEED, EFFECT_MAX_Y_SPEED);
      local.body.velocity.x += direction.x * impulse;
      local.body.velocity.y += direction.y * impulse;
    }
  }

  applyBlackHoleForces(local, deltaMs) {
    const seconds = Phaser.Math.Clamp(deltaMs, 0, 40) / 1_000;
    for (const hole of this.blackHoles) {
      const dx = hole.x - local.x;
      const dy = hole.y - local.y;
      const distance = Math.hypot(dx, dy);
      if (distance > PIECES.blackhole.effectRadius) continue;
      if (distance <= PIECES.blackhole.coreRadius) {
        this.killLocalPlayer("blackhole");
        if (!local.body.enable) return;
      }
      if (distance < 1) continue;
      const falloff = 1 - distance / PIECES.blackhole.effectRadius;
      const impulse = PIECES.blackhole.force * (0.22 + falloff * falloff * 0.78) * seconds;
      local.setMaxVelocity(EFFECT_MAX_X_SPEED, EFFECT_MAX_Y_SPEED);
      local.body.velocity.x += (dx / distance) * impulse;
      local.body.velocity.y += (dy / distance) * impulse;
    }
  }

  isInsidePortal(local, portal, margin = 0) {
    return Phaser.Math.Distance.Between(local.x, local.y, portal.x, portal.y) <= PIECES.portal.triggerRadius + margin;
  }

  applyPortalTeleport(local, time) {
    if (!this.portals.length) return;
    if (this.portalExitLockId) {
      const lockedPortal = this.portals.find((portal) => portal.id === this.portalExitLockId);
      if (lockedPortal && this.isInsidePortal(local, lockedPortal, 10)) return;
      this.portalExitLockId = null;
    }
    if (time < this.portalCooldownUntil) return;
    const source = this.portals.find((portal) => portal.link && this.isInsidePortal(local, portal));
    if (!source) return;
    const exit = portalExitForLink(source.link);
    if (!exit) return;
    const { direction, x: exitX, y: exitY } = exit;
    local.setPosition(exitX, exitY);
    local.body.reset(exitX, exitY);
    local.setMaxVelocity(EFFECT_MAX_X_SPEED, EFFECT_MAX_Y_SPEED);
    local.setVelocity(direction.x * PIECES.portal.exitSpeed, direction.y * PIECES.portal.exitSpeed);
    if (direction.x !== 0) local.setFlipX(direction.x < 0);
    this.portalCooldownUntil = time + PIECES.portal.cooldownMs;
    this.portalExitLockId = exit.anchor?.id || source.id;
    this.effectSpeedUntil = Math.max(this.effectSpeedUntil, time + 240);
    this.bridge.onAudioEvent?.("portal");
    this.lastMotionAt = time;
    this.bridge.onLocalMotion?.({
      x: local.x,
      y: local.y,
      vx: local.body.velocity.x,
      vy: local.body.velocity.y,
      facing: local.flipX ? -1 : 1,
      snap: true,
      elapsedMs: this.mechanismElapsed(time),
    });
  }

  applySawHazards(local) {
    const body = local?.body;
    if (!body) return;
    for (const saw of this.saws) {
      const nearestX = Phaser.Math.Clamp(saw.x, body.x, body.right);
      const nearestY = Phaser.Math.Clamp(saw.y, body.y, body.bottom);
      if (Phaser.Math.Distance.Between(saw.x, saw.y, nearestX, nearestY) <= PIECES.saw.bladeRadius) {
        this.killLocalPlayer("saw");
        return;
      }
    }
  }

  applyBumperForces(local, time) {
    const inside = new Set();
    for (const bumper of this.bumpers) {
      const dx = local.x - bumper.x;
      const dy = local.y - bumper.y;
      const distance = Math.hypot(dx, dy);
      if (distance > PIECES.bumper.triggerRadius) continue;
      inside.add(bumper.id);
      if (this.bumperContacts.has(bumper.id)) continue;
      this.bumperContacts.add(bumper.id);
      const fallback = forwardForRotation(bumper.rotation);
      const normalX = distance > 1 ? dx / distance : fallback.x;
      const normalY = distance > 1 ? dy / distance : fallback.y;
      local.setMaxVelocity(900, EFFECT_MAX_Y_SPEED);
      local.setVelocity(
        normalX * PIECES.bumper.launchSpeed,
        normalY * PIECES.bumper.launchSpeed,
      );
      this.effectSpeedUntil = Math.max(this.effectSpeedUntil, time + PIECES.bumper.boostGraceMs);
      if (normalX !== 0) local.setFlipX(normalX < 0);
      this.lastMotionAt = time;
      this.bridge.onLocalMotion?.({
        x: local.x,
        y: local.y,
        vx: local.body.velocity.x,
        vy: local.body.velocity.y,
        facing: local.flipX ? -1 : 1,
        elapsedMs: this.mechanismElapsed(time),
      });
    }
    for (const bumperId of this.bumperContacts) {
      if (!inside.has(bumperId)) this.bumperContacts.delete(bumperId);
    }
  }

  pushLocalPlayer(local, conveyor) {
    if (!local?.body?.enable || !this.isLocalControllable()) return;
    this.conveyorContact = {
      direction: conveyorDirectionForRotation(conveyor.pieceRotation),
      until: this.time.now + PIECES.conveyor.contactGraceMs,
    };
  }

  applyConveyorForces(local, time, deltaMs) {
    const contact = this.conveyorContact;
    if (!contact || time > contact.until) {
      this.conveyorContact = null;
      return;
    }
    const velocity = local.body.velocity;
    const along = velocity.x * contact.direction.x + velocity.y * contact.direction.y;
    if (along >= PIECES.conveyor.speed) return;
    const seconds = Phaser.Math.Clamp(deltaMs, 0, 40) / 1_000;
    const boost = Math.min(
      PIECES.conveyor.acceleration * seconds,
      PIECES.conveyor.speed - along,
    );
    local.setMaxVelocity(EFFECT_MAX_X_SPEED, EFFECT_MAX_Y_SPEED);
    velocity.x += contact.direction.x * boost;
    velocity.y += contact.direction.y * boost;
  }

  applyLocalMechanisms(local, time, delta) {
    this.applySawHazards(local);
    if (!local.body.enable) return;
    this.applyBlackHoleForces(local, delta);
    if (!local.body.enable) return;
    this.applyPortalTeleport(local, time);
    if (!local.body.enable) return;
    this.applyBumperForces(local, time);
    if (!local.body.enable) return;
    this.applyFanForces(local, delta);
    if (!local.body.enable) return;
    this.applyConveyorForces(local, time, delta);
  }

  bounceLocalPlayer(local, spring) {
    if (!local?.body || !spring?.body) return;
    const rotation = ((Number(spring.pieceRotation) % 360) + 360) % 360;
    const touching = local.body.touching;
    const blocked = local.body.blocked;

    if (rotation === 0 && (touching.down || blocked.down)) {
      local.setVelocityY(-880);
      local.setAngle(-7);
    } else if (rotation === 90 && (touching.left || blocked.left)) {
      local.setVelocityX(880);
      local.setAngle(7);
    } else if (rotation === 180 && (touching.up || blocked.up)) {
      local.setVelocityY(880);
      local.setAngle(7);
    } else if (rotation === 270 && (touching.right || blocked.right)) {
      local.setVelocityX(-880);
      local.setAngle(-7);
    }
  }

  finishLocalPlayer() {
    if (this.finishSent || this.roomState?.phase !== "race") return;
    const local = this.playerSprites.get(this.myPlayerId)?.sprite;
    if (!local?.body?.enable) return;
    const accepted = this.bridge.onLocalFinish?.({
      x: local.x,
      y: local.y,
      vx: local.body.velocity.x,
      vy: local.body.velocity.y,
      facing: local.flipX ? -1 : 1,
      elapsedMs: this.mechanismElapsed(this.time.now),
    });
    if (accepted === false) return;
    this.finishSent = true;
    local.setCollideWorldBounds(true);
  }

  killLocalPlayer(reason) {
    if (this.deathSent || this.finishSent || this.roomState?.phase !== "race") return;
    const local = this.playerSprites.get(this.myPlayerId)?.sprite;
    if (!local?.body?.enable) return;
    if (this.bridge.onLocalDeath?.(reason) === false) return;
    this.deathSent = true;
    this.bridge.onAudioEvent?.("death");
    local.setVelocity(0, 0).setAlpha(0.35).setAngle(12);
    local.setDragX(PLAYER_DRAG_X);
    this.effectSpeedUntil = -Infinity;
    this.resetJumpState({ preserveHeld: true });
    local.body.enable = false;
  }

  isLocalControllable() {
    const me = this.roomState?.players.find((player) => player.id === this.myPlayerId);
    return (
      this.roomState?.phase === "race" &&
      ["racing", "finished"].includes(me?.status)
    );
  }

  update(time, delta) {
    if (!this.roomState) return;
    const local = this.playerSprites.get(this.myPlayerId)?.sprite;
    this.syncItemEffectVisuals();
    this.updateFogOverlay(local);
    this.updateMovingBarriers(time);
    this.updateFanVisuals(time);
    this.updateBlackHoleVisuals(time);
    this.updatePortalVisuals(time);
    this.updateConveyorVisuals(time);
    this.updateSawVisuals(time);
    this.updateCannonMechanisms(time, delta, local);
    this.updateLaserMechanisms(time, local);
    this.updateBumperVisuals(time);
    if (local?.body?.enable) {
      if (this.isLocalControllable()) {
        const selfEffect = this.activeItemEffect(this.myPlayerId, "self");
        const debuffEffect = this.activeItemEffect(this.myPlayerId, "debuff");
        const turbo = selfEffect?.type === "turbo";
        const jumpjet = selfEffect?.type === "jumpjet";
        const grip = selfEffect?.type === "grip";
        const slowed = debuffEffect?.type === "slow";
        const heavy = debuffEffect?.type === "gravity";
        const reversed = debuffEffect?.type === "reverse";
        const mechanismSpeedActive = time <= this.effectSpeedUntil || time <= this.conveyorContact?.until;
        let horizontalSpeedCap = mechanismSpeedActive ? 900 : turbo ? 470 : 330;
        if (slowed) horizontalSpeedCap *= 0.58;
        local.setMaxVelocity(horizontalSpeedCap, 1_100);
        local.setGravityY(heavy ? 900 : 0);
        const onIce = !grip && time <= this.iceContactUntil;
        local.setDragX(grip ? 2_300 : onIce ? PIECES.ice.dragX : PLAYER_DRAG_X);
        const rawLeft = this.cursors.left.isDown || this.keys.left.isDown || this.touch.left;
        const rawRight = this.cursors.right.isDown || this.keys.right.isDown || this.touch.right;
        const left = reversed ? rawRight : rawLeft;
        const right = reversed ? rawLeft : rawRight;
        const keyboardJumpDown = this.keyboardJumpDown();
        const jumpDown = keyboardJumpDown || this.touch.jump;
        const jumpPressed =
          this.consumeJumpPress() ||
          (!this.keyboardJumpEventsBound && keyboardJumpDown && !this.keyboardJumpWasDown);

        if (left === right) {
          local.setAccelerationX(0);
          if (!onIce && Math.abs(local.body.velocity.x) < 12) local.setVelocityX(0);
        } else {
          const direction = left ? -1 : 1;
          let acceleration = onIce ? PIECES.ice.acceleration : turbo ? 2_650 : grip ? 2_250 : 1_800;
          if (slowed) acceleration *= 0.62;
          local.setAccelerationX(direction * acceleration);
          local.setMaxVelocity(horizontalSpeedCap, 1_100);
          local.setFlipX(direction < 0);
        }

        const grounded = local.body.blocked.down || local.body.touching.down;
        const wallLeft = local.body.blocked.left || local.body.touching.left;
        const wallRight = local.body.blocked.right || local.body.touching.right;
        if (!grounded && this.wasGrounded && this.hasGroundContact) {
          this.airborneSince = time;
        }
        if (grounded) {
          const landedNow = !this.wasGrounded;
          if (landedNow) {
            this.groundJumpCommitted = false;
            this.airJumpsRemaining = AIR_JUMPS_PER_AIRTIME;
          }
          if (
            landedNow &&
            this.hasGroundContact &&
            time - this.airborneSince >= LAND_AUDIO_MIN_AIR_MS
          ) {
            this.bridge.onAudioEvent?.("land");
          }
          this.hasGroundContact = true;
          this.airborneSince = -Infinity;
          this.lastGroundedAt = time;
        }
        if (jumpPressed) this.jumpQueuedAt = time;

        const hasBufferedJump = time - this.jumpQueuedAt <= JUMP_BUFFER_MS;
        const canGroundJump =
          !this.groundJumpCommitted &&
          (grounded || time - this.lastGroundedAt <= COYOTE_MS);
        const jumpVelocity = (jumpjet ? -790 : -640) * (heavy ? 0.76 : 1);
        const wallJumpVelocity = (jumpjet ? -710 : -600) * (heavy ? 0.8 : 1);
        if (hasBufferedJump) {
          if (canGroundJump) {
            local.setVelocityY(jumpVelocity);
            this.bridge.onAudioEvent?.("jump");
            this.groundJumpCommitted = true;
            this.jumpQueuedAt = -Infinity;
            this.lastGroundedAt = -Infinity;
          } else if ((wallLeft || wallRight) && this.airJumpsRemaining > 0) {
            local.setVelocity(wallLeft ? 380 : -380, wallJumpVelocity);
            this.airJumpsRemaining -= 1;
            this.bridge.onAudioEvent?.("double_jump");
            this.jumpQueuedAt = -Infinity;
            this.lastGroundedAt = -Infinity;
          } else if (this.airJumpsRemaining > 0) {
            local.setVelocityY(jumpVelocity * AIR_JUMP_VELOCITY_FACTOR);
            this.airJumpsRemaining -= 1;
            this.bridge.onAudioEvent?.("double_jump");
            this.jumpQueuedAt = -Infinity;
            this.lastGroundedAt = -Infinity;
          }
        }
        this.keyboardJumpWasDown = keyboardJumpDown;
        this.jumpWasDown = jumpDown;
        this.touchJumpPressed = false;
        this.wasGrounded = grounded;
        local.setAngle(Phaser.Math.Clamp(local.body.velocity.x / 85, -7, 7));
        if (!grounded && Math.abs(local.body.velocity.y) > 40) local.setScale(0.68, 0.76);
        else if (Math.abs(local.body.velocity.x) > 45) local.setScale(0.74, 0.7);
        else local.setScale(0.72);
        this.applyLocalMechanisms(local, time, delta);

        if (local.y > WORLD.height + 90) this.killLocalPlayer("fall");

        if (time - this.lastMotionAt >= LOCAL_MOTION_INTERVAL_MS) {
          this.lastMotionAt = time;
          this.bridge.onLocalMotion?.({
            x: local.x,
            y: local.y,
            vx: local.body.velocity.x,
            vy: local.body.velocity.y,
            facing: local.flipX ? -1 : 1,
            elapsedMs: this.mechanismElapsed(time),
          });
        }
      } else {
        local.setAccelerationX(0);
        local.setGravityY(0);
        local.setDragX(PLAYER_DRAG_X);
        local.setScale(0.72);
        if (["build", "race_loading", "race_countdown"].includes(this.roomState.phase)) {
          const keyboardJumpDown = this.keyboardJumpDown();
          this.keyboardJumpWasDown = keyboardJumpDown;
          this.jumpWasDown = keyboardJumpDown || this.touch.jump;
          this.touchJumpPressed = false;
          local.setVelocity(0, 0);
        }
      }
    }

    this.updateRemotePlayers(delta);

    for (const entry of this.playerSprites.values()) {
      entry.label.setPosition(entry.sprite.x, entry.sprite.y - 58);
      (entry.effectIcons || []).forEach((icon, index) => {
        const offset = (index - (entry.effectIcons.length - 1) / 2) * 34;
        icon.setPosition(entry.sprite.x + offset, entry.sprite.y - 91);
      });
    }
  }
}
