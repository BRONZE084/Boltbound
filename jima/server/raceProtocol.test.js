import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { io as createClient } from "socket.io-client";
import { BASE_PLATFORMS, GOAL, PLAYER_COLLISION_BOUNDS, SPAWN } from "../shared/gameConfig.js";
import {
  createBotRaceRoute,
  routeDistance,
  sampleBotRaceRoute,
} from "./botRaceRoute.js";
import "./multiplayerSpawnProtocol.test.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const boundedRaceRoute = createBotRaceRoute();

function emitAck(socket, event, payload, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function stateTracker(socket) {
  let latest = null;
  const waiters = new Set();
  socket.on("room:state", (state) => {
    latest = state;
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(state)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(state);
    }
  });
  return {
    waitFor(predicate, timeoutMs = 5_000) {
      if (latest && predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`state wait timed out; latest phase=${latest?.phase || "none"}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

async function waitForServer(url, child, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("server health check timed out");
}

async function emitBoundedRaceRoute(socket, countdownAt, speed = 700) {
  const durationMs = (routeDistance(boundedRaceRoute) / speed) * 1_000;
  const startedAt = Date.now();
  let progress = 0;
  let motion = sampleBotRaceRoute(boundedRaceRoute, 0, durationMs);
  while (progress < 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    progress = Math.min(1, (Date.now() - startedAt) / durationMs);
    motion = sampleBotRaceRoute(boundedRaceRoute, progress, durationMs);
    socket.emit("race:update", {
      ...motion,
      facing: motion.vx < 0 ? -1 : 1,
      elapsedMs: Math.max(0, Date.now() - countdownAt),
    });
  }
  return motion;
}

test("bot route clears the two gaps and finishes on the third platform", () => {
  const stairs = [...BASE_PLATFORMS].sort((left, right) => left.x - right.x);
  assert.equal(stairs.length, 3, "the bot route must match the three aerial platforms");
  assert.deepEqual(
    stairs.map(({ id, x, y, width }) => ({ id, x, y, width })),
    [
      { id: "start-upper-left", x: 170, y: 196, width: 300 },
      { id: "middle-step", x: 760, y: 436, width: 340 },
      { id: "final-step", x: 1_440, y: 676, width: 320 },
    ],
  );
  assert.deepEqual(boundedRaceRoute[0], { x: SPAWN.x, y: SPAWN.y });
  assert.deepEqual(boundedRaceRoute.at(-1), {
    x: GOAL.x,
    y: stairs.at(-1).y - stairs.at(-1).height / 2 - PLAYER_COLLISION_BOUNDS.bottom,
  });
  assert.ok(
    boundedRaceRoute.length >= stairs.length * 3,
    "the bot must follow landing/departure points instead of a direct diagonal",
  );
  for (let index = 1; index < boundedRaceRoute.length; index += 1) {
    assert.ok(
      boundedRaceRoute[index].y >= boundedRaceRoute[index - 1].y,
      "the upper-left bot route must descend without cutting upward through platforms",
    );
  }
  for (const stair of stairs.slice(0, -1)) {
    const rightEdge = stair.x + stair.width / 2;
    const standing = stair.y - stair.height / 2 - PLAYER_COLLISION_BOUNDS.bottom;
    assert.ok(boundedRaceRoute.some((point) =>
      point.y === standing && point.x + PLAYER_COLLISION_BOUNDS.right < rightEdge));
    assert.ok(boundedRaceRoute.some((point) =>
      point.y === standing && point.x - PLAYER_COLLISION_BOUNDS.left > rightEdge));
    assert.ok(boundedRaceRoute.some((point) =>
      point.y === standing + 8 && point.x - PLAYER_COLLISION_BOUNDS.left > rightEdge));
  }
  const finalRight = stairs.at(-1).x + stairs.at(-1).width / 2;
  assert.ok(
    boundedRaceRoute.every((point) => point.x + PLAYER_COLLISION_BOUNDS.right <= finalRight),
    "the bot must stop at the goal instead of running beyond the final platform",
  );
  const midpoint = sampleBotRaceRoute(boundedRaceRoute, 0.5, 4_000);
  assert.ok(Number.isFinite(midpoint.x) && Number.isFinite(midpoint.y));
  const fourthSlotRoute = createBotRaceRoute(BASE_PLATFORMS, { x: SPAWN.x + 132, y: SPAWN.y - 24 });
  assert.deepEqual(fourthSlotRoute[0], { x: SPAWN.x + 132, y: SPAWN.y - 24 });
});

test("socket protocol rejects a forged goal jump and accepts a bounded route", { timeout: 15_000 }, async () => {
  const port = 42_000 + (process.pid % 1_000);
  const url = `http://127.0.0.1:${port}`;
  let serverErrors = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      GAME_TIMERS: "short",
      NODE_ENV: "test",
      GAME_TEST_DRAFT_CHOICES: "fan,beam,crate",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { serverErrors += chunk; });

  let socket;
  try {
    await waitForServer(url, child);
    socket = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    await once(socket, "connect");
    const states = stateTracker(socket);
    const practice = await emitAck(socket, "room:practice", {
      clientId: `security-${randomUUID()}`,
      name: "Security",
    });
    assert.equal(practice.ok, true);
    const playerId = practice.playerId;

    const draft = await states.waitFor((state) => state.phase === "draft");
    const pieceType = draft.draft.choices[playerId][0];
    assert.equal(pieceType, "fan");
    const pick = await emitAck(socket, "draft:pick", {
      round: draft.round,
      draftId: draft.draft.draftId,
      pieceType,
      actionId: randomUUID(),
    });
    assert.equal(pick.ok, true);

    const build = await states.waitFor((state) =>
      ["build", "race_loading", "race_countdown", "race"].includes(state.phase));
    if (build.phase === "build" && !build.build.decisions[playerId]) {
      assert.equal(build.build.blockers.length, 2);
      assert.ok(build.build.blockers.every((blocker) =>
        blocker.width === 72 && blocker.height === 104));
      assert.deepEqual(
        build.build.blockers.map(({ x, y }) => ({ x, y })),
        [{ x: SPAWN.x, y: SPAWN.y }, { x: SPAWN.x + 44, y: SPAWN.y - 8 }],
      );
      const bodyCovered = await emitAck(socket, "build:place", {
        round: build.round,
        buildId: build.build.buildId,
        placement: { type: "fan", x: 120, y: 160, rotation: 90 },
        actionId: randomUUID(),
      });
      assert.equal(bodyCovered.ok, false);
      assert.equal(bodyCovered.errorCode, "reserved_zone");
      const goalCovered = await emitAck(socket, "build:place", {
        round: build.round,
        buildId: build.build.buildId,
        placement: { type: "fan", x: 1500, y: 580, rotation: 90 },
        actionId: randomUUID(),
      });
      assert.equal(goalCovered.ok, false, "服务端必须拒绝覆盖终点旗子的搭建");
      assert.equal(goalCovered.errorCode, "goal_blocked");
      const outside = await emitAck(socket, "build:place", {
        round: build.round,
        buildId: build.build.buildId,
        placement: { type: "fan", x: 1620, y: 900, rotation: 90 },
        actionId: randomUUID(),
      });
      assert.equal(outside.ok, false, "画面以外的中心坐标仍应拒绝");
      assert.equal(outside.errorCode, "out_of_bounds");
      const edgePlacement = await emitAck(socket, "build:place", {
        round: build.round,
        buildId: build.build.buildId,
        placement: { type: "fan", x: 1600, y: 900, rotation: 90 },
        actionId: randomUUID(),
      });
      assert.equal(edgePlacement.ok, true, "服务端应接受右下角的零件中心与部分伸出画面的实体");
    }

    const loading = build.phase === "race_loading"
      ? build
      : await states.waitFor((state) =>
        ["race_loading", "race_countdown", "race"].includes(state.phase));
    if (loading.phase === "race_loading") {
      const ready = await emitAck(socket, "race:ready", { mapRevision: loading.race.mapRevision });
      assert.equal(ready.ok, true);
    }
    const racing = loading.phase === "race"
      ? loading
      : await states.waitFor((state) => state.phase === "race", 5_000);
    const countdownAt = racing.race.countdownAt;

    const correctionPromise = once(socket, "race:correction");
    const forgedElapsed = Math.max(0, Date.now() - countdownAt);
    socket.emit("race:update", {
      x: GOAL.x,
      y: GOAL.y,
      vx: 0,
      vy: 0,
      facing: 1,
      elapsedMs: forgedElapsed,
    });
    const [correction] = await correctionPromise;
    assert.equal(correction.x, SPAWN.x);
    assert.equal(correction.y, SPAWN.y);
    assert.equal(correction.reason, "motion_too_fast");

    const forgedFinish = await emitAck(socket, "race:finish", { actionId: randomUUID() });
    assert.equal(forgedFinish.ok, false);
    assert.equal(forgedFinish.errorCode, "finish_not_verified");

    const finishMotion = await emitBoundedRaceRoute(socket, countdownAt);
    const finish = await emitAck(socket, "race:finish", { actionId: randomUUID() });
    assert.equal(finish.ok, true);
    const finishedState = await states.waitFor(
      (state) => state.players.some((player) => player.id === playerId && player.status === "finished"),
    );
    assert.equal(finishedState.players.find((player) => player.id === playerId).status, "finished");

    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.emit("race:update", {
      x: finishMotion.x + 10,
      y: finishMotion.y,
      vx: 200,
      vy: 0,
      facing: 1,
      elapsedMs: Math.max(0, Date.now() - countdownAt),
    });
  } finally {
    socket?.disconnect();
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    if (child.exitCode && serverErrors) process.stderr.write(serverErrors);
  }
});

test("a resumed racer cancels stale early settlement, then explicit leave settles", { timeout: 15_000 }, async () => {
  const port = 43_000 + (process.pid % 1_000);
  const url = `http://127.0.0.1:${port}`;
  let serverErrors = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), GAME_TIMERS: "short" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { serverErrors += chunk; });

  let first;
  let second;
  let resumed;
  try {
    await waitForServer(url, child);
    first = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    second = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    await Promise.all([once(first, "connect"), once(second, "connect")]);
    const firstStates = stateTracker(first);
    const secondStates = stateTracker(second);
    const created = await emitAck(first, "room:create", {
      clientId: `finisher-${randomUUID()}`,
      name: "Finisher",
    });
    assert.equal(created.ok, true);
    const joined = await emitAck(second, "room:join", {
      clientId: `leaver-${randomUUID()}`,
      name: "Leaver",
      code: created.code,
    });
    assert.equal(joined.ok, true);
    const lobby = await firstStates.waitFor((state) => state.phase === "lobby" && state.players.length === 2);
    assert.equal((await emitAck(first, "game:start", { expectedRevision: lobby.revision })).ok, true);

    const [firstDraft, secondDraft] = await Promise.all([
      firstStates.waitFor((state) => state.phase === "draft"),
      secondStates.waitFor((state) => state.phase === "draft"),
    ]);
    await Promise.all([
      emitAck(first, "draft:pick", {
        round: firstDraft.round,
        draftId: firstDraft.draft.draftId,
        pieceType: firstDraft.draft.choices[created.playerId][0],
        actionId: randomUUID(),
      }),
      emitAck(second, "draft:pick", {
        round: secondDraft.round,
        draftId: secondDraft.draft.draftId,
        pieceType: secondDraft.draft.choices[joined.playerId][0],
        actionId: randomUUID(),
      }),
    ]);

    const build = await firstStates.waitFor((state) =>
      ["build", "race_loading"].includes(state.phase),
    );
    if (build.phase === "build") {
      const skips = [];
      if (!build.build.decisions[created.playerId]) {
        skips.push(emitAck(first, "build:skip", {
          round: build.round,
          buildId: build.build.buildId,
          actionId: randomUUID(),
        }));
      }
      if (!build.build.decisions[joined.playerId]) {
        skips.push(emitAck(second, "build:skip", {
          round: build.round,
          buildId: build.build.buildId,
          actionId: randomUUID(),
        }));
      }
      await Promise.all(skips);
    }

    const [firstLoading, secondLoading] = await Promise.all([
      firstStates.waitFor((state) => state.phase === "race_loading"),
      secondStates.waitFor((state) => state.phase === "race_loading"),
    ]);
    await Promise.all([
      emitAck(first, "race:ready", { mapRevision: firstLoading.race.mapRevision }),
      emitAck(second, "race:ready", { mapRevision: secondLoading.race.mapRevision }),
    ]);
    const racing = await firstStates.waitFor((state) => state.phase === "race", 5_000);
    const countdownAt = racing.race.countdownAt;

    await emitBoundedRaceRoute(first, countdownAt);
    assert.equal((await emitAck(first, "race:finish", { actionId: randomUUID() })).ok, true);
    await firstStates.waitFor((state) =>
      state.players.some((player) => player.id === created.playerId && player.status === "finished"),
    );

    second.disconnect();
    await firstStates.waitFor((state) =>
      state.players.some((player) => player.id === joined.playerId && !player.connected),
    );
    resumed = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    await once(resumed, "connect");
    const resumePayload = {
      code: created.code,
      playerId: joined.playerId,
      resumeToken: joined.resumeToken,
    };
    const resumedAck = await emitAck(resumed, "room:resume", resumePayload);
    assert.equal(resumedAck.ok, true);
    assert.equal(resumedAck.snapshot.phase, "race");
    assert.equal(
      resumedAck.snapshot.players.find((player) => player.id === joined.playerId).status,
      "racing",
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const stableAck = await emitAck(resumed, "room:resume", resumePayload);
    assert.equal(stableAck.ok, true);
    assert.equal(stableAck.snapshot.phase, "race");

    const leftAt = Date.now();
    assert.equal((await emitAck(resumed, "room:leave", {})).ok, true);
    const results = await firstStates.waitFor((state) => state.phase === "results", 2_000);
    assert.ok(Date.now() - leftAt < 2_000);
    assert.equal(results.players.some((player) => player.id === joined.playerId), false);
  } finally {
    first?.disconnect();
    second?.disconnect();
    child.kill();
    resumed?.disconnect();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (child.exitCode && serverErrors) process.stderr.write(serverErrors);
  }
});

