import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { io as createClient } from "socket.io-client";
import {
  WEB_VOICE_CONTROLS_PER_WINDOW,
  WECHAT_VOICE_SPEAKER_REQUESTS_PER_WINDOW,
  WEB_VOICE_SIGNALS_PER_WINDOW,
  createIceConfiguration,
  createVoiceService,
  createWechatVoipSignature,
} from "../server/voiceService.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeSocket {
  constructor(id, { address = "127.0.0.1" } = {}) {
    this.id = id;
    this.data = {};
    this.handshake = { address };
    this.handlers = new Map();
    this.sent = [];
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event, payload) {
    this.sent.push({ event, payload });
  }

  request(event, payload = {}) {
    return new Promise((resolve, reject) => {
      const handler = this.handlers.get(event)?.[0];
      if (!handler) return reject(new Error(`missing_handler:${event}`));
      let settled = false;
      handler(payload, (response) => {
        settled = true;
        resolve(response);
      });
      setTimeout(() => {
        if (!settled) reject(new Error(`ack_timeout:${event}`));
      }, 200).unref?.();
    });
  }

  disconnectEvent() {
    for (const handler of this.handlers.get("disconnect") || []) handler("test");
  }
}

class FakeIo {
  constructor() {
    this.sockets = { sockets: new Map() };
  }

  add(socket) {
    this.sockets.sockets.set(socket.id, socket);
  }

  to(socketId) {
    return {
      emit: (event, payload) => this.sockets.sockets.get(socketId)?.emit(event, payload),
    };
  }
}

