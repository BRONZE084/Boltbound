import Phaser from "phaser";
import { io } from "socket.io-client";
import { ACTIVE_ITEMS, DRAFT_ITEMS, PIECES, TARGET_SELECTION_MS } from "../../shared/gameConfig.js";
import { buildItemTargetOptions, isTargetSelectionError } from "../../shared/itemTargets.js";
import { GameAudio } from "../audio/GameAudio.js";
import { BoltboundScene } from "../game/BoltboundScene.js";
import { WechatUiScene } from "./WechatUiScene.js";
import { WechatAudioBackend } from "./WechatAudioBackend.js";
import {
  WECHAT_SETTINGS_STORAGE_KEY,
  applyRenderProfileToScene,
  applyWechatRenderProfile,
  getWechatRenderProfile,
  loadWechatRuntimeSettings,
  normalizeWechatSettings,
  planWechatSettingsVoiceGesture,
} from "./WechatSettings.js";
import { WECHAT_VOICE_REASON_MESSAGES, WechatVoiceChat } from "./WechatVoiceChat.js";
import { WxSocketTransport } from "./WxSocketTransport.js";
import {
  canvasForGame,
  configuredMiniGameConfig,
  configuredServerUrl,
  configuredSocketPath,
  copyText,
  createId,
  editText,
  ensureWechatPrivacyConsent,
  isWechatRuntime,
  platformName,
  recoverWechatRecordPermission,
  storageGet,
  storageRemove,
  storageSet,
  wechatLoginCode,
} from "./platform.js";

globalThis.__ZAOLU_MINIGAME__ = true;

const errorMessages = {
  room_not_found: "没有找到这个房间",
  game_in_progress: "比赛已经开始",
  room_full: "房间已经满员",
  identity_in_use: "这个身份已在房间中",
  already_in_room: "当前连接已经在房间中",
  resume_denied: "房间已失效，请重新加入",
  host_only: "只有房主可以操作",
  invalid_phase: "当前阶段不能这样操作",
  not_enough_players: "至少需要两名玩家",
  stale_state: "状态已更新，请再试一次",
  stale_turn: "这轮搭建已经结束",
  stale_build: "这轮搭建已经结束",
  stale_draft: "这轮选件已经结束",
  not_your_turn: "还没有轮到你",
  already_decided: "本轮已经提交",
  duplicate_action: "这个操作已经提交",
  invalid_choice: "这个零件不在本轮选项中",
  already_picked: "本轮已经选好零件",
  invalid_piece: "零件数据无效",
  out_of_bounds: "不能放在场地外",
  reserved_zone: "起点和终点需要保持畅通",
  piece_overlap: "位置刚被占用，请换一个位置",
  stale_map: "地图已经更新",
  finish_not_verified: "尚未抵达终点",
  no_item: "本轮没有主动道具",
  item_used: "本轮道具已经使用",
  item_cooldown: "道具还在冷却",
  stale_item: "本道具已经失效",
  invalid_target: "请选择其他玩家",
  target_unavailable: "目标当前不可用",
  target_debuff_active: "目标已有负面效果",
  target_immune: "目标正处于短暂无敌",
  target_shielded: "目标的护盾正在生效",
  effect_active: "相同效果正在生效",
};

let currentState = null;
let currentSession = readSession();
let game = null;
let gameScene = null;
let uiScene = null;
let pendingResume = false;
let resumeAttempt = 0;
let pendingLobbyAction = false;
let lobbyActionAttempt = 0;
let roomBound = false;
let pendingBuildId = null;
let pendingDraftId = null;
let previewValid = false;
let previewAngle = 0;
let clockSyncGeneration = 0;
let bestClockSample = { offset: 0, rtt: Number.POSITIVE_INFINITY };
let pendingItemAction = null;
let itemTargetSelection = null;
let voiceCapability = {
  loaded: false,
  available: false,
  appId: "",
  enabled: false,
  approvalGranted: false,
  privacyConfigured: false,
  reason: null,
  message: "正在检测微信语音",
};
let voiceChannelIsolation = true;
let voiceChat = null;
let voiceCapabilityPromise = null;
let voiceJoinPromise = null;
let voiceCapabilityAttempt = 0;
let voiceActionBusy = false;
let wechatSettings = loadWechatRuntimeSettings(storageGet(WECHAT_SETTINGS_STORAGE_KEY));
storageSet(WECHAT_SETTINGS_STORAGE_KEY, JSON.stringify(wechatSettings));
const gameAudio = new GameAudio({
  backend: new WechatAudioBackend(),
  platform: "wechat",
  initialSettings: wechatSettings,
});
let activeRenderProfile = getWechatRenderProfile(wechatSettings.quality);
let homeName = storageGet("playerName") || `工友${Math.floor(10 + Math.random() * 90)}`;
let homeRoomCode = "";

let clientId = storageGet("clientId");
if (!clientId) {
  clientId = createId("client");
  storageSet("clientId", clientId);
}

const serverUrl = configuredServerUrl();
const socketPath = configuredSocketPath();
const socket = io(serverUrl, {
  autoConnect: true,
  transports: isWechatRuntime() ? [WxSocketTransport] : ["websocket"],
  upgrade: false,
  forceBase64: true,
  path: socketPath,
  reconnection: true,
  reconnectionDelayMax: 2_000,
  timeout: 10_000,
});

