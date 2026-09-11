import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import {
  ACTIVE_ITEMS,
  BASE_PLATFORMS,
  DEBUFF_IMMUNITY_MS,
  DRAFT_ITEMS,
  GAME,
  GOAL,
  PIECES,
  PLAYER_STYLES,
  SPAWN,
  WORLD,
} from "../shared/gameConfig.js";
import { dimensionsForPiece, validatePlacementSafety } from "../shared/placementRules.js";
import {
  createBotRaceRoute,
  routeDistance,
  sampleBotRaceRoute,
} from "./botRaceRoute.js";
import { resolveBombBlast } from "./bombLogic.js";
import {
  createRaceMotionGuard,
  isRaceFinishVerified,
  validateRaceMotion,
} from "./raceValidation.js";
import { createVoiceService } from "./voiceService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const distDir = join(projectRoot, "dist");
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "0.0.0.0";
const testTimers = process.env.GAME_TIMERS === "short";
const timing = {
  draftMs: testTimers ? 2_500 : 12_000,
  buildMs: testTimers ? 2_500 : GAME.buildTurnMs,
  raceLoadingMs: testTimers ? 1_000 : 5_000,
  raceCountdownMs: testTimers ? 700 : GAME.raceCountdownMs,
  raceMs: testTimers ? 7_000 : GAME.raceMs,
  resultsMs: testTimers ? 1_200 : GAME.resultsMs,
  reconnectGraceMs: testTimers ? 2_000 : GAME.reconnectGraceMs,
};

const forcedTestDraftChoices = process.env.NODE_ENV === "test"
  ? String(process.env.GAME_TEST_DRAFT_CHOICES || "")
      .split(",")
      .map((choice) => choice.trim())
      .filter((choice) => DRAFT_ITEMS[choice])
  : [];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"],
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, app: "zaolu-race", rooms: rooms.size, now: Date.now() });
});

if (existsSync(join(distDir, "index.html"))) {
  app.use(express.static(distDir));
  app.get(/^(?!\/socket\.io).*/, (_request, response) => {
    response.sendFile(join(distDir, "index.html"));
  });
}

const rooms = new Map();
const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pieceCycle = Object.keys(DRAFT_ITEMS);
const BOT_RUN_SPEED = 138;
const PLAYER_SPAWN_STEP_X = 44;
const PLAYER_SPAWN_STEP_Y = 8;
const BUILD_BLOCKER_WIDTH = 72;
const BUILD_BLOCKER_HEIGHT = 104;

function makeRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let index = 0; index < 5; index += 1) {
      code += roomAlphabet[crypto.randomInt(roomAlphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("room_code_exhausted");
}

function playerSpawnSlot(index = 0) {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return {
    x: SPAWN.x + safeIndex * PLAYER_SPAWN_STEP_X,
    y: SPAWN.y - safeIndex * PLAYER_SPAWN_STEP_Y,
  };
}

function playerSpawnSlotInRoom(room, player) {
  const index = [...room.players.keys()].indexOf(player.id);
  return playerSpawnSlot(index);
}

function sanitizeName(value) {
  const name = String(value || "").replace(/[<>]/g, "").trim().slice(0, 12);
  return name || "无名工友";
}

function createPlayer({ id, name, styleIndex, bot = false }) {
  return {
    id,
    name: sanitizeName(name),
    styleIndex,
    bot,
    connected: true,
    score: 0,
    status: "waiting",
    resumeToken: bot ? null : crypto.randomBytes(24).toString("base64url"),
    socketId: null,
    disconnectTimer: null,
    lastMotion: { x: SPAWN.x, y: SPAWN.y, vx: 0, vy: 0, facing: 1, at: 0 },
    motionGuard: null,
  };
}

function createRoom(host, { practice = false } = {}) {
  const code = makeRoomCode();
  const room = {
    code,
    revision: 0,
    mapRevision: 0,
    hostId: host.id,
    practice,
    phase: "lobby",
    phaseDeadline: null,
    round: 0,
    players: new Map([[host.id, host]]),
    placements: [],
    draft: null,
    build: null,
    race: null,
    lastRoundDeadPlayerIds: new Set(),
    processedActions: new Set(),
    timer: null,
    buildBotTimers: new Set(),
    botInterval: null,
    emptyTimer: null,
    earlyFinishTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    styleIndex: player.styleIndex,
    bot: player.bot,
    connected: player.connected,
    score: player.score,
    status: player.status,
  };
}

function snapshot(room) {
  return {
    serverNow: Date.now(),
    code: room.code,
    revision: room.revision,
    mapRevision: room.mapRevision,
    hostId: room.hostId,
    practice: room.practice,
    phase: room.phase,
    phaseDeadline: room.phaseDeadline,
    round: room.round,
    maxRounds: GAME.maxRounds,
    players: [...room.players.values()].map(publicPlayer),
    placements: room.placements,
    draft: room.draft
      ? {
          draftId: room.draft.draftId,
          choices: Object.fromEntries(
            Object.entries(room.draft.choices).map(([playerId, choices]) => [playerId, [...choices]]),
          ),
          picks: { ...room.draft.picks },
        }
      : null,
    build: room.build
      ? {
          buildId: room.build.buildId,
          participantIds: [...room.build.participantIds],
          decisions: { ...room.build.decisions },
          blockers: room.build.blockers.map((blocker) => ({ ...blocker })),
          equippedItems: { ...room.build.equippedItems },
          pieces: room.build.pieces,
          // Compatibility aliases for clients updating from sequential build turns.
          turnOrder: [...room.build.participantIds],
          turnIndex: Object.keys(room.build.decisions).length,
          turnId: room.build.buildId,
          activePlayerId: null,
        }
      : null,
    race: room.race
      ? {
          countdownAt: room.race.countdownAt,
          endsAt: room.race.endsAt,
          finishes: room.race.finishes,
          deaths: [...room.race.deaths],
          mapRevision: room.race.mapRevision,
          winnerIds: room.race.winnerIds || [],
          results: room.race.results || [],
          items: Object.fromEntries(
            Object.entries(room.race.items || {}).map(([playerId, item]) => [playerId, { ...item }]),
          ),
          effects: Object.fromEntries(
            Object.entries(room.race.effects || {}).map(([playerId, effects]) => [
              playerId,
              {
                self: effects.self ? { ...effects.self } : null,
                debuff: effects.debuff ? { ...effects.debuff } : null,
                immunityUntil: Number(effects.immunityUntil) || 0,
              },
            ]),
          ),
        }
      : null,
  };
}

function bump(room) {
  room.revision += 1;
}

function emitState(room) {
  io.to(room.code).emit("room:state", snapshot(room));
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
function clearEarlyFinishTimer(room) {
  if (room.earlyFinishTimer) clearTimeout(room.earlyFinishTimer);
  room.earlyFinishTimer = null;
}


function clearBotInterval(room) {
  if (room.botInterval) clearInterval(room.botInterval);
  room.botInterval = null;
}

function clearBuildBotTimers(room) {
  for (const timer of room.buildBotTimers) clearTimeout(timer);
  room.buildBotTimers.clear();
}

function scheduleBuildBot(room, callback, delay) {
  const timer = setTimeout(() => {
    room.buildBotTimers.delete(timer);
    if (rooms.get(room.code) === room) callback();
  }, Math.max(0, delay));
  room.buildBotTimers.add(timer);
}

function schedule(room, callback, delay) {
  clearTimer(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    if (rooms.get(room.code) === room) callback();
  }, Math.max(0, delay));
}

function ackReply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function errorReply(ack, errorCode, revision = null) {
  ackReply(ack, { ok: false, errorCode, revision });
}

function bindSocketToPlayer(socket, room, player) {
  const previousSocketId = player.socketId;
  player.socketId = socket.id;
  player.connected = true;
  if (previousSocketId && previousSocketId !== socket.id) {
    io.sockets.sockets.get(previousSocketId)?.disconnect(true);
  }
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
}

function restoreDisconnectedPlayerStatus(room, player) {
  if (player.status !== "disconnected") return;
  if (room.phase === "lobby") player.status = "waiting";
  else if (room.phase === "draft") {
    player.status = room.draft?.choices?.[player.id] ? "drafting" : "waiting";
  } else if (room.phase === "build") player.status = "building";
  else if (room.phase === "race_loading") player.status = "loading";
  else if (["race_countdown", "race"].includes(room.phase)) player.status = "racing";
}

function findAvailableStyle(room) {
  const used = new Set([...room.players.values()].map((player) => player.styleIndex));
  return PLAYER_STYLES.findIndex((_style, index) => !used.has(index));
}

function activeHumans(room) {
  return [...room.players.values()].filter((player) => !player.bot);
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((player) => player.bot || player.connected);
}

function setPhase(room, phase, deadline = null) {
  room.phase = phase;
  room.phaseDeadline = deadline;
  bump(room);
  emitState(room);
}

function draftChoicesFor(room, playerId) {
  const shuffled = [...pieceCycle];
  const seed = crypto
    .createHash("sha256")
    .update(`${room.code}:${room.round}:${playerId}`)
    .digest();
  for (let index = shuffled.length - 1, seedIndex = 0; index > 0; index -= 1, seedIndex += 1) {
    const swapIndex = seed[seedIndex % seed.length] % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const ordered = [
    ...forcedTestDraftChoices,
    ...shuffled.filter((choice) => !forcedTestDraftChoices.includes(choice)),
  ];
  return ordered.slice(0, Math.min(3, ordered.length));
}

function startGame(room) {
  clearTimer(room);
  clearBuildBotTimers(room);
  clearBotInterval(room);
  room.round = 0;
  room.placements = [];
  room.mapRevision = 0;
  room.draft = null;
  room.build = null;
  room.lastRoundDeadPlayerIds = new Set();
  room.race = null;
  room.processedActions.clear();
  for (const player of room.players.values()) {
    player.score = 0;
    player.status = "waiting";
  }
  startDraft(room);
}

function startDraft(room) {
  clearTimer(room);
  clearBuildBotTimers(room);
  clearBotInterval(room);
  room.round += 1;
  room.build = null;
  room.lastRoundDeadPlayerIds = new Set(room.race?.deaths || []);
  room.race = null;
  const participants = connectedPlayers(room);
  const choices = Object.fromEntries(
    participants.map((player) => [player.id, draftChoicesFor(room, player.id)]),
  );
  const picks = Object.fromEntries(
    participants
      .filter((player) => player.bot)
      .map((player) => [player.id, choices[player.id][0]]),
  );
  room.draft = {
    draftId: crypto.randomUUID(),
    choices,
    picks,
  };
  for (const player of room.players.values()) {
    player.status = player.bot || player.connected ? "drafting" : "disconnected";
  }
  setPhase(room, "draft", Date.now() + timing.draftMs);
  if (draftIsComplete(room)) {
    startBuild(room);
    return;
  }
  const draftId = room.draft.draftId;
  schedule(room, () => autoCompleteDraft(room, draftId), timing.draftMs);
}

function draftParticipantIds(room) {
  return Object.keys(room.draft?.choices || {});
}

function draftIsComplete(room) {
  if (!room.draft || room.phase !== "draft") return false;
  return draftParticipantIds(room).every((playerId) => Boolean(room.draft.picks[playerId]));
}

function autoPickDraftPlayer(room, playerId) {
  if (!room.draft || room.draft.picks[playerId]) return false;
  const firstChoice = room.draft.choices[playerId]?.[0];
  if (!firstChoice) return false;
  room.draft.picks[playerId] = firstChoice;
  return true;
}

function autoCompleteDraft(room, draftId) {
  if (room.phase !== "draft" || room.draft?.draftId !== draftId) return;
  for (const playerId of draftParticipantIds(room)) autoPickDraftPlayer(room, playerId);
  startBuild(room);
}

function buildPlayerBlockers(room) {
  return [...room.players.values()].flatMap((player, index) => {
    const motion = player.lastMotion;
    const hasRacePosition =
      Number(motion?.at) > 0 &&
      Number.isFinite(Number(motion?.x)) &&
      Number.isFinite(Number(motion?.y));
    const spawn = playerSpawnSlot(index);
    const x = hasRacePosition ? Number(motion.x) : spawn.x;
    const y = hasRacePosition ? Number(motion.y) : spawn.y;
    const blocksPlacement = !room.lastRoundDeadPlayerIds?.has(player.id);
    if (blocksPlacement && (x < 0 || x > WORLD.width || y < 0 || y > WORLD.height)) return [];
    return [
      {
        playerId: player.id,
        blocksPlacement,
        x,
        y,
        width: BUILD_BLOCKER_WIDTH,
        height: BUILD_BLOCKER_HEIGHT,
      },
    ];
  });
}

function startBuild(room) {
  clearTimer(room);
  clearBuildBotTimers(room);
  clearBotInterval(room);
  const draft = room.draft;
  const participantIds = draftParticipantIds(room).filter((playerId) => {
    const player = room.players.get(playerId);
    return Boolean(player);
  });
  const pieces = Object.fromEntries(
    participantIds.map((playerId) => [playerId, draft?.picks[playerId] || draft?.choices[playerId]?.[0]]),
  );
  const equippedItems = Object.fromEntries(
    participantIds.flatMap((playerId) =>
      ACTIVE_ITEMS[pieces[playerId]] ? [[playerId, pieces[playerId]]] : [],
    ),
  );
  room.draft = null;
  room.build = {
    buildId: crypto.randomUUID(),
    participantIds,
    pieces,
    decisions: Object.fromEntries(
      Object.keys(equippedItems).map((playerId) => [playerId, "equipped"]),
    ),
    equippedItems,
    blockers: buildPlayerBlockers(room),
    completing: false,
  };
  for (const player of room.players.values()) {
    player.status = player.bot || player.connected ? "building" : "disconnected";
  }
  beginBuildWindow(room);
}

function beginBuildWindow(room) {
  if (!room.build || room.build.participantIds.length === 0) {
    startRaceLoading(room);
    return;
  }

  const buildId = room.build.buildId;
  const deadline = Date.now() + timing.buildMs;
  room.phase = "build";
  room.phaseDeadline = deadline;
  bump(room);
  emitState(room);
  if (buildIsComplete(room)) {
    completeBuildWindow(room, buildId);
    return;
  }

  const bots = room.build.participantIds
    .map((playerId) => room.players.get(playerId))
    .filter((player) => player?.bot && !room.build.decisions[player.id]);
  for (const [index, bot] of bots.entries()) {
    scheduleBuildBot(
      room,
      () => autoPlaceBot(room, bot, buildId),
      (testTimers ? 120 : 650) + index * (testTimers ? 80 : 180),
    );
  }
  schedule(room, () => completeBuildWindow(room, buildId, { timedOut: true }), timing.buildMs);
}

function buildIsComplete(room) {
  if (!room.build || room.phase !== "build") return false;
  return room.build.participantIds.every((playerId) => Boolean(room.build.decisions[playerId]));
}

function completeBuildWindow(room, buildId, { timedOut = false } = {}) {
  if (
    room.phase !== "build" ||
    !room.build ||
    room.build.buildId !== buildId ||
    room.build.completing
  ) return false;
  if (!timedOut && !buildIsComplete(room)) return false;

  room.build.completing = true;
  clearBuildBotTimers(room);
  startRaceLoading(room);
  return true;
}

function publishBuildDecision(room, playerId, decision) {
  room.build.decisions[playerId] = decision;
  bump(room);
  emitState(room);
}

function normalizeRotation(type, value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return null;
  const normalized = ((numeric % 360) + 360) % 360;
  if (normalized % 90 !== 0) return null;
  if (!PIECES[type]?.rotatable && normalized !== 0) return null;
  return normalized;
}

function validatePlacement(room, placement, expectedType) {
  const type = String(placement?.type || "");
  const rotation = normalizeRotation(type, placement?.rotation);
  const x = Math.round(Number(placement?.x) / WORLD.grid) * WORLD.grid;
  const y = Math.round(Number(placement?.y) / WORLD.grid) * WORLD.grid;
  const dimensions = rotation === null ? null : dimensionsForPiece(type, rotation);
  if (!dimensions || type !== expectedType || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, errorCode: "invalid_piece" };
  }
  const normalized = { type, rotation, x, y, ...dimensions };
  if (x < 0 || x > WORLD.width || y < 0 || y > WORLD.height) {
    return { ok: false, errorCode: "out_of_bounds" };
  }
  const safetyError = validatePlacementSafety(
    normalized,
    room.placements,
    room.build?.blockers || [],
  );
  if (safetyError) return { ok: false, errorCode: safetyError };
  return { ok: true, placement: normalized };
}

function autoPlaceBot(room, bot, buildId) {
  if (
    room.phase !== "build" ||
    room.build?.buildId !== buildId ||
    !room.build.participantIds.includes(bot.id) ||
    room.build.decisions[bot.id]
  ) return;
  const type = room.build.pieces[bot.id];
  if (!PIECES[type]) return;
  const candidates = [
    { x: 400, y: 400 },
    { x: 600, y: 480 },
    { x: 800, y: 400 },
    { x: 1000, y: 440 },
    { x: 1200, y: 360 },
    { x: 720, y: 240 },
  ];
  const participantIndex = room.build.participantIds.indexOf(bot.id);
  const startIndex = (room.round * 2 + participantIndex) % candidates.length;
  let chosen = null;
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const candidate = candidates[(startIndex + offset) % candidates.length];
    const result = validatePlacement(room, { ...candidate, type, rotation: 0 }, type);
    if (result.ok) {
      chosen = result.placement;
      break;
    }
  }
  if (chosen) {
    room.placements.push({
      ...chosen,
      id: crypto.randomUUID(),
      ownerId: bot.id,
      round: room.round,
    });
    room.mapRevision += 1;
  }
  publishBuildDecision(room, bot.id, chosen ? "placed" : "skipped");
  completeBuildWindow(room, buildId);
}

function startRaceLoading(room) {
  clearTimer(room);
  clearBuildBotTimers(room);
  const equippedItems = { ...(room.build?.equippedItems || {}) };
  room.build = null;
  room.race = {
    ready: new Set([...room.players.values()].filter((player) => player.bot).map((player) => player.id)),
    countdownAt: null,
    endsAt: null,
    finishes: [],
    deaths: new Set(),
    mapRevision: room.mapRevision,
    results: [],
    items: Object.fromEntries(
      Object.entries(equippedItems).map(([playerId, type]) => [
        playerId,
        { type, usedAt: null, targetPlayerId: null },
      ]),
    ),
    effects: Object.fromEntries(
      [...room.players.keys()].map((playerId) => [
        playerId,
        { self: null, debuff: null, immunityUntil: 0 },
      ]),
    ),
    itemCooldowns: {},
  };
  for (const [index, player] of [...room.players.values()].entries()) {
    const spawn = playerSpawnSlot(index);
    player.status = player.connected || player.bot ? "loading" : "disconnected";
    player.lastMotion = { ...spawn, vx: 0, vy: 0, facing: 1, at: 0 };
    player.motionGuard = null;
  }
  setPhase(room, "race_loading", Date.now() + timing.raceLoadingMs);
  schedule(room, () => startRaceCountdown(room), timing.raceLoadingMs);
}

function allRacePlayersReady(room) {
  const required = connectedPlayers(room);
  return required.length > 0 && required.every((player) => room.race?.ready.has(player.id));
}

function resetPlayerRaceMotionGuard(room, player, now = Date.now()) {
  const countdownAt = Number(room.race?.countdownAt);
  const elapsedMs = Number.isFinite(countdownAt) ? Math.max(0, now - countdownAt) : 0;
  const hasAuthoritativeMotion =
    Number.isFinite(Number(player.lastMotion?.x)) &&
    Number.isFinite(Number(player.lastMotion?.y));
  const anchor = hasAuthoritativeMotion
    ? player.lastMotion
    : playerSpawnSlotInRoom(room, player);
  player.motionGuard = createRaceMotionGuard(elapsedMs);
  player.lastMotion = {
    ...anchor,
    vx: Number(anchor.vx) || 0,
    vy: Number(anchor.vy) || 0,
    facing: Number(anchor.facing) < 0 ? -1 : 1,
    elapsedMs,
    snap: false,
    at: now,
  };
}

function emitRaceCorrection(socket, room, player, reason, now = Date.now()) {
  if (!player.motionGuard) return;
  if (now - Number(player.motionGuard.lastCorrectionAt || 0) < 250) return;
  player.motionGuard.lastCorrectionAt = now;
  socket.emit("race:correction", {
    round: room.round,
    mapRevision: room.race?.mapRevision,
    reason,
    ...player.lastMotion,
  });
}

function startRaceCountdown(room) {
  if (!room.race || !["race_loading", "race_countdown"].includes(room.phase)) return;
  clearTimer(room);
  const countdownAt = Date.now() + timing.raceCountdownMs;
  room.race.countdownAt = countdownAt;
  room.race.endsAt = countdownAt + timing.raceMs;
  for (const [index, player] of [...room.players.values()].entries()) {
    const spawn = playerSpawnSlot(index);
    player.status = player.connected || player.bot ? "racing" : "disconnected";
    player.lastMotion = {
      ...spawn,
      vx: 0,
      vy: 0,
      facing: 1,
      snap: false,
      elapsedMs: 0,
      at: countdownAt,
    };
    player.motionGuard = createRaceMotionGuard();
  }
  setPhase(room, "race_countdown", countdownAt);
  schedule(room, () => {
    setPhase(room, "race", room.race.endsAt);
    scheduleBotItemUses(room);
    startBots(room);
    schedule(room, () => finishRace(room), timing.raceMs);
  }, timing.raceCountdownMs);
}

function startBots(room) {
  const bots = [...room.players.values()].filter((player) => player.bot && player.status === "racing");
  if (!bots.length) return;
  const startedAt = Date.now();
  const routes = new Map(bots.map((bot) => [
    bot.id,
    createBotRaceRoute(BASE_PLATFORMS, bot.lastMotion),
  ]));
  const distance = Math.max(...[...routes.values()].map((route) => routeDistance(route)));
  const duration = testTimers ? 3_200 : (distance / BOT_RUN_SPEED) * 1_000 + room.round * 350;
  clearBotInterval(room);
  room.botInterval = setInterval(() => {
    if (room.phase !== "race") {
      clearBotInterval(room);
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    for (const bot of bots) {
      if (bot.status !== "racing") continue;
      const now = Date.now();
      const route = routes.get(bot.id);
      const motion = sampleBotRaceRoute(route, progress, duration);
      bot.lastMotion = {
        ...motion,
        facing: motion.vx < 0 ? -1 : 1,
        snap: false,
        elapsedMs: Math.max(0, now - Number(room.race?.countdownAt || now)),
        at: now,
      };
      io.to(room.code).volatile.emit("race:peer", { playerId: bot.id, ...bot.lastMotion });
    }
    if (progress >= 1) {
      for (const bot of bots) recordFinish(room, bot, `bot-${room.round}`);
      clearBotInterval(room);
    }
  }, 100);
}

function actionKey(playerId, actionId) {
  return `${playerId}:${String(actionId || "")}`;
}

function hasProcessedAction(room, playerId, actionId) {
  return Boolean(actionId) && room.processedActions.has(actionKey(playerId, actionId));
}

function recordAction(room, playerId, actionId) {
  const key = actionKey(playerId, actionId);
  if (!actionId || room.processedActions.has(key)) return false;
  room.processedActions.add(key);
  if (room.processedActions.size > 1_000) {
    room.processedActions = new Set([...room.processedActions].slice(-500));
  }
  return true;
}

function activeEffect(effect, now = Date.now()) {
  return Boolean(effect && Number(effect.startedAt) <= now && Number(effect.endsAt) > now);
}

function ensurePlayerEffects(room, playerId) {
  if (!room.race.effects[playerId]) {
    room.race.effects[playerId] = { self: null, debuff: null, immunityUntil: 0 };
  }
  return room.race.effects[playerId];
}

function validateItemUse(room, player, targetPlayerId = null, requestedType = null) {
  if (!room.race || room.phase !== "race" || player.status !== "racing") {
    return { ok: false, errorCode: "invalid_phase" };
  }
  const item = room.race.items?.[player.id];
  const config = ACTIVE_ITEMS[item?.type];
  if (!item || !config) return { ok: false, errorCode: "no_item" };
  if (requestedType && requestedType !== item.type) {
    return { ok: false, errorCode: "stale_item" };
  }
  if (item.usedAt) return { ok: false, errorCode: "item_used" };
  const now = Date.now();
  if (Number(room.race.itemCooldowns?.[player.id]) > now) {
    return { ok: false, errorCode: "item_cooldown" };
  }

  if (config.kind === "self_instant") {
    if (item.type !== "bomb") return { ok: false, errorCode: "invalid_item" };
    const x = Number(player.lastMotion?.x);
    const y = Number(player.lastMotion?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, errorCode: "position_unavailable" };
    }
    return { ok: true, item, config, target: player, effects: null, now };
  }

  if (config.kind === "self_buff") {
    const effects = ensurePlayerEffects(room, player.id);
    if (activeEffect(effects.self, now) && effects.self.type === item.type) {
      return { ok: false, errorCode: "effect_active" };
    }
    return { ok: true, item, config, target: player, effects, now };
  }

  if (config.kind !== "target_debuff") {
    return { ok: false, errorCode: "invalid_item" };
  }

  const target = room.players.get(String(targetPlayerId || ""));
  if (!target || target.id === player.id) return { ok: false, errorCode: "invalid_target" };
  if (target.status !== "racing" || (!target.bot && !target.connected)) {
    return { ok: false, errorCode: "target_unavailable" };
  }
  const effects = ensurePlayerEffects(room, target.id);
  if (activeEffect(effects.self, now) && effects.self.type === "shield") {
    return { ok: false, errorCode: "target_shielded" };
  }
  if (activeEffect(effects.debuff, now)) {
    return { ok: false, errorCode: "target_debuff_active" };
  }
  const immunityUntil = Math.max(
    Number(effects.immunityUntil) || 0,
    Number(effects.debuff?.endsAt) + DEBUFF_IMMUNITY_MS || 0,
  );
  if (immunityUntil > now) return { ok: false, errorCode: "target_immune" };
  return { ok: true, item, config, target, effects, now };
}

function applyItemUse(room, player, { targetPlayerId = null, requestedType = null, actionId }) {
  const validation = validateItemUse(room, player, targetPlayerId, requestedType);
  if (!validation.ok) return validation;
  if (!recordAction(room, player.id, actionId)) {
    return { ok: false, errorCode: "duplicate_action" };
  }

  const { item, config, target, effects, now } = validation;
  if (config.kind === "self_instant" && item.type === "bomb") {
    const { x, y } = player.lastMotion;
    const resolved = resolveBombBlast(room.placements, { x, y, radius: config.radius });
    if (resolved.removedPlacementIds.length > 0) {
      room.placements = resolved.placements;
      room.mapRevision += 1;
      room.race.mapRevision = room.mapRevision;
    }
    const effect = {
      type: item.type,
      sourcePlayerId: player.id,
      targetPlayerId: player.id,
      startedAt: now,
      endsAt: now,
    };
    item.usedAt = now;
    item.targetPlayerId = player.id;
    room.race.itemCooldowns[player.id] = now + config.cooldownMs;
    const blast = {
      sourcePlayerId: player.id,
      x,
      y,
      radius: config.radius,
      removedPlacementIds: resolved.removedPlacementIds,
      placements: room.placements.map((placement) => ({ ...placement })),
      mapRevision: room.mapRevision,
      serverTime: now,
    };
    bump(room);
    emitState(room);
    io.to(room.code).emit("bomb:blast", blast);
    io.to(room.code).emit("item:used", effect);
    return {
      ok: true,
      effect,
      blast,
      revision: room.revision,
      mapRevision: room.mapRevision,
    };
  }

  const effect = {
    type: item.type,
    sourcePlayerId: player.id,
    targetPlayerId: target.id,
    startedAt: now,
    endsAt: now + config.durationMs,
  };
  if (config.kind === "self_buff") {
    if (item.type === "shield" && activeEffect(effects.debuff, now)) {
      effects.debuff = null;
      effects.immunityUntil = Math.max(Number(effects.immunityUntil) || 0, now + DEBUFF_IMMUNITY_MS);
    }
    effects.self = effect;
  } else {
    effects.debuff = effect;
    effects.immunityUntil = effect.endsAt + DEBUFF_IMMUNITY_MS;
  }
  item.usedAt = now;
  item.targetPlayerId = target.id;
  room.race.itemCooldowns[player.id] = now + config.cooldownMs;
  bump(room);
  emitState(room);
  io.to(room.code).emit("item:used", effect);
  return { ok: true, effect, revision: room.revision };
}

function scheduleBotItemUses(room) {
  const bots = [...room.players.values()].filter(
    (player) => player.bot && player.status === "racing" && room.race?.items?.[player.id],
  );
  bots.forEach((bot, index) => {
    scheduleBuildBot(room, () => {
      if (room.phase !== "race" || bot.status !== "racing") return;
      const item = room.race.items[bot.id];
      const config = ACTIVE_ITEMS[item?.type];
      if (!config || item.usedAt) return;
      const target = config.kind === "target_debuff"
        ? [...room.players.values()].find((candidate) => candidate.id !== bot.id && candidate.status === "racing")
        : bot;
      if (!target) return;
      applyItemUse(room, bot, {
        targetPlayerId: target.id,
        requestedType: item.type,
        actionId: `bot-item-${room.round}-${bot.id}`,
      });
    }, (testTimers ? 450 : 1_300) + index * 260);
  });
}

function recordFinish(room, player, actionId) {
  if (room.phase !== "race" || player.status !== "racing") return false;
  if (!recordAction(room, player.id, actionId)) return false;
  player.status = "finished";
  room.race.finishes.push({ playerId: player.id, at: Date.now() });
  bump(room);
  emitState(room);
  maybeFinishRace(room);
  return true;
}

function maybeFinishRace(room) {
  const contenders = [...room.players.values()].filter((player) => player.bot || player.connected);
  if (contenders.length && contenders.every((player) => ["finished", "dead"].includes(player.status))) {
    if (room.earlyFinishTimer) return;
    room.earlyFinishTimer = setTimeout(() => {
      room.earlyFinishTimer = null;
      if (rooms.get(room.code) !== room || room.phase !== "race") return;
      const currentContenders = [...room.players.values()].filter(
        (player) => player.bot || player.connected,
      );
      if (
        currentContenders.length &&
        currentContenders.every((player) => ["finished", "dead"].includes(player.status))
      ) {
        finishRace(room);
      }
    }, 600);
  }
}

function enterGameover(room) {
  const topScore = Math.max(0, ...[...room.players.values()].map((player) => player.score));
  room.phase = "gameover";
  room.phaseDeadline = null;
  room.race.winnerIds = [...room.players.values()]
    .filter((player) => player.score === topScore)
    .map((player) => player.id);
  bump(room);
  emitState(room);
}

function finishRace(room) {
  clearEarlyFinishTimer(room);
  if (!room.race || !["race", "race_countdown"].includes(room.phase)) return;
  clearTimer(room);
  clearBotInterval(room);
  const finishRanks = new Map(
    room.race.finishes.map((finish, index) => [finish.playerId, index + 1]),
  );
  const onlyFinisher = finishRanks.size === 1;
  room.race.results = [...room.players.values()].map((player) => {
    const rank = finishRanks.get(player.id) || null;
    const pointsDelta = rank ? 2 + (onlyFinisher ? 1 : 0) : 0;
    player.score += pointsDelta;
    let outcome = "timed_out";
    if (rank) outcome = "finished";
    else if (room.race.deaths.has(player.id) || player.status === "dead") outcome = "dead";
    else if (!player.bot && !player.connected) outcome = "disconnected";
    return {
      playerId: player.id,
      outcome,
      rank,
      pointsDelta,
      totalScore: player.score,
    };
  });
  for (const player of room.players.values()) {
    if (player.status === "racing") player.status = "timed_out";
  }
  const shouldEnd = room.round >= GAME.maxRounds;
  setPhase(room, "results", Date.now() + timing.resultsMs);
  schedule(room, () => {
    if (shouldEnd) enterGameover(room);
    else startDraft(room);
  }, timing.resultsMs);
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || player.bot) return;
  voiceService.cleanupPlayer(room.code, playerId, "player_removed");
  room.players.delete(playerId);
  let draftCompleted = false;
  if (room.phase === "draft" && room.draft?.choices[playerId]) {
    delete room.draft.choices[playerId];
    delete room.draft.picks[playerId];
    draftCompleted = draftIsComplete(room);
  }
  if (room.build) {
    room.build.participantIds = room.build.participantIds.filter((id) => id !== playerId);
    delete room.build.pieces[playerId];
    delete room.build.decisions[playerId];
    delete room.build.equippedItems[playerId];
    room.build.blockers = room.build.blockers.filter((blocker) => blocker.playerId !== playerId);
  }
  if (room.race) {
    delete room.race.items?.[playerId];
    delete room.race.effects?.[playerId];
    delete room.race.itemCooldowns?.[playerId];
  }
  if (room.hostId === playerId) {
    room.hostId = activeHumans(room).find((candidate) => candidate.connected)?.id || activeHumans(room)[0]?.id || null;
  }
  const buildCompleted = room.phase === "build" && buildIsComplete(room);
  if (draftCompleted) startBuild(room);
  else if (buildCompleted) completeBuildWindow(room, room.build.buildId);
  else {
    bump(room);
    emitState(room);
  }
  if (room.phase === "race") maybeFinishRace(room);
  if (!activeHumans(room).length) destroyRoomLater(room);
}

