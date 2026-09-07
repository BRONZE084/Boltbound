import crypto from "node:crypto";

export const WEB_VOICE_MAX_PARTICIPANTS = 4;
export const WEB_VOICE_MAX_SIGNAL_BYTES = 24 * 1024;
export const WEB_VOICE_SIGNAL_WINDOW_MS = 10_000;
export const WEB_VOICE_SIGNALS_PER_WINDOW = 120;
export const WEB_VOICE_CONTROL_WINDOW_MS = 10_000;
export const WEB_VOICE_CONTROLS_PER_WINDOW = 30;
export const WECHAT_VOICE_SPEAKER_REQUESTS_PER_WINDOW = 60;

const RESERVATION_TTL_MS = 15_000;
const WECHAT_CODE_WINDOW_MS = 60_000;
const WECHAT_CODES_PER_WINDOW = 4;
const WECHAT_SOCKET_CODES_PER_WINDOW = 8;
const WECHAT_IP_CODES_PER_WINDOW = 64;
const WECHAT_IP_LIMITER_MAX_ENTRIES = 256;
const WECHAT_SERVER_CODES_PER_WINDOW = 512;
const WECHAT_MAX_CONCURRENT_CODE_EXCHANGES_PER_SOCKET = 2;
const WECHAT_VOICE_MAX_SPEAKER_IDS = 8;
const WECHAT_VOICE_MAX_SPEAKER_PAYLOAD_BYTES = 2 * 1024;
const WECHAT_VOICE_SPEAKER_WINDOW_MS = 10_000;

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function cleanId(value, maxLength = 128) {
  return String(value || "").trim().slice(0, maxLength);
}

function splitUrls(value, fallback = []) {
  const source = String(value || "").trim();
  const values = source ? source.split(",") : fallback;
  return [...new Set(values.map((url) => url.trim()).filter((url) => /^(stun|turn|turns):/i.test(url)))];
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function fail(ack, errorCode) {
  reply(ack, { ok: false, errorCode });
}

function payloadBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validSpeakerOpenIds(payload) {
  if (payloadBytes(payload) > WECHAT_VOICE_MAX_SPEAKER_PAYLOAD_BYTES) return null;
  if (!Array.isArray(payload?.openIdList)) return null;
  if (payload.openIdList.length > WECHAT_VOICE_MAX_SPEAKER_IDS) return null;
  const unique = new Set();
  for (const candidate of payload.openIdList) {
    if (typeof candidate !== "string") return null;
    const openId = candidate.trim();
    if (!openId || openId.length > 128) return null;
    unique.add(openId);
  }
  return [...unique];
}

function validDescription(description) {
  if (!description || typeof description !== "object" || Array.isArray(description)) return false;
  if (!["offer", "answer"].includes(description.type)) return false;
  return typeof description.sdp === "string" && description.sdp.length > 0 && description.sdp.length <= 18_000;
}

function validCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  if (typeof candidate.candidate !== "string" || candidate.candidate.length > 8_000) return false;
  if (candidate.sdpMid != null && typeof candidate.sdpMid !== "string") return false;
  if (candidate.sdpMLineIndex != null && !Number.isInteger(candidate.sdpMLineIndex)) return false;
  if (candidate.usernameFragment != null && typeof candidate.usernameFragment !== "string") return false;
  return true;
}