function makeHarness({ env = {}, fetchImpl, now = () => 1_700_000_000_000, randomNonce } = {}) {
  const io = new FakeIo();
  const rooms = new Map();
  let sessionNumber = 0;
  const service = createVoiceService({
    io,
    env,
    fetchImpl,
    now,
    randomId: () => `voice-session-${++sessionNumber}`,
    randomNonce,
    getBoundRoom: (socket) => rooms.get(socket.data.roomCode),
    getBoundPlayer: (socket, room) => room?.players.get(socket.data.playerId),
  });

  function room(code) {
    const value = { code, players: new Map() };
    rooms.set(code, value);
    return value;
  }

  function player(targetRoom, id, options = {}) {
    const socket = new FakeSocket(`socket-${id}`, options);
    const value = { id, bot: false, connected: true, socketId: socket.id };
    targetRoom.players.set(id, value);
    socket.data.roomCode = targetRoom.code;
    socket.data.playerId = id;
    io.add(socket);
    service.bindSocket(socket);
    return socket;
  }

  return { io, rooms, service, room, player };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const description = { type: "offer", sdp: "v=0\r\n" };

function testTurnCredentials() {
  const nowMs = 1_700_000_000_000;
  const secret = "server-only-turn-secret";
  const configuration = createIceConfiguration({
    VOICE_TURN_URLS: "turn:turn.example.com:3478,turns:turn.example.com:5349",
    VOICE_TURN_SECRET: secret,
    VOICE_TURN_TTL_SECONDS: "600",
    VOICE_TURN_USERNAME: "legacy-user-must-be-ignored",
    VOICE_TURN_CREDENTIAL: "legacy-password-must-be-ignored",
  }, { nowMs, identity: "ROOM1-player-1-session-1" });
  assert.equal(configuration.turnConfigured, true);
  const turnServer = configuration.iceServers.find((server) =>
    Array.isArray(server.urls) && server.urls.some((url) => url.startsWith("turn:")),
  );
  assert.ok(turnServer);
  assert.equal(turnServer.username, "1700000600:ROOM1-player-1-session-1");
  assert.equal(
    turnServer.credential,
    createHmac("sha1", secret).update(turnServer.username).digest("base64"),
  );
  assert.equal(JSON.stringify(configuration).includes(secret), false);

  const legacyOnly = createIceConfiguration({
    VOICE_TURN_URLS: "turn:turn.example.com:3478",
    VOICE_TURN_USERNAME: "legacy-user",
    VOICE_TURN_CREDENTIAL: "legacy-password",
  }, { nowMs, identity: "legacy" });
  assert.equal(legacyOnly.turnConfigured, false);
  assert.equal(legacyOnly.iceServers.some((server) => "credential" in server), false);
}

async function testWebProtocol() {
  const harness = makeHarness();
  const roomA = harness.room("AAAAA");
  const roomB = harness.room("BBBBB");
  const alice = harness.player(roomA, "alice");
  const bob = harness.player(roomA, "bob");
  const eve = harness.player(roomB, "eve");

  const capability = await alice.request("voice:capabilities");
  assert.equal(capability.ok, true);
  assert.equal(capability.web.maxParticipants, 4);
  assert.equal(capability.web.turnConfigured, false);
  assert.equal(capability.channelsInteroperate, false);
  assert.equal(capability.channelIsolation, true);

  const aliceJoin = await alice.request("voice:web:join");
  assert.equal(aliceJoin.ok, true);
  assert.deepEqual(aliceJoin.peerIds, []);
  assert.equal(
    (await alice.request("voice:web:signal", {
      sessionId: aliceJoin.sessionId,
      toPlayerId: "bob",
      description,
    })).errorCode,
    "voice_session_invalid",
  );
  assert.equal((await alice.request("voice:web:ready", { sessionId: aliceJoin.sessionId })).ok, true);

  const bobJoin = await bob.request("voice:web:join");
  assert.equal((await bob.request("voice:web:ready", { sessionId: bobJoin.sessionId })).ok, true);
  assert.deepEqual(
    (await bob.request("voice:web:ready", { sessionId: bobJoin.sessionId })).peerIds,
    ["alice"],
  );
  assert.ok(alice.sent.some(({ event, payload }) => event === "voice:web:state" && payload.kind === "peer_joined" && payload.playerId === "bob"));

  const signal = await alice.request("voice:web:signal", {
    sessionId: aliceJoin.sessionId,
    toPlayerId: "bob",
    description,
  });
  assert.equal(signal.ok, true);
  const forwarded = bob.sent.find(({ event }) => event === "voice:web:signal")?.payload;
  assert.equal(forwarded.sessionId, bobJoin.sessionId);
  assert.equal(forwarded.fromPlayerId, "alice");
  assert.deepEqual(forwarded.description, description);

  const eveJoin = await eve.request("voice:web:join");
  await eve.request("voice:web:ready", { sessionId: eveJoin.sessionId });
  assert.equal(
    (await alice.request("voice:web:signal", {
      sessionId: aliceJoin.sessionId,
      toPlayerId: "eve",
      description,
    })).errorCode,
    "voice_target_unavailable",
  );
  assert.equal(
    (await alice.request("voice:web:signal", {
      sessionId: "forged-session",
      toPlayerId: "bob",
      description,
    })).errorCode,
    "voice_session_invalid",
  );
  assert.equal(
    (await alice.request("voice:web:signal", {
      sessionId: aliceJoin.sessionId,
      toPlayerId: "bob",
      description: { type: "offer", sdp: "x".repeat(25_000) },
    })).errorCode,
    "voice_payload_too_large",
  );

  assert.equal((await bob.request("voice:web:leave", { sessionId: bobJoin.sessionId })).ok, true);
  assert.ok(alice.sent.some(({ event, payload }) => event === "voice:web:state" && payload.kind === "peer_left" && payload.playerId === "bob"));
  alice.disconnectEvent();
  assert.equal(harness.service.debugSessions().some((session) => session.playerId === "alice"), false);
  harness.io.sockets.sockets.delete(eve.id);
  assert.ok(harness.service.cleanupPlayer("BBBBB", "eve"));
  assert.equal(harness.service.debugSessions().length, 0);
  assert.equal(harness.service.debugRoomCount(), 0);
}

async function testCapacityAndRateLimit() {
  const harness = makeHarness();
  const targetRoom = harness.room("FULL4");
  const sockets = ["p1", "p2", "p3", "p4", "p5"].map((id) => harness.player(targetRoom, id));
  const joins = [];
  for (const socket of sockets.slice(0, 4)) {
    const joined = await socket.request("voice:web:join");
    joins.push(joined);
    assert.equal(joined.ok, true);
    await socket.request("voice:web:ready", { sessionId: joined.sessionId });
  }
  assert.equal((await sockets[4].request("voice:web:join")).errorCode, "voice_room_full");

  let response;
  for (let index = 0; index <= WEB_VOICE_SIGNALS_PER_WINDOW; index += 1) {
    response = await sockets[0].request("voice:web:signal", {
      sessionId: joins[0].sessionId,
      toPlayerId: "p2",
      candidate: { candidate: `candidate:${index}`, sdpMid: "0", sdpMLineIndex: 0 },
    });
  }
  assert.equal(response.errorCode, "voice_rate_limited");
  const rejoined = await sockets[0].request("voice:web:join");
  assert.equal(rejoined.ok, true);
  assert.equal((await sockets[0].request("voice:web:ready", { sessionId: rejoined.sessionId })).ok, true);
  assert.equal((await sockets[0].request("voice:web:signal", {
    sessionId: rejoined.sessionId,
    toPlayerId: "p2",
    candidate: { candidate: "candidate:after-rejoin", sdpMid: "0", sdpMLineIndex: 0 },
  })).errorCode, "voice_rate_limited");

  const controlHarness = makeHarness();
  const controlRoom = controlHarness.room("CTRL1");
  const controller = controlHarness.player(controlRoom, "controller");
  for (let index = 0; index < WEB_VOICE_CONTROLS_PER_WINDOW; index += 1) {
    assert.equal((await controller.request("voice:web:join")).ok, true);
  }
  assert.equal((await controller.request("voice:web:join")).errorCode, "voice_rate_limited");
  assert.ok(controlHarness.service.cleanupPlayer("CTRL1", "controller"));
  assert.equal(controlHarness.service.debugLimiterCount(), 0);
}

async function testWechatSigning() {
  assert.equal(
    createWechatVoipSignature({
      appId: "wx20afc706a711eefc",
      groupId: "1559129713_672975982",
      nonceStr: "8AP6DT9ybtniUJfb",
      timeStamp: 1559129714,
      sessionKey: "gDyVgzwa0mFz9uUP7M6GQQ==",
    }),
    "b002b824688dd8593a6079e11d8c5e8734fbcb39a6d5906eb347bfbcad79c617",
  );

  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  let requestedUrl = null;
  const fetchImpl = async (url) => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      json: async () => ({ openid: "openid-must-not-leak", session_key: "session-key-must-not-leak" }),
    };
  };
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const targetRoom = harness.room("WX123");
  const socket = harness.player(targetRoom, "mini-player");
  const capability = await socket.request("voice:capabilities");
  assert.equal(capability.wechat.enabled, true);
  assert.equal(capability.wechat.approvalGranted, true);
  assert.equal(capability.wechat.privacyConfigured, true);
  assert.equal(capability.wechat.nativeOnly, true);
  const response = await socket.request("voice:wechat:credentials", { code: "login-code-123" });
  assert.equal(response.ok, true);
  assert.equal(response.groupId, "boltbound_WX123");
  assert.equal(response.nonceStr, "fixed-nonce");
  assert.equal(response.timeStamp, 1_700_000_000);
  assert.equal(typeof response.signature, "string");
  assert.equal("session_key" in response, false);
  assert.equal("openid" in response, false);
  assert.equal("secret" in response, false);
  assert.equal(requestedUrl.searchParams.get("secret"), "server-only-secret");
  assert.equal(requestedUrl.searchParams.get("js_code"), "login-code-123");
}