const localVoiceConfig = configuredMiniGameConfig()?.voice || {};
const voiceMessages = Object.freeze({
  ...WECHAT_VOICE_REASON_MESSAGES,
  capability_check_failed: "微信语音能力检测失败，请稍后重试",
  join_failed: "暂时无法加入微信语音",
  api_unavailable: "当前微信版本不支持实时语音",
});

function voiceMessage(reason, fallback = "微信语音暂不可用") {
  return voiceMessages[reason] || fallback;
}

function settingsUiSnapshot() {
  return {
    ...wechatSettings,
    renderProfile: { ...activeRenderProfile },
    landscape: true,
  };
}

function syncSettingsUi() {
  uiScene?.setSettingsState(settingsUiSnapshot());
}

function persistWechatSettings(patch = {}) {
  wechatSettings = normalizeWechatSettings({ ...wechatSettings, ...patch });
  activeRenderProfile = getWechatRenderProfile(wechatSettings.quality);
  gameAudio.setSettings(wechatSettings);
  storageSet(WECHAT_SETTINGS_STORAGE_KEY, JSON.stringify(wechatSettings));
  syncSettingsUi();
  return wechatSettings;
}

function resetMicrophonePreference() {
  if (!wechatSettings.micEnabled) return;
  persistWechatSettings({ micEnabled: false });
}

function applyCurrentRenderProfile() {
  const activeGame = game || gameScene?.game || uiScene?.game || null;
  activeRenderProfile = applyWechatRenderProfile({
    game: activeGame,
    scenes: [gameScene, uiScene],
    quality: wechatSettings.quality,
  });
  syncSettingsUi();
  return activeRenderProfile;
}

function updateRenderQuality(quality) {
  const previous = wechatSettings.quality;
  persistWechatSettings({ quality });
  applyCurrentRenderProfile();
  if (wechatSettings.quality !== previous) {
    showToast(`画质已切换为${wechatSettings.quality === "performance" ? "性能" : wechatSettings.quality === "clear" ? "清晰" : "平衡"}`);
  }
}

function updateAudioSetting(key, value) {
  if (["musicEnabled", "effectsEnabled"].includes(key)) {
    persistWechatSettings({ [key]: value === true });
    return;
  }
  if (["musicVolume", "effectsVolume"].includes(key)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    persistWechatSettings({ [key]: numeric });
  }
}

async function runSettingsVoiceAction(kind) {
  const normalizedKind = kind === "mic" ? "mic" : "speaker";
  const key = normalizedKind === "mic" ? "micEnabled" : "speakerEnabled";
  const state = voiceUiSnapshot().state;
  const plan = planWechatSettingsVoiceGesture({
    kind: normalizedKind,
    hasSession: Boolean(currentSession),
    joined: state.joined === true,
    micMuted: state.micMuted,
    speakerMuted: state.speakerMuted,
    micEnabled: wechatSettings.micEnabled,
    speakerEnabled: wechatSettings.speakerEnabled,
  });
  if (plan.preferenceChanged) persistWechatSettings({ [key]: plan.desiredEnabled });

  if (!plan.shouldRunVoiceAction) {
    if (currentSession) {
      showToast("语音偏好已关闭");
      return;
    }
    showToast("语音偏好已保存，进入房间后点击开启");
    return;
  }
  await runVoiceAction(normalizedKind, { desiredEnabled: plan.desiredEnabled });
}

async function retryVoiceCapability() {
  const snapshot = voiceUiSnapshot();
  const permissionDenied = snapshot.state?.errorCode === "permission_denied"
    || snapshot.capability?.reason === "permission_denied";
  let permissionRecovery = null;
  if (permissionDenied) {
    permissionRecovery = await recoverWechatRecordPermission();
  }
  if (!socket.connected) {
    showToast(permissionRecovery?.granted
      ? "麦克风权限已开启，网络恢复后再连接语音"
      : permissionRecovery?.message || "网络连接恢复后再重试语音");
    return;
  }
  const capability = await refreshVoiceCapabilities({ force: true });
  if (permissionRecovery && !permissionRecovery.granted) {
    showToast(permissionRecovery.message);
    return;
  }
  showToast(capability.available
    ? permissionRecovery?.granted
      ? "麦克风权限已开启，点击麦克风或扬声器加入"
      : "微信语音可用，点击麦克风或扬声器加入"
    : capability.message || voiceMessage(capability.reason));
}

function voiceUiSnapshot() {
  const helperCapability = voiceChat?.capability?.();
  const effectiveReason = voiceCapability.available && helperCapability && !helperCapability.available
    ? helperCapability.reason
    : voiceCapability.reason;
  return {
    capability: {
      ...voiceCapability,
      available: Boolean(voiceCapability.available && helperCapability?.available !== false),
      reason: effectiveReason,
      message: effectiveReason
        ? voiceMessage(effectiveReason)
        : voiceCapability.loaded
          ? "点击麦克风或扬声器加入"
          : "正在检测微信语音",
    },
    state: voiceChat?.state || {
      status: "idle",
      joined: false,
      micMuted: true,
      speakerMuted: false,
      memberCount: 0,
      speakingCount: 0,
      speakingPlayerIds: [],
      errorCode: null,
    },
    channelIsolation: voiceChannelIsolation,
    busy: voiceActionBusy,
  };
}

function refreshVoiceUi() {
  uiScene?.setVoiceState(voiceUiSnapshot());
}

