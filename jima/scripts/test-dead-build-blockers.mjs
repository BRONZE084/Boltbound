import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { io as createClient } from "socket.io-client";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function emitAck(socket, event, payload, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function trackStates(socket) {
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
    waitFor(predicate, timeoutMs = 12_000) {
      if (latest && predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`state wait timed out; latest=${latest?.phase || "none"}/${latest?.round || 0}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server health check timed out");
}

async function chooseFirstDraft(socket, state, playerId) {
  const pieceType = state.draft.choices[playerId][0];
  const response = await emitAck(socket, "draft:pick", {
    round: state.round,
    draftId: state.draft.draftId,
    pieceType,
    actionId: randomUUID(),
  });
  assert.equal(response.ok, true);
}

const port = await reservePort();
assert.notEqual(port, 32_145);
const url = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    GAME_TIMERS: "short",
    NODE_ENV: "test",
    GAME_TEST_DRAFT_CHOICES: "crate,beam,fan",
  },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { serverErrors += chunk; });

let socket;
try {
  await waitForServer(url, child);
  socket = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  await once(socket, "connect");
  const states = trackStates(socket);
  const joined = await emitAck(socket, "room:practice", {
    clientId: `dead-blocker-${randomUUID()}`,
    name: "DeadBlocker",
  });
  assert.equal(joined.ok, true);

  const firstDraft = await states.waitFor((state) => state.phase === "draft" && state.round === 1);
  await chooseFirstDraft(socket, firstDraft, joined.playerId);
  const firstBuild = await states.waitFor((state) => state.phase === "build" && state.round === 1);
  assert.equal((await emitAck(socket, "build:skip", {
    round: firstBuild.round,
    buildId: firstBuild.build.buildId,
    actionId: randomUUID(),
  })).ok, true);

  const firstBlocker = firstBuild.build.blockers.find((blocker) => blocker.playerId === joined.playerId);
  assert.ok(firstBlocker, "the live player must have a first-round build blocker");
  const loading = await states.waitFor((state) => state.phase === "race_loading" && state.round === 1);
  assert.equal((await emitAck(socket, "race:ready", { mapRevision: loading.race.mapRevision })).ok, true);
  await states.waitFor((state) => state.phase === "race" && state.round === 1);
  const fallY = 995;
  await new Promise((resolve) => setTimeout(resolve, 850));
  socket.emit("race:update", {
    x: firstBlocker.x,
    y: fallY,
    vx: 0,
    vy: 1_000,
    facing: 1,
    elapsedMs: 850,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await emitAck(socket, "race:death", { actionId: randomUUID() })).ok, true);

  const secondDraft = await states.waitFor((state) => state.phase === "draft" && state.round === 2);
  await chooseFirstDraft(socket, secondDraft, joined.playerId);
  const secondBuild = await states.waitFor((state) => state.phase === "build" && state.round === 2);
  const deadBlocker = secondBuild.build.blockers.find((blocker) => blocker.playerId === joined.playerId);
  const liveBlocker = secondBuild.build.blockers.find((blocker) => blocker.playerId !== joined.playerId);
  assert.equal(deadBlocker?.blocksPlacement, false, "last round's dead player must not occupy build space");
  assert.equal(deadBlocker?.x, firstBlocker.x, "the hidden corpse blocker must retain its accepted x position");
  assert.equal(deadBlocker?.y, fallY, "an out-of-world death position must still be serialized for hiding");
  assert.ok(deadBlocker.y > 900, "the protocol fixture must exercise a genuine below-world death position");
  assert.equal(liveBlocker?.blocksPlacement, true, "a surviving player must remain a build blocker");
  console.log("dead build blocker protocol: previous corpse ignored, live player retained");
} finally {
  socket?.disconnect();
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
  if (serverErrors) process.stderr.write(serverErrors);
}