async function testWechatCredentialBindingRace() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  const roomCodes = {
    leave: "WXLEAVE",
    disconnect: "WXDISC",
    rebindRoom: "WXRMA",
    rebindPlayer: "WXPLYR",
  };

  async function runScenario(scenario) {
    const pending = deferred();
    const staleCode = `stale-${scenario}`;
    const fetchImpl = async (url) => {
      const code = new URL(url).searchParams.get("js_code");
      return {
        ok: true,
        json: code === staleCode
          ? () => pending.promise
          : async () => ({
            openid: `wx-fresh-${scenario}`,
            session_key: "fresh-session-key",
          }),
      };
    };
    const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
    const originalRoom = harness.room(roomCodes[scenario]);
    const originalPlayerId = `${scenario}-player`;
    const socket = harness.player(originalRoom, originalPlayerId);
    const originalPlayer = originalRoom.players.get(originalPlayerId);
    const staleRequest = socket.request("voice:wechat:credentials", { code: staleCode });
    await new Promise((resolve) => setImmediate(resolve));

    let currentRoom = null;
    if (scenario === "leave") {
      originalRoom.players.delete(originalPlayerId);
      socket.data.roomCode = null;
      socket.data.playerId = null;
    } else if (scenario === "disconnect") {
      socket.disconnectEvent();
      originalPlayer.connected = false;
      originalPlayer.socketId = null;
      harness.io.sockets.sockets.delete(socket.id);
    } else if (scenario === "rebindRoom") {
      currentRoom = harness.room("WXNEW1");
      originalRoom.players.delete(originalPlayerId);
      currentRoom.players.set(originalPlayerId, originalPlayer);
      socket.data.roomCode = currentRoom.code;
    } else {
      currentRoom = originalRoom;
      const replacement = {
        id: "replacement-player",
        bot: false,
        connected: true,
        socketId: socket.id,
      };
      originalRoom.players.delete(originalPlayerId);
      originalRoom.players.set(replacement.id, replacement);
      socket.data.playerId = replacement.id;
    }

    pending.resolve({
      openid: `wx-stale-${scenario}`,
      session_key: "stale-session-key",
    });
    const staleResponse = await staleRequest;
    let freshResponse = null;
    if (currentRoom) {
      freshResponse = await socket.request("voice:wechat:credentials", {
        code: `fresh-${scenario}`,
      });
    }
    return { staleResponse, freshResponse, currentRoom };
  }

  const results = {};
  for (const scenario of ["leave", "disconnect", "rebindRoom", "rebindPlayer"]) {
    results[scenario] = await runScenario(scenario);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(results).map(([scenario, result]) => [
      scenario,
      result.staleResponse,
    ])),
    {
      leave: { ok: false, errorCode: "voice_not_in_room" },
      disconnect: { ok: false, errorCode: "voice_not_in_room" },
      rebindRoom: { ok: false, errorCode: "voice_not_in_room" },
      rebindPlayer: { ok: false, errorCode: "voice_not_in_room" },
    },
  );
  for (const scenario of ["rebindRoom", "rebindPlayer"]) {
    assert.equal(results[scenario].freshResponse.ok, true);
    assert.equal(
      results[scenario].freshResponse.groupId,
      `boltbound_${results[scenario].currentRoom.code}`,
    );
  }
}