function normalizeVoiceCapability(response) {
  const raw = response?.wechat || {};
  const localEnabled = localVoiceConfig.enabled !== false;
  let reason = String(raw.reason || "").trim() || null;
  if (!localEnabled) reason = "feature_disabled";
  else if (!raw.appId || raw.appId === "touristappid") reason ||= "not_configured";
  else if (raw.enabled !== true) reason ||= "feature_disabled";
  else if (raw.approvalGranted !== true) reason ||= "approval_required";
  else if (raw.privacyConfigured !== true) reason ||= "privacy_not_configured";
  else if (raw.available !== true) reason ||= "signing_unavailable";
  return {
    loaded: true,
    available: raw.available === true && localEnabled && !reason,
    appId: String(raw.appId || ""),
    enabled: raw.enabled === true && localEnabled,
    approvalGranted: raw.approvalGranted === true,
    privacyConfigured: raw.privacyConfigured === true,
    reason,
    message: reason ? voiceMessage(reason) : "点击麦克风或扬声器加入",
  };
}

async function requestVoiceCredentials() {
  if (!canSendRoomEvent()) {
    throw Object.assign(new Error("voice_room_not_bound"), { errorCode: "signing_unavailable" });
  }
  let code;
  try {
    code = await wechatLoginCode();
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("wechat_login_failed"), {
      errorCode: "signing_unavailable",
    });
  }
  return new Promise((resolve, reject) => {
    socket.timeout(5_000).emit("voice:wechat:credentials", { code }, (error, response) => {
      const credentials = response?.credentials || response;
      if (error || response?.ok === false || !credentials) {
        reject(Object.assign(new Error("voice_credentials_failed"), {
          errorCode: "signing_unavailable",
          cause: error || response?.errorCode,
        }));
        return;
      }
      resolve(credentials);
    });
  });
}

function resolveWechatSpeakerPlayerIds(openIdList) {
  if (!canSendRoomEvent()) return Promise.resolve([]);
  return new Promise((resolve) => {
    socket.timeout(2_000).emit(
      "voice:wechat:resolve-speakers",
      { openIdList },
      (error, response) => {
        if (error || response?.ok === false || !Array.isArray(response?.speakingPlayerIds)) {
          resolve([]);
          return;
        }
        resolve(response.speakingPlayerIds);
      },
    );
  });
}

function notifyWechatVoiceLeave({ reason = "leave" } = {}) {
  if (!socket.connected) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    socket.timeout(2_000).emit(
      "voice:wechat:leave",
      { reason: String(reason).slice(0, 64) },
      (_error, response) => resolve(response || { ok: true }),
    );
  });
}

function ensureVoiceClient() {
  if (!voiceChat) {
    voiceChat = new WechatVoiceChat({
      wxApi: globalThis.wx,
      appId: voiceCapability.appId,
      enabled: voiceCapability.enabled,
      approvalGranted: voiceCapability.approvalGranted,
      privacyConfigured: voiceCapability.privacyConfigured,
      requireRealDevice: localVoiceConfig.requireRealDevice !== false,
      getCredentials: requestVoiceCredentials,
      resolveSpeakerPlayerIds: resolveWechatSpeakerPlayerIds,
      ensurePrivacyConsent: ensureWechatPrivacyConsent,
      notifyLeave: notifyWechatVoiceLeave,
      onStateChange: refreshVoiceUi,
      onError: ({ errorCode }) => {
        if (errorCode === "interrupted") showToast(voiceMessage(errorCode));
      },
    });
  } else if (!voiceChat.state.joined) {
    voiceChat.appId = voiceCapability.appId;
    voiceChat.enabled = voiceCapability.enabled;
    voiceChat.approvalGranted = voiceCapability.approvalGranted;
    voiceChat.privacyConfigured = voiceCapability.privacyConfigured;
    voiceChat.requireRealDevice = localVoiceConfig.requireRealDevice !== false;
  }
  return voiceChat;
}

function refreshVoiceCapabilities({ force = false } = {}) {
  if (!socket.connected) return Promise.resolve(voiceCapability);
  if (!force && voiceCapability.loaded) return Promise.resolve(voiceCapability);
  if (voiceCapabilityPromise) return voiceCapabilityPromise;
  const attempt = ++voiceCapabilityAttempt;
  voiceCapability = { ...voiceCapability, loaded: false, message: "正在检测微信语音" };
  refreshVoiceUi();
  voiceCapabilityPromise = new Promise((resolve) => {
    socket.timeout(5_000).emit("voice:capabilities", { platform: "wechat" }, (error, response) => {
      if (attempt !== voiceCapabilityAttempt) return resolve(voiceCapability);
      if (error || response?.ok === false || !response?.wechat) {
        voiceCapability = {
          ...voiceCapability,
          loaded: true,
          available: false,
          reason: "capability_check_failed",
          message: voiceMessage("capability_check_failed"),
        };
      } else {
        voiceCapability = normalizeVoiceCapability(response);
        voiceChannelIsolation = response.channelIsolation === true || response.channelsInteroperate === false;
      }
      ensureVoiceClient();
      refreshVoiceUi();
      resolve(voiceCapability);
    });
  }).finally(() => {
    if (attempt === voiceCapabilityAttempt) voiceCapabilityPromise = null;
  });
  return voiceCapabilityPromise;
}

