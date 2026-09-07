import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { io as createClient } from "socket.io-client";
import { SPAWN } from "../shared/gameConfig.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function waitForPeer(socket, playerId, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("race:peer", onPeer);
      reject(new Error(`peer packet timed out for ${playerId}`));
    }, timeoutMs);
    function onPeer(payload) {
      if (payload.playerId !== playerId) return;
      clearTimeout(timer);
      socket.off("race:peer", onPeer);
      resolve(payload);
    }
    socket.on("race:peer", onPeer);
  });
}

test("third and fourth racers keep their authoritative spawn slots on the first 50 ms packet", { timeout: 15_000 }, async () => {
  const port = 45_000 + (process.pid % 1_000);
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
      GAME_TEST_DRAFT_CHOICES: "beam,crate,spring",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { serverErrors += chunk; });

  const sockets = [];
  try {
    await waitForServer(url, child);
    for (let index = 0; index < 4; index += 1) {
      const socket = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
      sockets.push(socket);
      await once(socket, "connect");
    }
    const trackers = sockets.map((socket) => stateTracker(socket));
    const created = await emitAck(sockets[0], "room:create", {
      clientId: `slots-0-${randomUUID()}`,
      name: "Slot 1",
    });
    assert.equal(created.ok, true);
    const members = [created];
    for (let index = 1; index < sockets.length; index += 1) {
      const joined = await emitAck(sockets[index], "room:join", {
        clientId: `slots-${index}-${randomUUID()}`,
        name: `Slot ${index + 1}`,
        code: created.code,
      });
      assert.equal(joined.ok, true);
      members.push(joined);
    }

    const lobby = await trackers[0].waitFor((state) => state.phase === "lobby" && state.players.length === 4);
    assert.equal((await emitAck(sockets[0], "game:start", { expectedRevision: lobby.revision })).ok, true);
    const drafts = await Promise.all(trackers.map((tracker) =>
      tracker.waitFor((state) => state.phase === "draft")));
    const picks = await Promise.all(sockets.map((socket, index) => emitAck(socket, "draft:pick", {
      round: drafts[index].round,
      draftId: drafts[index].draft.draftId,
      pieceType: drafts[index].draft.choices[members[index].playerId][0],
      actionId: randomUUID(),
    })));
    assert.ok(picks.every((result) => result.ok));

    const builds = await Promise.all(trackers.map((tracker) =>
      tracker.waitFor((state) => state.phase === "build")));
    assert.deepEqual(
      builds[0].build.blockers.map(({ x, y, width, height }) => ({ x, y, width, height })),
      Array.from({ length: 4 }, (_, index) => ({
        x: SPAWN.x + index * 44,
        y: SPAWN.y - index * 8,
        width: 72,
        height: 104,
      })),
    );
    const skips = await Promise.all(sockets.map((socket, index) => emitAck(socket, "build:skip", {
      round: builds[index].round,
      buildId: builds[index].build.buildId,
      actionId: randomUUID(),
    })));
    assert.ok(skips.every((result) => result.ok));

    const loadings = await Promise.all(trackers.map((tracker) =>
      tracker.waitFor((state) => state.phase === "race_loading")));
    const ready = await Promise.all(sockets.map((socket, index) => emitAck(socket, "race:ready", {
      mapRevision: loadings[index].race.mapRevision,
    })));
    assert.ok(ready.every((result) => result.ok));
    const racing = await trackers[0].waitFor((state) => state.phase === "race", 5_000);
    assert.equal(racing.players[2].id, members[2].playerId);
    assert.equal(racing.players[3].id, members[3].playerId);

    const corrections = [[], []];
    sockets[2].on("race:correction", (payload) => corrections[0].push(payload));
    sockets[3].on("race:correction", (payload) => corrections[1].push(payload));
    const thirdPeerPromise = waitForPeer(sockets[0], members[2].playerId);
    const fourthPeerPromise = waitForPeer(sockets[0], members[3].playerId);
    const expectedSlots = [
      { x: SPAWN.x + 2 * 44, y: SPAWN.y - 2 * 8 },
      { x: SPAWN.x + 3 * 44, y: SPAWN.y - 3 * 8 },
    ];
    sockets[2].emit("race:update", {
      ...expectedSlots[0], vx: 0, vy: 0, facing: 1, elapsedMs: 50,
    });
    sockets[3].emit("race:update", {
      ...expectedSlots[1], vx: 0, vy: 0, facing: 1, elapsedMs: 50,
    });
    const [thirdPeer, fourthPeer] = await Promise.all([thirdPeerPromise, fourthPeerPromise]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(corrections, [[], []]);
    assert.deepEqual({ x: thirdPeer.x, y: thirdPeer.y }, expectedSlots[0]);
    assert.deepEqual({ x: fourthPeer.x, y: fourthPeer.y }, expectedSlots[1]);
    assert.notEqual(thirdPeer.x, SPAWN.x);
    assert.notEqual(fourthPeer.x, SPAWN.x);
  } finally {
    for (const socket of sockets) socket.disconnect();
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (child.exitCode && serverErrors) process.stderr.write(serverErrors);
  }
});