async function testWechatCredentialLatestRequestWins() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  const staleExchange = deferred();
  const fetchImpl = async (url) => {
    const code = new URL(url).searchParams.get("js_code");
    return {
      ok: true,
      json: code === "old-code"
        ? () => staleExchange.promise
        : async () => ({ openid: "wx-new-identity", session_key: "new-session-key" }),
    };
  };
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const targetRoom = harness.room("WXORDER");
  const socket = harness.player(targetRoom, "alice");

  const oldRequest = socket.request("voice:wechat:credentials", { code: "old-code" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await socket.request("voice:wechat:credentials", { code: "new-code" })).ok,
    true,
  );
  staleExchange.resolve({ openid: "wx-old-identity", session_key: "old-session-key" });
  assert.deepEqual(await oldRequest, { ok: false, errorCode: "voice_request_superseded" });
  assert.deepEqual(
    await socket.request("voice:wechat:resolve-speakers", { openIdList: ["wx-old-identity"] }),
    { ok: true, speakingPlayerIds: [] },
  );
  assert.deepEqual(
    await socket.request("voice:wechat:resolve-speakers", { openIdList: ["wx-new-identity"] }),
    { ok: true, speakingPlayerIds: ["alice"] },
  );
}

async function testWechatLeaveInvalidatesPendingCredentials() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  const pendingExchange = deferred();
  const fetchImpl = async () => ({
    ok: true,
    json: () => pendingExchange.promise,
  });
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const targetRoom = harness.room("WXLEAVE");
  const socket = harness.player(targetRoom, "alice");

  const credentialRequest = socket.request("voice:wechat:credentials", { code: "pending-code" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await socket.request("voice:wechat:leave"), { ok: true });
  pendingExchange.resolve({
    openid: "wx-late-identity",
    session_key: "late-session-key",
  });
  assert.deepEqual(
    await credentialRequest,
    { ok: false, errorCode: "voice_request_superseded" },
  );
  assert.equal(
    (await socket.request("voice:wechat:resolve-speakers", {
      openIdList: ["wx-late-identity"],
    })).errorCode,
    "voice_wechat_not_joined",
  );
}