async function ensureVoiceJoined() {
  if (!canSendRoomEvent()) return { ok: false, errorCode: "not_joined", message: "进入房间后才能使用语音" };
  if (!voiceCapability.loaded) await refreshVoiceCapabilities();
  if (!voiceCapability.available) {
    return {
      ok: false,
      errorCode: voiceCapability.reason || "capability_check_failed",
      message: voiceMessage(voiceCapability.reason || "capability_check_failed"),
    };
  }
  const client = ensureVoiceClient();
  const capability = client.capability();
  if (!capability.available) return { ok: false, errorCode: capability.reason, message: capability.message };
  if (client.state.joined) return { ok: true, joinedNow: false, state: client.state };
  if (!voiceJoinPromise) {
    voiceJoinPromise = client.join({ roomCode: currentSession.code, playerId: currentSession.playerId })
      .then((result) => ({ ...result, joinedNow: result.ok === true }))
      .finally(() => {
        voiceJoinPromise = null;
        refreshVoiceUi();
      });
  }
  return voiceJoinPromise;
}

async function runVoiceAction(kind, { desiredEnabled } = {}) {
  if (voiceActionBusy) return;
  voiceActionBusy = true;
  refreshVoiceUi();
  try {
    const joined = await ensureVoiceJoined();
    if (!joined?.ok) {
      showToast(joined?.message || voiceMessage(joined?.errorCode));
      return;
    }
    const currentEnabled = kind === "mic" ? !voiceChat.state.micMuted : !voiceChat.state.speakerMuted;
    const nextEnabled = typeof desiredEnabled === "boolean"
      ? desiredEnabled
      : kind === "speaker" && joined.joinedNow
        ? true
        : !currentEnabled;
    let result = joined;
    if (currentEnabled !== nextEnabled) {
      result = kind === "mic"
        ? await voiceChat.setMicrophoneMuted(!nextEnabled)
        : await voiceChat.setSpeakerMuted(!nextEnabled);
    } else if (kind === "speaker" && joined.joinedNow) {
      showToast("已加入微信语音，扬声器已开启");
    }
    if (result?.ok === false) {
      showToast(result.message || voiceMessage(result.errorCode));
    } else {
      persistWechatSettings({
        micEnabled: !voiceChat.state.micMuted,
        speakerEnabled: !voiceChat.state.speakerMuted,
      });
    }
  } finally {
    voiceActionBusy = false;
    refreshVoiceUi();
  }
}

function leaveWechatVoice(reason) {
  resetMicrophonePreference();
  voiceJoinPromise = null;
  voiceActionBusy = false;
  if (!voiceChat) {
    refreshVoiceUi();
    return Promise.resolve();
  }
  const result = voiceChat.leave({ reason, notify: true });
  Promise.resolve(result).finally(refreshVoiceUi);
  return result;
}

function readSession() {
  try {
    return JSON.parse(storageGet("session")) || null;
  } catch {
    return null;
  }
}

function sessionKey(session) {
  if (!session) return "";
  return `${session.code}\u0000${session.playerId}\u0000${session.resumeToken}`;
}

function saveSession(session) {
  currentSession = session;
  storageSet("session", JSON.stringify(session));
}

function clearSession() {
  const cancelUnsettledBinding = Boolean(currentSession && !roomBound && socket.connected);
  void leaveWechatVoice("session_cleared");
  resumeAttempt += 1;
  roomBound = false;
  pendingResume = false;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  uiScene?.releaseControls();
  gameAudio.setGameState(null, Date.now() + bestClockSample.offset);
  currentSession = null;
  currentState = null;
  pendingBuildId = null;
  pendingDraftId = null;
  pendingItemAction = null;
  cancelItemTargetSelection();
  previewValid = false;
  previewAngle = 0;
  storageRemove("session");
  gameScene?.scene?.resume?.();
  gameScene?.clearRoomState();
  if (cancelUnsettledBinding) {
    socket.disconnect();
    socket.connect();
  }
}

function showHome(error = "") {
  uiScene?.showHome({ name: homeName, roomCode: homeRoomCode, error });
}

function showToast(message) {
  if (message) uiScene?.showToast(message);
}

function showServerError(response) {
  showToast(errorMessages[response?.errorCode] || "操作失败，请重试");
}

function enterSession(response) {
  resumeAttempt += 1;
  pendingResume = false;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  roomBound = true;
  gameScene?.scene?.resume?.();
  saveSession({
    code: response.code,
    playerId: response.playerId,
    resumeToken: response.resumeToken,
  });
  applyState(response.snapshot);
  void refreshVoiceCapabilities();
}

function resumeSession() {
  if (!currentSession || pendingResume || !socket.connected) return;
  const session = { ...currentSession };
  const key = sessionKey(session);
  const attempt = ++resumeAttempt;
  pendingResume = true;
  roomBound = false;
  uiScene?.setConnection("connecting");
  socket.timeout(5_000).emit("room:resume", session, (error, response) => {
    if (attempt !== resumeAttempt || sessionKey(currentSession) !== key) return;
    pendingResume = false;
    if (error) {
      if (socket.connected && currentSession) {
        setTimeout(() => {
          if (attempt === resumeAttempt && sessionKey(currentSession) === key) resumeSession();
        }, 750);
      }
      return;
    }
    if (!response?.ok) {
      clearSession();
      showHome(response?.errorCode === "resume_denied" ? errorMessages.resume_denied : "");
      return;
    }
    roomBound = true;
    gameScene?.prepareForRoomResume();
    applyState(response.snapshot);
    gameScene?.restoreLocalMotion(response.selfMotion);
    gameScene?.scene?.resume?.();
    uiScene?.setConnection("connected");
    void refreshVoiceCapabilities();
  });
}