function consumeWindow(holder, key, now, limit, windowMs) {
  const current = holder[key];
  if (!current || now - current.startedAt >= windowMs) {
    holder[key] = { startedAt: now, count: 1 };
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function createIceConfiguration(
  env = process.env,
  { nowMs = Date.now(), identity = "boltbound" } = {},
) {
  const stunUrls = splitUrls(env.VOICE_STUN_URLS, ["stun:stun.cloudflare.com:3478"]);
  const turnUrls = splitUrls(env.VOICE_TURN_URLS);
  const turnSecret = cleanId(env.VOICE_TURN_SECRET, 512);
  const requestedTtl = Number(env.VOICE_TURN_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(requestedTtl)
    ? Math.min(86_400, Math.max(300, Math.trunc(requestedTtl)))
    : 3_600;
  const safeIdentity = cleanId(identity, 160).replace(/[^a-zA-Z0-9_.-]/g, "_") || "boltbound";
  const expiresAt = Math.floor(Number(nowMs) / 1_000) + ttlSeconds;
  const turnUsername = `${expiresAt}:${safeIdentity}`;
  const turnCredential = turnSecret
    ? crypto.createHmac("sha1", turnSecret).update(turnUsername).digest("base64")
    : "";
  const turnConfigured = Boolean(turnUrls.length && turnSecret);
  const iceServers = [];
  if (stunUrls.length) iceServers.push({ urls: stunUrls });
  if (turnConfigured) {
    iceServers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
  }
  return {
    iceServers,
    turnConfigured,
    warningCode: turnConfigured ? null : "turn_not_configured",
  };
}

export function wechatVoiceCapability(env = process.env) {
  const appId = cleanId(env.WX_MINIGAME_APP_ID, 64);
  const secret = cleanId(env.WX_MINIGAME_SECRET, 256);
  const featureEnabled = enabled(env.WX_VOIP_ENABLED);
  const approvalGranted = enabled(env.WX_VOIP_APPROVED);
  const privacyConfigured = enabled(env.WX_VOIP_PRIVACY_CONFIGURED);
  let reason = null;
  if (!/^wx[a-zA-Z0-9_-]{6,}$/.test(appId) || appId === "touristappid" || !secret) {
    reason = "not_configured";
  } else if (!featureEnabled) {
    reason = "feature_disabled";
  } else if (!approvalGranted) {
    reason = "approval_required";
  } else if (!privacyConfigured) {
    reason = "privacy_not_configured";
  }
  return {
    available: reason === null,
    reason,
    appId: /^wx[a-zA-Z0-9_-]{6,}$/.test(appId) ? appId : "",
    enabled: featureEnabled,
    approvalGranted,
    privacyConfigured,
    nativeOnly: true,
  };
}

export function createWechatVoipSignature({ appId, groupId, nonceStr, timeStamp, sessionKey }) {
  const signedText = [appId, groupId, nonceStr, String(timeStamp)]
    .map((value) => String(value || ""))
    .sort()
    .join("");
  return crypto.createHmac("sha256", String(sessionKey || "")).update(signedText).digest("hex");
}

async function exchangeWechatCode({ code, env, fetchImpl, timeoutMs = 5_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", env.WX_MINIGAME_APP_ID);
    url.searchParams.set("secret", env.WX_MINIGAME_SECRET);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) throw new Error("wechat_http_error");
    const body = await response.json();
    if (body?.errcode || !body?.session_key || !body?.openid) throw new Error("wechat_session_error");
    return { sessionKey: String(body.session_key), openId: cleanId(body.openid) };
  } finally {
    clearTimeout(timer);
  }
}

export function createVoiceService({
  io,
  getBoundRoom,
  getBoundPlayer,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  randomNonce = () => crypto.randomBytes(16).toString("hex"),
  wechatIdentitySecret = crypto.randomBytes(32),
} = {}) {
  if (!io || typeof getBoundRoom !== "function" || typeof getBoundPlayer !== "function") {
    throw new Error("voice_service_not_configured");
  }

  const sessionsBySocket = new Map();
  const roomSessions = new Map();
  const participantLimits = new Map();
  const wechatIdentitiesBySocket = new Map();
  const wechatIdentitiesByRoom = new Map();
  const wechatCredentialEpochs = new WeakMap();
  const wechatCredentialSocketLimits = new WeakMap();
  const wechatCredentialInFlightBySocket = new WeakMap();
  const wechatCredentialIpLimits = new Map();
  const wechatCredentialServerLimit = {};

  function capabilities() {
    const ice = createIceConfiguration(env);
    return {
      ok: true,
      web: {
        available: !/^(0|false|off|no)$/i.test(String(env.VOICE_WEB_ENABLED || "true")),
        maxParticipants: WEB_VOICE_MAX_PARTICIPANTS,
        secureContextRequired: true,
        turnConfigured: ice.turnConfigured,
        warningCode: ice.warningCode,
      },
      wechat: wechatVoiceCapability(env),
      channelsInteroperate: false,
      channelIsolation: true,
    };
  }

  function sessionsForRoom(roomCode) {
    let sessions = roomSessions.get(roomCode);
    if (!sessions) {
      sessions = new Map();
      roomSessions.set(roomCode, sessions);
    }
    return sessions;
  }
  function participantKey(roomCode, playerId) {
    return `${roomCode}:${playerId}`;
  }

  function limitsFor(roomCode, playerId) {
    const key = participantKey(roomCode, playerId);
    let limiter = participantLimits.get(key);
    if (!limiter) {
      limiter = {};
      participantLimits.set(key, limiter);
    }
    return limiter;
  }

  function limitsForWechatCredentialSocket(socket) {
    let limiter = wechatCredentialSocketLimits.get(socket);
    if (!limiter) {
      limiter = {};
      wechatCredentialSocketLimits.set(socket, limiter);
    }
    return limiter;
  }

  function wechatCredentialAddress(socket) {
    const address = cleanId(
      socket.handshake?.address ||
        socket.conn?.remoteAddress ||
        socket.request?.socket?.remoteAddress,
      128,
    ).toLowerCase();
    if (address.startsWith("::ffff:")) return address.slice(7);
    return address || `socket:${cleanId(socket.id, 128)}`;
  }

  function pruneWechatCredentialIpLimits(nowMs) {
    for (const [address, limiter] of wechatCredentialIpLimits) {
      if (nowMs - Number(limiter.lastSeenAt) >= WECHAT_CODE_WINDOW_MS) {
        wechatCredentialIpLimits.delete(address);
      }
    }
    while (wechatCredentialIpLimits.size >= WECHAT_IP_LIMITER_MAX_ENTRIES) {
      const oldestAddress = wechatCredentialIpLimits.keys().next().value;
      if (oldestAddress === undefined) break;
      wechatCredentialIpLimits.delete(oldestAddress);
    }
  }

  function limitsForWechatCredentialIp(socket, nowMs) {
    const address = wechatCredentialAddress(socket);
    let limiter = wechatCredentialIpLimits.get(address);
    if (!limiter) {
      pruneWechatCredentialIpLimits(nowMs);
      limiter = {};
    } else {
      wechatCredentialIpLimits.delete(address);
    }
    limiter.lastSeenAt = nowMs;
    wechatCredentialIpLimits.set(address, limiter);
    return limiter;
  }

  function advanceWechatCredentialEpoch(socket) {
    const epoch = (wechatCredentialEpochs.get(socket) || 0) + 1;
    wechatCredentialEpochs.set(socket, epoch);
    return epoch;
  }

  function isCurrentWechatCredentialRequest(socket, epoch) {
    return wechatCredentialEpochs.get(socket) === epoch;
  }

  function invalidateWechatCredentialsForBinding(roomCode, playerId = null) {
    for (const socket of io.sockets?.sockets?.values?.() || []) {
      if (socket.data?.roomCode !== roomCode) continue;
      if (playerId !== null && socket.data?.playerId !== playerId) continue;
      advanceWechatCredentialEpoch(socket);
    }
  }

  function fingerprintWechatOpenId(openId) {
    return crypto
      .createHmac("sha256", wechatIdentitySecret)
      .update(openId)
      .digest("base64url");
  }

  function wechatIdentitiesForRoom(roomCode) {
    let identities = wechatIdentitiesByRoom.get(roomCode);
    if (!identities) {
      identities = new Map();
      wechatIdentitiesByRoom.set(roomCode, identities);
    }
    return identities;
  }

  function clearWechatIdentityForSocket(socketId) {
    const identity = wechatIdentitiesBySocket.get(socketId);
    if (!identity) return false;
    wechatIdentitiesBySocket.delete(socketId);
    const identities = wechatIdentitiesByRoom.get(identity.roomCode);
    if (identities?.get(identity.identityHash) === identity) {
      identities.delete(identity.identityHash);
    }
    if (!identities?.size) wechatIdentitiesByRoom.delete(identity.roomCode);
    return true;
  }

  function clearWechatIdentityForPlayer(roomCode, playerId) {
    const identities = wechatIdentitiesByRoom.get(roomCode);
    if (!identities) return false;
    let cleared = false;
    for (const [identityHash, identity] of identities) {
      if (identity.playerId !== playerId) continue;
      identities.delete(identityHash);
      if (wechatIdentitiesBySocket.get(identity.socketId) === identity) {
        wechatIdentitiesBySocket.delete(identity.socketId);
      }
      cleared = true;
    }
    if (!identities.size) wechatIdentitiesByRoom.delete(roomCode);
    return cleared;
  }

  function registerWechatIdentity(socket, room, player, openId) {
    const identityHash = fingerprintWechatOpenId(openId);
    const existing = wechatIdentitiesByRoom.get(room.code)?.get(identityHash);
    if (existing && existing.playerId !== player.id) return false;
    clearWechatIdentityForSocket(socket.id);
    clearWechatIdentityForPlayer(room.code, player.id);
    const identity = {
      roomCode: room.code,
      playerId: player.id,
      socketId: socket.id,
      identityHash,
    };
    wechatIdentitiesBySocket.set(socket.id, identity);
    wechatIdentitiesForRoom(room.code).set(identityHash, identity);
    return true;
  }


  function activeSession(socket, sessionId) {
    const session = sessionsBySocket.get(socket.id);
    return session && session.id === cleanId(sessionId) ? session : null;
  }

  function readyPeers(session) {
    return [...(roomSessions.get(session.roomCode)?.values() || [])].filter(
      (candidate) => candidate.ready && candidate.id !== session.id,
    );
  }

  function notifyPeerState(session, kind) {
    for (const peer of readyPeers(session)) {
      io.to(peer.socketId).emit("voice:web:state", {
        sessionId: peer.id,
        kind,
        playerId: session.playerId,
      });
    }
  }

  function cleanupSocket(socket, reason = "leave", { includeWechat = true } = {}) {
    advanceWechatCredentialEpoch(socket);
    const wechatCleared = includeWechat
      ? clearWechatIdentityForSocket(socket.id)
      : false;
    const session = sessionsBySocket.get(socket.id);
    if (!session) return wechatCleared;
    sessionsBySocket.delete(socket.id);
    clearTimeout(session.reservationTimer);
    const sessions = roomSessions.get(session.roomCode);
    sessions?.delete(session.id);
    if (!sessions?.size) roomSessions.delete(session.roomCode);
    if (session.ready) notifyPeerState(session, "peer_left");
    socket.data.voiceWebSessionId = null;
    return { sessionId: session.id, playerId: session.playerId, reason };
  }

  function cleanupPlayer(roomCode, playerId, reason = "player_removed") {
    invalidateWechatCredentialsForBinding(roomCode, playerId);
    const wechatCleared = clearWechatIdentityForPlayer(roomCode, playerId);
    const target = [...(roomSessions.get(roomCode)?.values() || [])].find(
      (session) => session.playerId === playerId,
    );
    participantLimits.delete(participantKey(roomCode, playerId));
    if (!target) return wechatCleared;
    const socket = io.sockets?.sockets?.get(target.socketId);
    if (socket) return cleanupSocket(socket, reason);
    const sessions = roomSessions.get(roomCode);
    sessionsBySocket.delete(target.socketId);
    clearTimeout(target.reservationTimer);
    sessions?.delete(target.id);
    if (target.ready) notifyPeerState(target, "peer_left");
    if (!sessions?.size) roomSessions.delete(roomCode);
    return true;
  }

  function cleanupRoom(roomCode, reason = "room_removed") {
    invalidateWechatCredentialsForBinding(roomCode);
    const sessions = [...(roomSessions.get(roomCode)?.values() || [])];
    for (const session of sessions) {
      const socket = io.sockets?.sockets?.get(session.socketId);
      if (socket) cleanupSocket(socket, reason);
      else {
        sessionsBySocket.delete(session.socketId);
        clearTimeout(session.reservationTimer);
      }
    }
    const identities = wechatIdentitiesByRoom.get(roomCode);
    for (const identity of identities?.values() || []) {
      if (wechatIdentitiesBySocket.get(identity.socketId) === identity) {
        wechatIdentitiesBySocket.delete(identity.socketId);
      }
    }
    wechatIdentitiesByRoom.delete(roomCode);
    roomSessions.delete(roomCode);
    const prefix = `${roomCode}:`;
    for (const key of participantLimits.keys()) if (key.startsWith(prefix)) participantLimits.delete(key);
  }

  function boundHuman(socket, ack) {
    const room = getBoundRoom(socket);
    const player = getBoundPlayer(socket, room);
    if (!room || !player || player.bot || !player.connected || player.socketId !== socket.id) {
      fail(ack, "voice_not_in_room");
      return null;
    }
    return { room, player };
  }

  function reserveWeb(socket, _payload, ack) {
    const bound = boundHuman(socket, ack);
    if (!bound) return;
    const config = capabilities();
    if (!config.web.available) return fail(ack, "voice_disabled");
    if (!consumeWindow(limitsFor(bound.room.code, bound.player.id), "controlWindow", now(), WEB_VOICE_CONTROLS_PER_WINDOW, WEB_VOICE_CONTROL_WINDOW_MS)) {
      return fail(ack, "voice_rate_limited");
    }
    cleanupSocket(socket, "replace_session", { includeWechat: false });
    const sessions = sessionsForRoom(bound.room.code);
    if (sessions.size >= WEB_VOICE_MAX_PARTICIPANTS) return fail(ack, "voice_room_full");
    const session = {
      id: cleanId(randomId()),
      roomCode: bound.room.code,
      playerId: bound.player.id,
      socketId: socket.id,
      ready: false,
      createdAt: now(),
      reservationTimer: null,
    };
    const ice = createIceConfiguration(env, {
      nowMs: now(),
      identity: `${bound.room.code}-${bound.player.id}-${session.id}`,
    });
    session.reservationTimer = setTimeout(() => {
      if (!session.ready && sessionsBySocket.get(socket.id) === session) {
        cleanupSocket(socket, "reservation_expired", { includeWechat: false });
        socket.emit("voice:web:state", {
          sessionId: session.id,
          kind: "reservation_expired",
          playerId: session.playerId,
        });
      }
    }, RESERVATION_TTL_MS);
    session.reservationTimer.unref?.();
    sessionsBySocket.set(socket.id, session);
    sessions.set(session.id, session);
    socket.data.voiceWebSessionId = session.id;
    reply(ack, {
      ok: true,
      sessionId: session.id,
      playerId: session.playerId,
      peerIds: [],
      iceServers: ice.iceServers,
      turnConfigured: ice.turnConfigured,
      warningCode: ice.warningCode,
    });
  }

  function readyWeb(socket, payload, ack) {
    const bound = boundHuman(socket, ack);
    if (!bound) return;
    const session = activeSession(socket, payload?.sessionId);
    if (!session || session.roomCode !== bound.room.code || session.playerId !== bound.player.id) {
      return fail(ack, "voice_session_invalid");
    }
    if (!session.ready) {
      if (!consumeWindow(limitsFor(bound.room.code, bound.player.id), "controlWindow", now(), WEB_VOICE_CONTROLS_PER_WINDOW, WEB_VOICE_CONTROL_WINDOW_MS)) {
        return fail(ack, "voice_rate_limited");
      }
      clearTimeout(session.reservationTimer);
      session.reservationTimer = null;
      session.ready = true;
      notifyPeerState(session, "peer_joined");
    }
    reply(ack, { ok: true, sessionId: session.id, peerIds: readyPeers(session).map((peer) => peer.playerId) });
  }

  function signalWeb(socket, payload, ack) {
    const bound = boundHuman(socket, ack);
    if (!bound) return;
    const session = activeSession(socket, payload?.sessionId);
    if (!session?.ready || session.roomCode !== bound.room.code || session.playerId !== bound.player.id) {
      return fail(ack, "voice_session_invalid");
    }
    if (!consumeWindow(limitsFor(bound.room.code, bound.player.id), "signalWindow", now(), WEB_VOICE_SIGNALS_PER_WINDOW, WEB_VOICE_SIGNAL_WINDOW_MS)) {
      return fail(ack, "voice_rate_limited");
    }
    if (payloadBytes(payload) > WEB_VOICE_MAX_SIGNAL_BYTES) return fail(ack, "voice_payload_too_large");
    const hasDescription = validDescription(payload?.description);
    const hasCandidate = validCandidate(payload?.candidate);
    if (hasDescription === hasCandidate) return fail(ack, "voice_signal_invalid");
    const targetPlayerId = cleanId(payload?.toPlayerId, 120);
    const target = readyPeers(session).find((peer) => peer.playerId === targetPlayerId);
    if (!target) return fail(ack, "voice_target_unavailable");
    io.to(target.socketId).emit("voice:web:signal", {
      sessionId: target.id,
      fromPlayerId: session.playerId,
      ...(hasDescription ? { description: payload.description } : { candidate: payload.candidate }),
    });
    reply(ack, { ok: true });
  }

  function leaveWeb(socket, payload, ack) {
    const session = sessionsBySocket.get(socket.id);
    if (session && payload?.sessionId && session.id !== cleanId(payload.sessionId)) {
      return fail(ack, "voice_session_invalid");
    }
    const allowed = !session || consumeWindow(
      limitsFor(session.roomCode, session.playerId),
      "controlWindow", now(), WEB_VOICE_CONTROLS_PER_WINDOW, WEB_VOICE_CONTROL_WINDOW_MS,
    );
    cleanupSocket(socket, cleanId(payload?.reason, 64) || "leave", { includeWechat: false });
    if (!allowed) return fail(ack, "voice_rate_limited");
    reply(ack, { ok: true });
  }

  async function wechatCredentials(socket, payload, ack) {
    const bound = boundHuman(socket, ack);
    if (!bound) return;
    const capability = wechatVoiceCapability(env);
    if (!capability.available) return fail(ack, capability.reason);
    if (typeof fetchImpl !== "function") return fail(ack, "signing_unavailable");
    const code = String(payload?.code || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(code)) return fail(ack, "invalid_login_code");
    const inFlight = wechatCredentialInFlightBySocket.get(socket) || 0;
    if (inFlight >= WECHAT_MAX_CONCURRENT_CODE_EXCHANGES_PER_SOCKET) {
      return fail(ack, "voice_rate_limited");
    }
    const requestNow = now();
    const limiter = limitsFor(bound.room.code, bound.player.id);
    if (!consumeWindow(limiter, "codeWindow", requestNow, WECHAT_CODES_PER_WINDOW, WECHAT_CODE_WINDOW_MS)) {
      return fail(ack, "voice_rate_limited");
    }
    if (!consumeWindow(
      limitsForWechatCredentialSocket(socket),
      "codeWindow",
      requestNow,
      WECHAT_SOCKET_CODES_PER_WINDOW,
      WECHAT_CODE_WINDOW_MS,
    )) {
      return fail(ack, "voice_rate_limited");
    }
    if (!consumeWindow(
      limitsForWechatCredentialIp(socket, requestNow),
      "codeWindow",
      requestNow,
      WECHAT_IP_CODES_PER_WINDOW,
      WECHAT_CODE_WINDOW_MS,
    )) {
      return fail(ack, "voice_rate_limited");
    }
    if (!consumeWindow(
      wechatCredentialServerLimit,
      "codeWindow",
      requestNow,
      WECHAT_SERVER_CODES_PER_WINDOW,
      WECHAT_CODE_WINDOW_MS,
    )) {
      return fail(ack, "voice_rate_limited");
    }
    wechatCredentialInFlightBySocket.set(socket, inFlight + 1);
    const credentialEpoch = advanceWechatCredentialEpoch(socket);
    try {
      const { sessionKey, openId } = await exchangeWechatCode({ code, env, fetchImpl });
      const currentBound = boundHuman(socket, ack);
      if (!currentBound) return;
      if (currentBound.room !== bound.room || currentBound.player !== bound.player) {
        return fail(ack, "voice_not_in_room");
      }
      if (!isCurrentWechatCredentialRequest(socket, credentialEpoch)) {
        return fail(ack, "voice_request_superseded");
      }
      const groupId = `boltbound_${bound.room.code}`;
      const nonceStr = cleanId(randomNonce(), 96);
      const timeStamp = Math.floor(now() / 1_000);
      const signature = createWechatVoipSignature({
        appId: env.WX_MINIGAME_APP_ID,
        groupId,
        nonceStr,
        timeStamp,
        sessionKey,
      });
      if (!registerWechatIdentity(socket, bound.room, bound.player, openId)) {
        return fail(ack, "voice_identity_in_use");
      }
      reply(ack, { ok: true, groupId, nonceStr, timeStamp, signature });
    } catch {
      fail(ack, "signing_unavailable");
    } finally {
      const remaining = (wechatCredentialInFlightBySocket.get(socket) || 1) - 1;
      if (remaining > 0) wechatCredentialInFlightBySocket.set(socket, remaining);
      else wechatCredentialInFlightBySocket.delete(socket);
    }
  }

  function resolveWechatSpeakers(socket, payload, ack) {
    const bound = boundHuman(socket, ack);
    if (!bound) return;
    const reporter = wechatIdentitiesBySocket.get(socket.id);
    if (
      !reporter ||
      reporter.roomCode !== bound.room.code ||
      reporter.playerId !== bound.player.id
    ) return fail(ack, "voice_wechat_not_joined");
    if (!consumeWindow(
      limitsFor(bound.room.code, bound.player.id),
      "wechatSpeakerWindow",
      now(),
      WECHAT_VOICE_SPEAKER_REQUESTS_PER_WINDOW,
      WECHAT_VOICE_SPEAKER_WINDOW_MS,
    )) return fail(ack, "voice_rate_limited");
    const openIds = validSpeakerOpenIds(payload);
    if (!openIds) return fail(ack, "voice_speakers_invalid");

    const identities = wechatIdentitiesByRoom.get(bound.room.code);
    const speakingPlayerIds = [];
    const seenPlayerIds = new Set();
    for (const openId of openIds) {
      const identity = identities?.get(fingerprintWechatOpenId(openId));
      if (!identity || seenPlayerIds.has(identity.playerId)) continue;
      const player = bound.room.players.get(identity.playerId);
      if (
        !player ||
        player.bot ||
        !player.connected ||
        player.socketId !== identity.socketId
      ) continue;
      seenPlayerIds.add(identity.playerId);
      speakingPlayerIds.push(identity.playerId);
    }
    reply(ack, { ok: true, speakingPlayerIds });
  }

  function leaveWechat(socket, ack) {
    advanceWechatCredentialEpoch(socket);
    clearWechatIdentityForSocket(socket.id);
    reply(ack, { ok: true });
  }

  function bindSocket(socket) {
    socket.on("voice:capabilities", (_payload = {}, ack) => reply(ack, capabilities()));
    socket.on("voice:web:join", (payload = {}, ack) => reserveWeb(socket, payload, ack));
    socket.on("voice:web:ready", (payload = {}, ack) => readyWeb(socket, payload, ack));
    socket.on("voice:web:signal", (payload = {}, ack) => signalWeb(socket, payload, ack));
    socket.on("voice:web:leave", (payload = {}, ack) => leaveWeb(socket, payload, ack));
    socket.on("voice:wechat:credentials", (payload = {}, ack) => {
      void wechatCredentials(socket, payload, ack);
    });
    socket.on("voice:wechat:resolve-speakers", (payload = {}, ack) => resolveWechatSpeakers(socket, payload, ack));
    socket.on("voice:wechat:leave", (_payload = {}, ack) => leaveWechat(socket, ack));
    socket.on("disconnect", () => {
      cleanupSocket(socket, "socket_disconnect");
    });
  }

  return {
    bindSocket,
    capabilities,
    cleanupPlayer,
    cleanupRoom,
    cleanupSocket,
    debugLimiterCount: () => participantLimits.size,
    debugWechatCredentialIpLimiterCount: () => wechatCredentialIpLimits.size,
    debugSessions: () => [...sessionsBySocket.values()].map((session) => ({ ...session, reservationTimer: null })),
    debugRoomCount: () => roomSessions.size,
  };
}