async function testWechatCleanupInvalidatesPendingCredentials() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  for (const cleanupKind of ["socket", "player", "room"]) {
    const pendingExchange = deferred();
    const fetchImpl = async () => ({
      ok: true,
      json: () => pendingExchange.promise,
    });
    const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
    const targetRoom = harness.room(`WXCLEAN-${cleanupKind}`);
    const socket = harness.player(targetRoom, "alice");
    const credentialRequest = socket.request("voice:wechat:credentials", {
      code: `pending-${cleanupKind}`,
    });
    await new Promise((resolve) => setImmediate(resolve));

    if (cleanupKind === "socket") {
      harness.service.cleanupSocket(socket, "test_cleanup");
    } else if (cleanupKind === "player") {
      harness.service.cleanupPlayer(targetRoom.code, "alice", "test_cleanup");
    } else {
      harness.service.cleanupRoom(targetRoom.code, "test_cleanup");
    }
    pendingExchange.resolve({
      openid: `wx-late-${cleanupKind}`,
      session_key: "late-session-key",
    });
    assert.deepEqual(
      await credentialRequest,
      { ok: false, errorCode: "voice_request_superseded" },
      `${cleanupKind} cleanup must invalidate pending credentials`,
    );
    assert.equal(
      (await socket.request("voice:wechat:resolve-speakers", {
        openIdList: [`wx-late-${cleanupKind}`],
      })).errorCode,
      "voice_wechat_not_joined",
    );
  }
}

async function testWechatCredentialSocketLimitSurvivesRebinding() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  const fetchImpl = async (url) => {
    const code = new URL(url).searchParams.get("js_code");
    return {
      ok: true,
      json: async () => ({
        openid: `wx-${code}`,
        session_key: "private-session-key",
      }),
    };
  };
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  let currentRoom = harness.room("WXSOCK0");
  let currentPlayerId = "player-0";
  const socket = harness.player(currentRoom, currentPlayerId);
  const socketRequestsPerWindow = 8;

  for (let index = 0; index < socketRequestsPerWindow; index += 1) {
    assert.equal(
      (await socket.request("voice:wechat:credentials", { code: `socket-code-${index}` })).ok,
      true,
    );
    harness.service.cleanupPlayer(currentRoom.code, currentPlayerId, "switch_room");
    currentRoom.players.delete(currentPlayerId);
    currentRoom = harness.room(`WXSOCK${index + 1}`);
    currentPlayerId = `player-${index + 1}`;
    currentRoom.players.set(currentPlayerId, {
      id: currentPlayerId,
      bot: false,
      connected: true,
      socketId: socket.id,
    });
    socket.data.roomCode = currentRoom.code;
    socket.data.playerId = currentPlayerId;
  }

  assert.equal(
    (await socket.request("voice:wechat:credentials", { code: "socket-code-limited" })).errorCode,
    "voice_rate_limited",
    "changing room and player identity must not reset the socket credential limit",
  );
}