function applyState(state) {
  currentState = state;
  gameAudio.setGameState(state, Date.now() + bestClockSample.offset);
  const item = state.race?.items?.[currentSession?.playerId];
  if (item?.usedAt || state.phase !== "race") pendingItemAction = null;
  if (
    itemTargetSelection &&
    (state.phase !== "race" || item?.usedAt || item?.type !== itemTargetSelection.itemType)
  ) cancelItemTargetSelection();
  const buildId = state.build?.buildId || state.build?.turnId;
  if (
    pendingBuildId &&
    (buildId !== pendingBuildId || state.build?.decisions?.[currentSession?.playerId])
  ) pendingBuildId = null;
  if (pendingDraftId && state.draft?.draftId !== pendingDraftId) pendingDraftId = null;
  if (state.phase !== "lobby") gameScene?.applyRoomState(state, currentSession?.playerId);
  uiScene?.applyRoomState(state, currentSession);
  if (itemTargetSelection) syncItemTargetSelectionUi();
  uiScene?.setPreviewState(previewValid, previewAngle);
}

function beginClockSync() {
  const generation = ++clockSyncGeneration;
  bestClockSample = { offset: 0, rtt: Number.POSITIVE_INFINITY };
  gameScene?.resetServerTimeSync();
  for (const delay of [0, 120, 360, 900]) setTimeout(() => sampleServerClock(generation), delay);
}

function sampleServerClock(generation) {
  if (!socket.connected || generation !== clockSyncGeneration) return;
  const sentAt = Date.now();
  socket.timeout(2_000).emit("time:sync", {}, (error, response) => {
    const receivedAt = Date.now();
    if (error || generation !== clockSyncGeneration || !Number.isFinite(response?.serverNow)) return;
    const rtt = Math.max(0, receivedAt - sentAt);
    if (rtt >= bestClockSample.rtt) return;
    const offset = Number(response.serverNow) - (sentAt + receivedAt) / 2;
    bestClockSample = { offset, rtt };
    gameScene?.setServerTimeOffset(offset, rtt);
    uiScene?.setServerTimeOffset(offset);
  });
}

function playerName() {
  const value = String(homeName || "").trim().slice(0, 12);
  if (!value) showToast("先输入玩家名");
  return value;
}

function hasConnection() {
  return socket.connected;
}

function submitLobbyAction(event, payload) {
  if (!hasConnection()) return showToast("正在连接房间服务");
  if (pendingLobbyAction) return;
  const attempt = ++lobbyActionAttempt;
  pendingLobbyAction = true;
  socket.timeout(5_000).emit(event, payload, (error, response) => {
    if (attempt !== lobbyActionAttempt) return;
    pendingLobbyAction = false;
    if (error) {
      showToast("连接超时，请重试");
      lobbyActionAttempt += 1;
      socket.disconnect();
      socket.connect();
      return;
    }
    if (!response?.ok) return showServerError(response);
    enterSession(response);
  });
}

function canSendRoomEvent() {
  return Boolean(roomBound && socket.connected && currentSession);
}

function requireRoomBinding() {
  if (canSendRoomEvent()) return true;
  showToast("正在恢复房间连接");
  return false;
}

function submitDraftPick(pieceType) {
  if (!requireRoomBinding()) {
    uiScene?.setDraftPending(null);
    return;
  }
  const draft = currentState?.draft;
  const choices = draft?.choices?.[currentSession?.playerId] || [];
  if (
    currentState?.phase !== "draft" ||
    !draft?.draftId ||
    !DRAFT_ITEMS[pieceType] ||
    !choices.includes(pieceType) ||
    draft.picks?.[currentSession.playerId] ||
    pendingDraftId
  ) return;
  const draftId = draft.draftId;
  const draftPlayerId = currentSession.playerId;
  pendingDraftId = draftId;
  socket.timeout(5_000).emit(
    "draft:pick",
    {
      draftId,
      round: currentState.round,
      pieceType,
      actionId: createId("draft"),
      expectedRevision: currentState.revision,
    },
    (error, response) => {
      if (!error && response?.ok) {
        gameAudio.play("draft", { dedupeKey: `${draftId}:${draftPlayerId}` });
        return;
      }
      if (pendingDraftId === draftId) pendingDraftId = null;
      uiScene?.setDraftPending(null);
      if (error) showToast("选件超时，请重试");
      else showServerError(response);
    },
  );
}

function submitPlacement(placement = gameScene?.getPlacement()) {
  if (!requireRoomBinding()) return;
  const build = currentState?.build;
  if (
    !placement ||
    currentState?.phase !== "build" ||
    !build?.pieces?.[currentSession?.playerId] ||
    build?.decisions?.[currentSession?.playerId] ||
    pendingBuildId === (build?.buildId || build?.turnId)
  ) return;
  const buildId = build.buildId || build.turnId;
  const placementRound = currentState.round;
  const placementPlayerId = currentSession.playerId;
  pendingBuildId = buildId;
  socket.timeout(5_000).emit(
    "build:place",
    {
      placement,
      actionId: createId("place"),
      round: placementRound,
      buildId,
    },
    (error, response) => {
      if (!error && response?.ok) {
        gameAudio.play("place", { dedupeKey: `${placementRound}:${buildId}:${placementPlayerId}` });
        return;
      }
      if (pendingBuildId === buildId) pendingBuildId = null;
      if (error) showToast("放置超时，请重试");
      else showServerError(response);
    },
  );
}