function destroyRoomLater(room) {
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    if (!activeHumans(room).some((player) => player.connected)) {
      clearEarlyFinishTimer(room);
      clearTimer(room);
      clearBuildBotTimers(room);
      clearBotInterval(room);
      rooms.delete(room.code);
      voiceService.cleanupRoom(room.code, "room_destroyed");
    }
    room.emptyTimer = null;
  }, timing.reconnectGraceMs);
}

function getBoundRoom(socket) {
  return rooms.get(socket.data.roomCode);
}

function getBoundPlayer(socket, room) {
  return room?.players.get(socket.data.playerId);
}

const voiceService = createVoiceService({
  io,
  getBoundRoom,
  getBoundPlayer,
});

function ensureRevision(room, expectedRevision) {
  return Number(expectedRevision) === room.revision;
}

io.on("connection", (socket) => {
  voiceService.bindSocket(socket);
  socket.on("time:sync", (_payload = {}, ack) => {
    ackReply(ack, { serverNow: Date.now() });
  });

  socket.on("room:create", (payload = {}, ack) => {
    const boundRoom = getBoundRoom(socket);
    if (boundRoom) return errorReply(ack, "already_in_room", boundRoom.revision);
    const clientId = String(payload.clientId || crypto.randomUUID()).slice(0, 80);
    const host = createPlayer({ id: clientId, name: payload.name, styleIndex: 0 });
    const room = createRoom(host);
    host.socketId = socket.id;
    bindSocketToPlayer(socket, room, host);
    bump(room);
    emitState(room);
    ackReply(ack, {
      ok: true,
      code: room.code,
      playerId: host.id,
      resumeToken: host.resumeToken,
      revision: room.revision,
      snapshot: snapshot(room),
    });
  });

  socket.on("room:practice", (payload = {}, ack) => {
    const boundRoom = getBoundRoom(socket);
    if (boundRoom) return errorReply(ack, "already_in_room", boundRoom.revision);
    const clientId = String(payload.clientId || crypto.randomUUID()).slice(0, 80);
    const host = createPlayer({ id: clientId, name: payload.name, styleIndex: 0 });
    const room = createRoom(host, { practice: true });
    const bot = createPlayer({ id: `bot-${crypto.randomUUID()}`, name: "扳手阿零", styleIndex: 1, bot: true });
    room.players.set(bot.id, bot);
    bindSocketToPlayer(socket, room, host);
    bump(room);
    emitState(room);
    ackReply(ack, {
      ok: true,
      code: room.code,
      playerId: host.id,
      resumeToken: host.resumeToken,
      revision: room.revision,
      snapshot: snapshot(room),
    });
    setTimeout(() => startGame(room), 400);
  });

  socket.on("room:join", (payload = {}, ack) => {
    const boundRoom = getBoundRoom(socket);
    if (boundRoom) return errorReply(ack, "already_in_room", boundRoom.revision);
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return errorReply(ack, "room_not_found");
    if (room.phase !== "lobby") return errorReply(ack, "game_in_progress", room.revision);
    if (activeHumans(room).length >= GAME.maxPlayers) return errorReply(ack, "room_full", room.revision);
    const clientId = String(payload.clientId || crypto.randomUUID()).slice(0, 80);
    if (room.players.has(clientId)) return errorReply(ack, "identity_in_use", room.revision);
    const styleIndex = findAvailableStyle(room);
    const player = createPlayer({ id: clientId, name: payload.name, styleIndex: Math.max(0, styleIndex) });
    room.players.set(player.id, player);
    bindSocketToPlayer(socket, room, player);
    bump(room);
    emitState(room);
    ackReply(ack, {
      ok: true,
      code,
      playerId: player.id,
      resumeToken: player.resumeToken,
      revision: room.revision,
      snapshot: snapshot(room),
    });
  });

  socket.on("room:resume", (payload = {}, ack) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    const playerId = String(payload.playerId || "");
    const player = room?.players.get(playerId);
    if (!room || !player || player.bot || player.resumeToken !== payload.resumeToken) {
      return errorReply(ack, "resume_denied", room?.revision ?? null);
    }
    const boundRoom = getBoundRoom(socket);
    if (boundRoom && (boundRoom.code !== room.code || socket.data.playerId !== playerId)) {
      return errorReply(ack, "already_in_room", boundRoom.revision);
    }
    bindSocketToPlayer(socket, room, player);
    restoreDisconnectedPlayerStatus(room, player);
    if (room.race && ["race_countdown", "race"].includes(room.phase)) {
      resetPlayerRaceMotionGuard(room, player);
    }
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    bump(room);
    emitState(room);
    ackReply(ack, {
      ok: true,
      snapshot: snapshot(room),
      revision: room.revision,
      selfMotion: { ...player.lastMotion },
    });
  });

  socket.on("room:leave", (_payload, ack) => {
    const room = getBoundRoom(socket);
    const playerId = socket.data.playerId;
    if (room && playerId) removePlayer(room, playerId);
    socket.leave(socket.data.roomCode || "");
    socket.data.roomCode = null;
    socket.data.playerId = null;
    ackReply(ack, { ok: true });
  });

  socket.on("game:start", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    if (!room) return errorReply(ack, "room_not_found");
    if (room.hostId !== socket.data.playerId) return errorReply(ack, "host_only", room.revision);
    if (room.phase !== "lobby") return errorReply(ack, "invalid_phase", room.revision);
    if (activeHumans(room).length < GAME.minPlayers) return errorReply(ack, "not_enough_players", room.revision);
    if (!ensureRevision(room, payload.expectedRevision)) return errorReply(ack, "stale_state", room.revision);
    startGame(room);
    ackReply(ack, { ok: true, revision: room.revision });
  });

  socket.on("draft:pick", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player) return errorReply(ack, "room_not_found", room?.revision ?? null);
    if (hasProcessedAction(room, player.id, payload.actionId)) {
      return ackReply(ack, { ok: true, duplicate: true, revision: room.revision });
    }
    if (room.phase !== "draft" || !room.draft) {
      return errorReply(ack, "invalid_phase", room.revision);
    }
    if (payload.round !== room.round || payload.draftId !== room.draft.draftId) {
      return errorReply(ack, "stale_draft", room.revision);
    }
    const choices = room.draft.choices[player.id];
    if (!choices) return errorReply(ack, "not_a_participant", room.revision);
    const pieceType = String(payload.pieceType || "");
    if (!choices.includes(pieceType)) return errorReply(ack, "invalid_piece", room.revision);
    if (room.draft.picks[player.id]) return errorReply(ack, "already_picked", room.revision);
    if (!recordAction(room, player.id, payload.actionId)) {
      return errorReply(ack, "duplicate_action", room.revision);
    }
    room.draft.picks[player.id] = pieceType;
    if (draftIsComplete(room)) startBuild(room);
    else {
      bump(room);
      emitState(room);
    }
    ackReply(ack, { ok: true, revision: room.revision });
  });

  socket.on("build:place", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player) return errorReply(ack, "room_not_found", room?.revision ?? null);
    if (hasProcessedAction(room, player.id, payload.actionId)) {
      return ackReply(ack, { ok: true, duplicate: true, revision: room.revision });
    }
    if (room.phase !== "build" || !room.build) return errorReply(ack, "invalid_phase", room.revision);
    const buildId = String(payload.buildId || payload.turnId || "");
    if (payload.round !== room.round || buildId !== room.build.buildId) {
      return errorReply(ack, "stale_build", room.revision);
    }
    if (!room.build.participantIds.includes(player.id)) {
      return errorReply(ack, "not_a_participant", room.revision);
    }
    if (room.build.decisions[player.id]) return errorReply(ack, "already_decided", room.revision);

    const result = validatePlacement(room, payload.placement, room.build.pieces[player.id]);
    if (!result.ok) return errorReply(ack, result.errorCode, room.revision);
    if (!recordAction(room, player.id, payload.actionId)) {
      return errorReply(ack, "duplicate_action", room.revision);
    }
    room.placements.push({
      ...result.placement,
      id: crypto.randomUUID(),
      ownerId: player.id,
      round: room.round,
    });
    room.mapRevision += 1;
    publishBuildDecision(room, player.id, "placed");
    ackReply(ack, { ok: true, revision: room.revision });
    completeBuildWindow(room, buildId);
  });

  socket.on("build:skip", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player) return errorReply(ack, "room_not_found", room?.revision ?? null);
    if (hasProcessedAction(room, player.id, payload.actionId)) {
      return ackReply(ack, { ok: true, duplicate: true, revision: room.revision });
    }
    if (room.phase !== "build" || !room.build) return errorReply(ack, "invalid_phase", room.revision);
    const buildId = String(payload.buildId || payload.turnId || "");
    if (payload.round !== room.round || buildId !== room.build.buildId) {
      return errorReply(ack, "stale_build", room.revision);
    }
    if (!room.build.participantIds.includes(player.id)) {
      return errorReply(ack, "not_a_participant", room.revision);
    }
    if (room.build.decisions[player.id]) return errorReply(ack, "already_decided", room.revision);
    if (!recordAction(room, player.id, payload.actionId)) {
      return errorReply(ack, "duplicate_action", room.revision);
    }
    publishBuildDecision(room, player.id, "skipped");
    ackReply(ack, { ok: true, revision: room.revision });
    completeBuildWindow(room, buildId);
  });

  socket.on("item:use", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player) return errorReply(ack, "room_not_found", room?.revision ?? null);
    if (hasProcessedAction(room, player.id, payload.actionId)) {
      const item = room.race?.items?.[player.id];
      return ackReply(ack, {
        ok: true,
        duplicate: true,
        revision: room.revision,
        mapRevision: room.mapRevision,
        usedAt: item?.usedAt || null,
        targetPlayerId: item?.targetPlayerId || null,
      });
    }
    if (!room.race || room.phase !== "race") {
      return errorReply(ack, "invalid_phase", room.revision);
    }
    if (Number(payload.round) !== room.round) {
      return errorReply(ack, "stale_item", room.revision);
    }
    const result = applyItemUse(room, player, {
      targetPlayerId: payload.targetPlayerId,
      requestedType: String(payload.itemType || ""),
      actionId: payload.actionId,
    });
    if (!result.ok) return errorReply(ack, result.errorCode, room.revision);
    ackReply(ack, {
      ok: true,
      revision: room.revision,
      usedAt: result.effect.startedAt,
      endsAt: result.effect.endsAt,
      mapRevision: result.mapRevision ?? room.mapRevision,
      removedPlacementIds: result.blast?.removedPlacementIds || [],
      blast: result.blast || null,
      targetPlayerId: result.effect.targetPlayerId,
    });
  });

  socket.on("race:ready", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    if (!room?.race || room.phase !== "race_loading") return errorReply(ack, "invalid_phase", room?.revision);
    if (payload.mapRevision !== room.race.mapRevision) return errorReply(ack, "stale_map", room.revision);
    room.race.ready.add(socket.data.playerId);
    ackReply(ack, { ok: true, revision: room.revision });
    if (allRacePlayersReady(room)) startRaceCountdown(room);
  });

  socket.on("race:update", (payload = {}) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (
      !room?.race ||
      room.phase !== "race" ||
      !["racing", "finished"].includes(player?.status)
    ) return;
    const now = Date.now();
    const serverElapsedMs = Math.max(0, now - Number(room.race.countdownAt));
    player.motionGuard ||= createRaceMotionGuard(Number(player.lastMotion.elapsedMs) || 0);
    const result = validateRaceMotion({
      payload,
      lastMotion: player.lastMotion,
      guard: player.motionGuard,
      placements: room.placements,
      serverElapsedMs,
    });
    if (!result.ok) {
      emitRaceCorrection(socket, room, player, result.errorCode, now);
      return;
    }
    player.motionGuard = result.guard;
    player.lastMotion = {
      ...result.motion,
      at: now,
    };
    const peerMotion = { playerId: player.id, ...player.lastMotion };
    if (player.lastMotion.snap) socket.to(room.code).emit("race:peer", peerMotion);
    else socket.to(room.code).volatile.emit("race:peer", peerMotion);
  });

  socket.on("race:finish", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player || room.phase !== "race") return errorReply(ack, "invalid_phase", room?.revision);
    if (!isRaceFinishVerified({ lastMotion: player.lastMotion, guard: player.motionGuard })) {
      emitRaceCorrection(socket, room, player, "finish_not_verified");
      return errorReply(ack, "finish_not_verified", room.revision);
    }
    const accepted = recordFinish(room, player, payload.actionId);
    if (!accepted) return errorReply(ack, "duplicate_or_finished", room.revision);
    ackReply(ack, { ok: true, revision: room.revision });
  });

  socket.on("race:death", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player || room.phase !== "race" || player.status !== "racing") {
      return errorReply(ack, "invalid_phase", room?.revision);
    }
    if (!recordAction(room, player.id, payload.actionId)) {
      return errorReply(ack, "duplicate_action", room.revision);
    }
    player.status = "dead";
    room.race.deaths.add(player.id);
    bump(room);
    emitState(room);
    maybeFinishRace(room);
    ackReply(ack, { ok: true, revision: room.revision });
  });

  socket.on("game:rematch", (payload = {}, ack) => {
    const room = getBoundRoom(socket);
    if (!room) return errorReply(ack, "room_not_found");
    if (room.hostId !== socket.data.playerId) return errorReply(ack, "host_only", room.revision);
    if (room.phase !== "gameover") return errorReply(ack, "invalid_phase", room.revision);
    if (!ensureRevision(room, payload.expectedRevision)) return errorReply(ack, "stale_state", room.revision);
    startGame(room);
    ackReply(ack, { ok: true, revision: room.revision });
  });

  socket.on("disconnect", () => {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    if (room.hostId === player.id) {
      room.hostId = activeHumans(room).find((candidate) => candidate.connected)?.id || room.hostId;
    }
    const draftCompleted = room.phase === "draft" && autoPickDraftPlayer(room, player.id) && draftIsComplete(room);
    if (draftCompleted) startBuild(room);
    else {
      bump(room);
      emitState(room);
    }
    if (room.phase === "race") maybeFinishRace(room);
    player.disconnectTimer = setTimeout(() => removePlayer(room, player.id), timing.reconnectGraceMs);
    if (!activeHumans(room).some((candidate) => candidate.connected)) destroyRoomLater(room);
  });
});

server.listen(port, host, () => {
  console.log(`Boltbound room server listening on http://${host}:${port}`);
});