async function testWechatCredentialConcurrencyLimit() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  const firstExchange = deferred();
  const secondExchange = deferred();
  let fetchCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    const code = new URL(url).searchParams.get("js_code");
    if (code === "concurrent-1") return { ok: true, json: () => firstExchange.promise };
    if (code === "concurrent-2") return { ok: true, json: () => secondExchange.promise };
    return {
      ok: true,
      json: async () => ({ openid: "wx-unexpected-third", session_key: "third-session-key" }),
    };
  };
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const targetRoom = harness.room("WXCONCUR");
  const socket = harness.player(targetRoom, "alice");

  const firstRequest = socket.request("voice:wechat:credentials", { code: "concurrent-1" });
  await new Promise((resolve) => setImmediate(resolve));
  const secondRequest = socket.request("voice:wechat:credentials", { code: "concurrent-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await socket.request("voice:wechat:credentials", { code: "concurrent-3" }),
    { ok: false, errorCode: "voice_rate_limited" },
  );
  assert.equal(fetchCalls, 2, "a rejected concurrent request must not reach WeChat");

  secondExchange.resolve({ openid: "wx-concurrent-2", session_key: "second-session-key" });
  assert.equal((await secondRequest).ok, true);
  firstExchange.resolve({ openid: "wx-concurrent-1", session_key: "first-session-key" });
  assert.deepEqual(
    await firstRequest,
    { ok: false, errorCode: "voice_request_superseded" },
  );
  assert.deepEqual(
    await socket.request("voice:wechat:resolve-speakers", {
      openIdList: ["wx-concurrent-2"],
    }),
    { ok: true, speakingPlayerIds: ["alice"] },
  );
}

async function testWechatCredentialIpLimitAllowsSharedNat() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  let fetchCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    const code = new URL(url).searchParams.get("js_code");
    return {
      ok: true,
      json: async () => ({ openid: `wx-${code}`, session_key: "private-session-key" }),
    };
  };
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const targetRoom = harness.room("WXNAT");
  const ipRequestsPerWindow = 64;
  for (let index = 0; index < ipRequestsPerWindow; index += 1) {
    const socket = harness.player(targetRoom, `nat-player-${index}`, { address: "203.0.113.10" });
    assert.equal(
      (await socket.request("voice:wechat:credentials", { code: `nat-code-${index}` })).ok,
      true,
    );
  }
  const limitedSocket = harness.player(targetRoom, "nat-player-limited", {
    address: "203.0.113.10",
  });
  assert.deepEqual(
    await limitedSocket.request("voice:wechat:credentials", { code: "nat-code-limited" }),
    { ok: false, errorCode: "voice_rate_limited" },
  );
  assert.equal(fetchCalls, ipRequestsPerWindow, "an IP-limited request must not reach WeChat");
}

async function testWechatCredentialIpLimiterStaysBoundedAndExpires() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  let currentTime = 1_700_000_000_000;
  const fetchImpl = async (url) => {
    const code = new URL(url).searchParams.get("js_code");
    return {
      ok: true,
      json: async () => ({ openid: `wx-${code}`, session_key: "private-session-key" }),
    };
  };
  const harness = makeHarness({
    env,
    fetchImpl,
    now: () => currentTime,
    randomNonce: () => "fixed-nonce",
  });
  const targetRoom = harness.room("WXIPMAP");
  const maxIpEntries = 256;
  for (let index = 0; index < maxIpEntries + 14; index += 1) {
    const socket = harness.player(targetRoom, `ip-player-${index}`, {
      address: `2001:db8::${index}`,
    });
    assert.equal(
      (await socket.request("voice:wechat:credentials", { code: `ip-code-${index}` })).ok,
      true,
    );
  }
  assert.ok(
    harness.service.debugWechatCredentialIpLimiterCount() <= maxIpEntries,
    "IP limiter storage must remain bounded under address churn",
  );

  currentTime += 60_001;
  const afterExpiry = harness.player(targetRoom, "ip-player-after-expiry", {
    address: "2001:db8::fresh",
  });
  assert.equal(
    (await afterExpiry.request("voice:wechat:credentials", { code: "ip-code-after-expiry" })).ok,
    true,
  );
  assert.equal(harness.service.debugWechatCredentialIpLimiterCount(), 1);
}