function submitBuildSkip() {
  if (!requireRoomBinding()) return;
  const build = currentState?.build;
  if (
    currentState?.phase !== "build" ||
    !build?.pieces?.[currentSession?.playerId] ||
    build?.decisions?.[currentSession?.playerId] ||
    pendingBuildId === (build?.buildId || build?.turnId)
  ) return;
  const buildId = build.buildId || build.turnId;
  pendingBuildId = buildId;
  socket.timeout(5_000).emit(
    "build:skip",
    { buildId, round: currentState.round, actionId: createId("skip") },
    (error, response) => {
      if (!error && response?.ok) return;
      if (pendingBuildId === buildId) pendingBuildId = null;
      if (error) showToast("跳过超时，请重试");
      else showServerError(response);
    },
  );
}

function currentRaceItem() {
  return currentState?.race?.items?.[currentSession?.playerId] || null;
}

function itemTargetOptions(selection = itemTargetSelection) {
  return buildItemTargetOptions({
    players: currentState?.players,
    selfPlayerId: currentSession?.playerId,
    effects: currentState?.race?.effects,
    now: Date.now() + (Number.isFinite(bestClockSample.offset) ? bestClockSample.offset : 0),
    reasonOverrides: selection?.reasonOverrides,
  });
}

function syncItemTargetSelectionUi() {
  if (!itemTargetSelection) {
    uiScene?.setItemTargetSelection(null);
    return;
  }
  uiScene?.setItemTargetSelection({
    itemType: itemTargetSelection.itemType,
    expiresAt: itemTargetSelection.expiresAt,
    options: itemTargetOptions(),
    pendingTargetPlayerId: pendingItemAction?.targetPlayerId || null,
  });
}

function cancelItemTargetSelection() {
  if (itemTargetSelection?.timer) clearTimeout(itemTargetSelection.timer);
  itemTargetSelection = null;
  uiScene?.setItemTargetSelection(null);
}

function beginItemTargetSelection(itemType) {
  cancelItemTargetSelection();
  const expiresAt = Date.now() + TARGET_SELECTION_MS;
  const selectionId = createId("target");
  const timer = setTimeout(() => {
    if (itemTargetSelection?.selectionId !== selectionId) return;
    cancelItemTargetSelection();
    showToast("没有选择目标");
  }, TARGET_SELECTION_MS);
  itemTargetSelection = { selectionId, itemType, expiresAt, timer, reasonOverrides: {} };
  syncItemTargetSelectionUi();
}

function requestItemUse() {
  if (!requireRoomBinding() || currentState?.phase !== "race" || pendingItemAction) return;
  const item = currentRaceItem();
  const config = ACTIVE_ITEMS[item?.type];
  if (!config || item.usedAt) return;
  if (config.kind === "target_debuff") {
    beginItemTargetSelection(item.type);
    return;
  }
  submitItemUse(null);
}

function chooseItemTarget(playerId) {
  if (!itemTargetSelection || Date.now() >= itemTargetSelection.expiresAt) return;
  const option = itemTargetOptions().find((candidate) => candidate.playerId === String(playerId || ""));
  if (!option?.selectable) return showToast(option?.reasonLabel || "请选择有效目标");
  submitItemUse(playerId);
}

function chooseItemTargetByIndex(index) {
  if (!itemTargetSelection) return;
  const optionIndex = Number(index);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return;
  const options = itemTargetOptions();
  const option = options.find((candidate) => String(candidate.shortcut || "") === String(optionIndex + 1))
    || options[optionIndex];
  if (option) chooseItemTarget(option.playerId);
}

function submitItemUse(targetPlayerId) {
  if (!requireRoomBinding() || pendingItemAction || currentState?.phase !== "race") return;
  const item = currentRaceItem();
  const config = ACTIVE_ITEMS[item?.type];
  if (!config || item.usedAt) return;
  if (config.kind === "target_debuff") {
    if (!itemTargetSelection || itemTargetSelection.itemType !== item.type || Date.now() >= itemTargetSelection.expiresAt) {
      return;
    }
    const option = itemTargetOptions().find((candidate) => candidate.playerId === String(targetPlayerId || ""));
    if (!option?.selectable) return showToast(option?.reasonLabel || "请选择有效目标");
  }
  const action = { actionId: createId("item"), itemType: item.type, round: currentState.round };
  pendingItemAction = { ...action, targetPlayerId: targetPlayerId || null };
  uiScene?.applyRoomState(currentState, currentSession);
  if (itemTargetSelection) syncItemTargetSelectionUi();
  socket.timeout(5_000).emit(
    "item:use",
    { ...action, targetPlayerId },
    (error, response) => {
      if (!pendingItemAction || pendingItemAction.actionId !== action.actionId) return;
      pendingItemAction = null;
      if (!error && response?.ok) {
        cancelItemTargetSelection();
        uiScene?.applyRoomState(currentState, currentSession);
        return;
      }
      if (
        !error &&
        targetPlayerId &&
        isTargetSelectionError(response?.errorCode) &&
        itemTargetSelection?.itemType === action.itemType &&
        Date.now() < itemTargetSelection.expiresAt
      ) {
        itemTargetSelection.reasonOverrides = {
          ...itemTargetSelection.reasonOverrides,
          [targetPlayerId]: response.errorCode,
        };
      }
      if (error) showToast("道具使用超时，请重试");
      else showServerError(response);
      uiScene?.applyRoomState(currentState, currentSession);
      if (itemTargetSelection) syncItemTargetSelectionUi();
    },
  );
}