test("bomb blast atomically removes placements, handles an empty blast, and is idempotent", { timeout: 15_000 }, async () => {
  const port = 44_000 + (process.pid % 1_000);
  const url = `http://127.0.0.1:${port}`;
  let serverErrors = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      GAME_TIMERS: "short",
      NODE_ENV: "test",
      GAME_TEST_DRAFT_CHOICES: "bomb,crate,beam",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { serverErrors += chunk; });

  const sockets = [];
  try {
    await waitForServer(url, child);
    for (let index = 0; index < 3; index += 1) {
      const socket = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
      sockets.push(socket);
      await once(socket, "connect");
    }
    const [bomber, builder, emptyBomber] = sockets;
    const bomberStates = stateTracker(bomber);
    const builderStates = stateTracker(builder);
    const emptyBomberStates = stateTracker(emptyBomber);
    const created = await emitAck(bomber, "room:create", {
      clientId: `bomb-a-${randomUUID()}`,
      name: "Bomber",
    });
    assert.equal(created.ok, true);
    const joinedBuilder = await emitAck(builder, "room:join", {
      clientId: `bomb-b-${randomUUID()}`,
      name: "Builder",
      code: created.code,
    });
    assert.equal(joinedBuilder.ok, true);
    const joinedEmpty = await emitAck(emptyBomber, "room:join", {
      clientId: `bomb-c-${randomUUID()}`,
      name: "Empty",
      code: created.code,
    });
    assert.equal(joinedEmpty.ok, true);

    const lobby = await bomberStates.waitFor((state) => state.phase === "lobby" && state.players.length === 3);
    assert.equal((await emitAck(bomber, "game:start", { expectedRevision: lobby.revision })).ok, true);
    const [bomberDraft, builderDraft, emptyDraft] = await Promise.all([
      bomberStates.waitFor((state) => state.phase === "draft"),
      builderStates.waitFor((state) => state.phase === "draft"),
      emptyBomberStates.waitFor((state) => state.phase === "draft"),
    ]);
    assert.deepEqual(bomberDraft.draft.choices[created.playerId], ["bomb", "crate", "beam"]);
    const pickResults = await Promise.all([
      emitAck(bomber, "draft:pick", {
        round: bomberDraft.round,
        draftId: bomberDraft.draft.draftId,
        pieceType: "bomb",
        actionId: randomUUID(),
      }),
      emitAck(builder, "draft:pick", {
        round: builderDraft.round,
        draftId: builderDraft.draft.draftId,
        pieceType: "crate",
        actionId: randomUUID(),
      }),
      emitAck(emptyBomber, "draft:pick", {
        round: emptyDraft.round,
        draftId: emptyDraft.draft.draftId,
        pieceType: "bomb",
        actionId: randomUUID(),
      }),
    ]);
    assert.ok(pickResults.every((result) => result.ok));

    const build = await builderStates.waitFor((state) => state.phase === "build");
    const placed = await emitAck(builder, "build:place", {
      round: build.round,
      buildId: build.build.buildId,
      placement: { type: "crate", x: 220, y: 280, rotation: 0 },
      actionId: randomUUID(),
    });
    assert.equal(placed.ok, true);

    const loadingStates = await Promise.all([
      bomberStates.waitFor((state) => state.phase === "race_loading"),
      builderStates.waitFor((state) => state.phase === "race_loading"),
      emptyBomberStates.waitFor((state) => state.phase === "race_loading"),
    ]);
    assert.equal(loadingStates[0].placements.length, 1);
    assert.equal(loadingStates[0].mapRevision, 1);
    await Promise.all([
      emitAck(bomber, "race:ready", { mapRevision: loadingStates[0].race.mapRevision }),
      emitAck(builder, "race:ready", { mapRevision: loadingStates[1].race.mapRevision }),
      emitAck(emptyBomber, "race:ready", { mapRevision: loadingStates[2].race.mapRevision }),
    ]);
    await bomberStates.waitFor((state) => state.phase === "race", 5_000);

    const blasts = [];
    bomber.on("bomb:blast", (blast) => blasts.push(blast));
    const firstActionId = randomUUID();
    const firstBlastPromise = once(bomber, "bomb:blast");
    const firstUse = await emitAck(bomber, "item:use", {
      round: 1,
      itemType: "bomb",
      actionId: firstActionId,
    });
    assert.equal(firstUse.ok, true);
    assert.equal(firstUse.mapRevision, 2);
    assert.equal(firstUse.removedPlacementIds.length, 1);
    const [firstBlast] = await firstBlastPromise;
    assert.equal(firstBlast.sourcePlayerId, created.playerId);
    assert.equal(firstBlast.x, SPAWN.x);
    assert.equal(firstBlast.y, SPAWN.y);
    assert.equal(firstBlast.radius, 220);
    assert.equal(firstBlast.mapRevision, 2);
    assert.equal(firstBlast.placements.length, 0);
    assert.deepEqual(firstBlast.removedPlacementIds, firstUse.removedPlacementIds);
    const removedState = await bomberStates.waitFor((state) =>
      state.mapRevision === 2 && state.placements.length === 0,
    );
    assert.equal(removedState.race.mapRevision, 2);

    const emptyBlastPromise = once(bomber, "bomb:blast");
    const emptyUse = await emitAck(emptyBomber, "item:use", {
      round: 1,
      itemType: "bomb",
      actionId: randomUUID(),
    });
    assert.equal(emptyUse.ok, true);
    assert.equal(emptyUse.mapRevision, 2);
    assert.deepEqual(emptyUse.removedPlacementIds, []);
    const [emptyBlast] = await emptyBlastPromise;
    assert.equal(emptyBlast.sourcePlayerId, joinedEmpty.playerId);
    assert.equal(emptyBlast.mapRevision, 2);
    assert.deepEqual(emptyBlast.removedPlacementIds, []);
    assert.deepEqual(emptyBlast.placements, []);

    const duplicate = await emitAck(bomber, "item:use", {
      round: 1,
      itemType: "bomb",
      actionId: firstActionId,
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.mapRevision, 2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(blasts.length, 2, "a duplicate action must not emit a second blast");

    const reused = await emitAck(bomber, "item:use", {
      round: 1,
      itemType: "bomb",
      actionId: randomUUID(),
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.errorCode, "item_used");
  } finally {
    for (const socket of sockets) socket.disconnect();
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (child.exitCode && serverErrors) process.stderr.write(serverErrors);
  }
});