async function testWechatCredentialServerWideLimit() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  let fetchCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    const code = new URL(url).searchParams.get("js_code");
    return {
      ok: true,
      json: async () => ({ openid: `wx-${code}`, session_key: "private-session-key" }),
    };
  };
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const targetRoom = harness.room("WXGLOBAL");
  const serverRequestsPerWindow = 512;
  for (let index = 0; index < serverRequestsPerWindow; index += 1) {
    const socket = harness.player(targetRoom, `global-player-${index}`, {
      address: `2001:db8:1::${index}`,
    });
    assert.equal(
      (await socket.request("voice:wechat:credentials", { code: `global-code-${index}` })).ok,
      true,
    );
  }
  const limitedSocket = harness.player(targetRoom, "global-player-limited", {
    address: "2001:db8:1::limited",
  });
  assert.deepEqual(
    await limitedSocket.request("voice:wechat:credentials", { code: "global-code-limited" }),
    { ok: false, errorCode: "voice_rate_limited" },
  );
  assert.equal(fetchCalls, serverRequestsPerWindow, "a server-limited request must not reach WeChat");
}

async function testWechatSpeakerResolution() {
  const env = {
    WX_MINIGAME_APP_ID: "wx20afc706a711eefc",
    WX_MINIGAME_SECRET: "server-only-secret",
    WX_VOIP_ENABLED: "true",
    WX_VOIP_APPROVED: "true",
    WX_VOIP_PRIVACY_CONFIGURED: "true",
  };
  const openIdsByCode = new Map([
    ["code-alice", "wx-open-alice"],
    ["code-bob", "wx-open-bob"],
    ["code-eve", "wx-open-eve"],
  ]);
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({
      openid: openIdsByCode.get(new URL(url).searchParams.get("js_code")),
      session_key: "private-session-key",
    }),
  });
  const harness = makeHarness({ env, fetchImpl, randomNonce: () => "fixed-nonce" });
  const roomA = harness.room("WXMAP");
  const roomB = harness.room("WXOUT");
  const alice = harness.player(roomA, "alice");
  const bob = harness.player(roomA, "bob");
  const eve = harness.player(roomB, "eve");

  assert.equal(
    (await alice.request("voice:wechat:resolve-speakers", { openIdList: [] })).errorCode,
    "voice_wechat_not_joined",
  );
  for (const [socket, code] of [[alice, "code-alice"], [bob, "code-bob"], [eve, "code-eve"]]) {
    const credentials = await socket.request("voice:wechat:credentials", { code });
    assert.equal(credentials.ok, true);
    assert.equal("openId" in credentials, false);
    assert.equal("openid" in credentials, false);
    assert.equal("openIdHash" in credentials, false);
    assert.equal("identityHash" in credentials, false);
  }

  const resolved = await alice.request("voice:wechat:resolve-speakers", {
    openIdList: ["wx-open-bob", "wx-open-alice", "wx-open-bob", "wx-open-eve"],
  });
  assert.deepEqual(resolved, { ok: true, speakingPlayerIds: ["bob", "alice"] });
  assert.equal(
    bob.sent.some(({ event }) => event.startsWith("voice:wechat")),
    false,
    "speaker resolution must stay in the request ACK and never be broadcast",
  );
  assert.equal(JSON.stringify(resolved).includes("wx-open-"), false);

  assert.equal(
    (await alice.request("voice:wechat:resolve-speakers", { openIdList: "wx-open-bob" })).errorCode,
    "voice_speakers_invalid",
  );
  assert.equal(
    (await alice.request("voice:wechat:resolve-speakers", {
      openIdList: Array.from({ length: 9 }, (_, index) => `wx-open-${index}`),
    })).errorCode,
    "voice_speakers_invalid",
  );

  assert.equal((await bob.request("voice:wechat:leave")).ok, true);
  assert.deepEqual(
    await alice.request("voice:wechat:resolve-speakers", { openIdList: ["wx-open-bob"] }),
    { ok: true, speakingPlayerIds: [] },
  );

  const refreshedBob = await bob.request("voice:wechat:credentials", { code: "code-bob" });
  assert.equal(refreshedBob.ok, true);
  bob.disconnectEvent();
  assert.deepEqual(
    await alice.request("voice:wechat:resolve-speakers", { openIdList: ["wx-open-bob"] }),
    { ok: true, speakingPlayerIds: [] },
  );

  let limited;
  for (let index = 0; index <= WECHAT_VOICE_SPEAKER_REQUESTS_PER_WINDOW; index += 1) {
    limited = await eve.request("voice:wechat:resolve-speakers", { openIdList: [] });
  }
  assert.equal(limited.errorCode, "voice_rate_limited");

  harness.service.cleanupRoom("WXMAP", "test_cleanup");
  assert.equal(
    (await alice.request("voice:wechat:resolve-speakers", { openIdList: [] })).errorCode,
    "voice_wechat_not_joined",
  );
}