function leaveCurrentRoom() {
  void leaveWechatVoice("room_leave");
  if (canSendRoomEvent()) socket.emit("room:leave", {}, () => {});
  clearSession();
  showHome();
}

function editHomeField(field, currentValue, commit) {
  const isCode = field === "roomCode";
  editText({
    value: currentValue,
    maxLength: isCode ? 5 : 12,
    onChange: (value) => commit?.(isCode ? value.toUpperCase().replace(/[^A-Z2-9]/g, "") : value, false),
    onDone: (value) => {
      const next = isCode
        ? value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 5)
        : value.trim().slice(0, 12);
      if (isCode) homeRoomCode = next;
      else {
        homeName = next;
        storageSet("playerName", next);
      }
      commit?.(next, true);
    },
  });
}

const bridge = {
  onSceneReady: () => {
    applyRenderProfileToScene(gameScene, wechatSettings.quality);
    if (Number.isFinite(bestClockSample.rtt)) {
      gameScene.setServerTimeOffset(bestClockSample.offset, bestClockSample.rtt);
    }
    if (!uiScene) {
      uiScene = new WechatUiScene(
        {
          onCreate: (name) => {
            homeName = String(name || homeName);
            const safeName = playerName();
            if (!safeName) return;
            submitLobbyAction("room:create", { clientId, name: safeName });
          },
          onPractice: (name) => {
            homeName = String(name || homeName);
            const safeName = playerName();
            if (!safeName) return;
            submitLobbyAction("room:practice", { clientId, name: safeName });
          },
          onJoin: (name, code) => {
            homeName = String(name || homeName);
            homeRoomCode = String(code || homeRoomCode).toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 5);
            const safeName = playerName();
            if (!safeName) return;
            if (homeRoomCode.length !== 5) return showToast("输入 5 位房间码");
            submitLobbyAction("room:join", { clientId, name: safeName, code: homeRoomCode });
          },
          onStart: () => {
            if (!requireRoomBinding()) return;
            if (!currentState) return;
            socket.emit("game:start", { expectedRevision: currentState.revision }, (response) => {
              if (!response?.ok) showServerError(response);
            });
          },
          onLeave: leaveCurrentRoom,
          onCopy: (code) => {
            copyText(code);
            showToast("房间码已复制");
          },
          onDraftPick: submitDraftPick,
          onRotate: () => {
            if (canSendRoomEvent()) gameScene?.rotatePreview();
          },
          onSkip: submitBuildSkip,
          onConfirm: () => submitPlacement(),
          onItemUse: requestItemUse,
          onItemTarget: chooseItemTarget,
          onItemTargetCancel: cancelItemTargetSelection,
          onVoiceMic: () => runVoiceAction("mic"),
          onVoiceSpeaker: () => runVoiceAction("speaker"),
          onAudioUnlock: () => gameAudio.unlock(),
          onAudioEvent: (key, options) => gameAudio.play(key, options),
          onSettingsVoice: runSettingsVoiceAction,
          onSettingsAudio: updateAudioSetting,
          onVoiceRetry: retryVoiceCapability,
          onSettingsQuality: updateRenderQuality,
          onRematch: () => {
            if (!requireRoomBinding()) return;
            socket.emit("game:rematch", { expectedRevision: currentState?.revision }, (response) => {
              if (!response?.ok) showServerError(response);
            });
          },
          onTouchControl: (control, pressed) => {
            if (!pressed || canSendRoomEvent()) gameScene?.setTouchControl(control, pressed);
          },
          onEditField: editHomeField,
        },
        {
          name: homeName,
          roomCode: homeRoomCode,
          settings: settingsUiSnapshot(),
          renderProfile: activeRenderProfile,
        },
      );
      gameScene.game.scene.add("WechatUI", uiScene, true);
      if (currentState) uiScene.applyRoomState(currentState, currentSession);
      else showHome();
      uiScene.setConnection(socket.connected ? "connected" : "connecting");
      refreshVoiceUi();
    }
    applyCurrentRenderProfile();
    if (currentState && currentState.phase !== "lobby") {
      gameScene.applyRoomState(currentState, currentSession?.playerId);
    }
  },
  onPreviewChanged: (valid) => {
    previewValid = valid;
    uiScene?.setPreviewState(previewValid, previewAngle);
  },
  onPreviewRotated: (angle) => {
    previewAngle = angle;
    uiScene?.setPreviewState(previewValid, previewAngle);
  },
  onPlacementRequested: submitPlacement,
  onRaceReady: (mapRevision) => {
    if (!canSendRoomEvent()) return false;
    socket.emit("race:ready", { mapRevision }, (response) => {
      if (!response?.ok && response?.errorCode !== "invalid_phase") showServerError(response);
    });
    return true;
  },
  onLocalMotion: (motion) => {
    if (!canSendRoomEvent()) return false;
    if (motion.snap) socket.emit("race:update", motion);
    else socket.volatile.emit("race:update", motion);
    return true;
  },
  onAudioEvent: (key, options) => gameAudio.play(key, options),
  onLocalFinish: (motion) => {
    if (!canSendRoomEvent()) return false;
    const finishRound = currentState?.round;
    const finishPlayerId = currentSession?.playerId;
    socket.emit("race:update", motion);
    socket.emit("race:finish", { actionId: createId("finish") }, (response) => {
      if (response?.ok) {
        gameAudio.play("finish", { dedupeKey: `${finishRound}:${finishPlayerId}` });
        return;
      }
      if (response?.errorCode === "finish_not_verified") gameScene?.rejectLocalFinish();
      showServerError(response);
    });
    return true;
  },
  onLocalDeath: () => {
    if (!canSendRoomEvent()) return false;
    socket.emit("race:death", { actionId: createId("death") }, (response) => {
      if (!response?.ok && response?.errorCode !== "invalid_phase") showServerError(response);
    });
    return true;
  },
  onItemUseRequested: requestItemUse,
  onItemTargetIndex: chooseItemTargetByIndex,
};