function emitAck(socket, event, payload = {}, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function waitForServer(url, child, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`voice test server exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("voice test server health timeout");
}

async function testLiveSocketProtocol() {
  const port = 45_000 + (process.pid % 1_000);
  const url = `http://127.0.0.1:${port}`;
  let serverErrors = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      VOICE_WEB_ENABLED: "true",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { serverErrors += chunk; });
  let first;
  let second;
  try {
    await waitForServer(url, child);
    first = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    second = createClient(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    await Promise.all([once(first, "connect"), once(second, "connect")]);
    const created = await emitAck(first, "room:create", { clientId: "voice-live-a", name: "Voice A" });
    assert.equal(created.ok, true);
    const joined = await emitAck(second, "room:join", {
      clientId: "voice-live-b",
      name: "Voice B",
      code: created.code,
    });
    assert.equal(joined.ok, true);

    const firstJoin = await emitAck(first, "voice:web:join");
    const secondJoin = await emitAck(second, "voice:web:join");
    assert.equal(firstJoin.ok, true);
    assert.equal(secondJoin.ok, true);
    assert.equal((await emitAck(first, "voice:web:signal", {
      sessionId: firstJoin.sessionId,
      toPlayerId: joined.playerId,
      description,
    })).errorCode, "voice_session_invalid");

    assert.equal((await emitAck(first, "voice:web:ready", { sessionId: firstJoin.sessionId })).ok, true);
    const joinedStatePromise = once(first, "voice:web:state");
    const secondReady = await emitAck(second, "voice:web:ready", { sessionId: secondJoin.sessionId });
    assert.deepEqual(secondReady.peerIds, [created.playerId]);
    const [joinedState] = await joinedStatePromise;
    assert.equal(joinedState.kind, "peer_joined");
    assert.equal(joinedState.playerId, joined.playerId);

    const signalPromise = once(second, "voice:web:signal");
    assert.equal((await emitAck(first, "voice:web:signal", {
      sessionId: firstJoin.sessionId,
      toPlayerId: joined.playerId,
      description,
    })).ok, true);
    const [signal] = await signalPromise;
    assert.equal(signal.sessionId, secondJoin.sessionId);
    assert.equal(signal.fromPlayerId, created.playerId);
    assert.deepEqual(signal.description, description);

    const leftStatePromise = once(first, "voice:web:state");
    assert.equal((await emitAck(second, "voice:web:leave", {
      sessionId: secondJoin.sessionId,
      reason: "test_complete",
    })).ok, true);
    const [leftState] = await leftStatePromise;
    assert.equal(leftState.kind, "peer_left");
    assert.equal(leftState.playerId, joined.playerId);
  } finally {
    first?.disconnect();
    second?.disconnect();
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (child.exitCode && serverErrors) process.stderr.write(serverErrors);
  }
}

await testWebProtocol();
await testCapacityAndRateLimit();
await testWechatSigning();
await testWechatCredentialBindingRace();
await testWechatCredentialLatestRequestWins();
await testWechatLeaveInvalidatesPendingCredentials();
await testWechatCleanupInvalidatesPendingCredentials();
await testWechatCredentialSocketLimitSurvivesRebinding();
await testWechatCredentialConcurrencyLimit();
await testWechatCredentialIpLimitAllowsSharedNat();
await testWechatCredentialIpLimiterStaysBoundedAndExpires();
await testWechatCredentialServerWideLimit();
await testWechatSpeakerResolution();
testTurnCredentials();
await testLiveSocketProtocol();
console.log("voice server protocol: ok");