gameScene = new BoltboundScene(bridge);
const canvas = canvasForGame();
if (!canvas) throw new Error("微信小游戏 Canvas 初始化失败");

game = new Phaser.Game({
  type: Phaser.CANVAS,
  canvas,
  width: activeRenderProfile.width,
  height: activeRenderProfile.height,
  backgroundColor: "#bfe0de",
  disableContextMenu: true,
  physics: {
    default: "arcade",
    arcade: { gravity: { y: 1_500 }, debug: false },
  },
  input: { activePointers: 2, touch: { capture: true } },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: activeRenderProfile.width,
    height: activeRenderProfile.height,
  },
  render: { antialias: true, pixelArt: false, roundPixels: false },
  scene: gameScene,
});

socket.on("connect", () => {
  beginClockSync();
  void refreshVoiceCapabilities({ force: true });
  uiScene?.setConnection(currentSession ? "connecting" : "connected");
  if (currentSession && !pendingResume) resumeSession();
  else if (!currentSession) showHome();
});
socket.on("disconnect", () => {
  voiceCapabilityAttempt += 1;
  resetMicrophonePreference();
  voiceCapabilityPromise = null;
  void voiceChat?.handleDisconnect();
  resumeAttempt += 1;
  roomBound = false;
  pendingResume = false;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  pendingBuildId = null;
  pendingDraftId = null;
  pendingItemAction = null;
  cancelItemTargetSelection();
  if (Array.isArray(socket.sendBuffer)) socket.sendBuffer.length = 0;
  uiScene?.releaseControls();
  uiScene?.setDraftPending(null);
  uiScene?.setConnection("disconnected");
  if (currentSession) gameScene?.scene?.pause?.();
});
socket.on("connect_error", () => {
  resetMicrophonePreference();
  void voiceChat?.handleDisconnect();
  resumeAttempt += 1;
  roomBound = false;
  pendingResume = false;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  uiScene?.setConnection("error");
  if (!currentSession) showHome("房间服务暂时不可用");
});
socket.on("room:state", (state) => {
  if (!roomBound || !currentSession || state.code !== currentSession.code) return;
  applyState(state);
});
socket.on("race:peer", (motion) => {
  if (roomBound) gameScene?.receivePeerMotion(motion);
});
socket.on("race:correction", (correction) => {
  if (roomBound) gameScene?.receiveRaceCorrection(correction);
});
socket.on("bomb:blast", (blast) => {
  if (roomBound) gameScene?.receiveBombBlast(blast);
});
socket.on("item:used", (effect) => {
  if (!currentSession || !effect) return;
  const item = ACTIVE_ITEMS[effect.type];
  if (!item) return;
  if (effect.type !== "bomb") {
    gameAudio.play("item", {
      dedupeKey: `${effect.sourcePlayerId}:${effect.type}:${effect.startedAt}:${effect.targetPlayerId || "self"}`,
    });
  }
  const source = currentState?.players?.find((player) => player.id === effect.sourcePlayerId);
  if (effect.sourcePlayerId === currentSession.playerId) {
    showToast(`${item.label}已启动`);
  } else if (effect.targetPlayerId === currentSession.playerId) {
    showToast(`${source?.name || "其他玩家"}对你使用了${item.label}`);
  }
});

globalThis.wx?.onShow?.(() => {
  gameAudio.resume("wechat-hidden");
  voiceChat?.handleShow();
  if (!socket.connected) socket.connect();
  else if (currentSession && !roomBound) resumeSession();
});
globalThis.wx?.onHide?.(() => {
  gameAudio.suspend("wechat-hidden");
  resetMicrophonePreference();
  void voiceChat?.handleHide();
  uiScene?.releaseControls();
  gameScene?.setTouchControl("left", false);
  gameScene?.setTouchControl("right", false);
  gameScene?.setTouchControl("jump", false);
});

setInterval(() => {
  if (currentState) gameAudio.setGameState(currentState, Date.now() + bestClockSample.offset);
}, 150);

if (globalThis.ZAOLU_DEBUG || platformName() === "devtools") {
  globalThis.__ZAOLU_WECHAT_APP__ = {
    game,
    socket,
    get state() {
      return currentState;
    },
    get session() {
      return currentSession;
    },
    get gameScene() {
      return gameScene;
    },
    get uiScene() {
      return uiScene;
    },
    get roomBound() {
      return roomBound;
    },
  };
}
