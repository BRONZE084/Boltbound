import Phaser from "phaser";
import { io } from "socket.io-client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Construction,
  Copy,
  DoorOpen,
  Gamepad2,
  KeyRound,
  LogIn,
  Maximize,
  Mic,
  MicOff,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  SkipForward,
  Timer,
  Trophy,
  UserRound,
  Volume2,
  VolumeX,
  WifiOff,
  X,
  Zap,
  createIcons,
} from "lucide";
import { ACTIVE_ITEMS, DRAFT_ITEMS, PIECES, PLAYER_STYLES, TARGET_SELECTION_MS, VIEWPORT } from "../shared/gameConfig.js";
import { buildItemTargetOptions, isTargetSelectionError } from "../shared/itemTargets.js";
import { BoltboundScene } from "./game/BoltboundScene.js";
import { BrowserAudioBackend } from "./audio/BrowserAudioBackend.js";
import { GameAudio } from "./audio/GameAudio.js";
import {
  installVirtualPointerAdapter,
  readLandscapeSnapshot,
  requestNativeLandscape,
  resolveLandscapePresentation,
  waitForActualLandscape,
} from "./orientation/landscapeMode.js";
import { loadGameSettings, qualityProfileFor, saveGameSettings } from "./settings/GameSettings.js";
import { BrowserVoiceChat } from "./voice/BrowserVoiceChat.js";
import "./style.css";

const icons = {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Construction,
  Copy,
  DoorOpen,
  Gamepad2,
  KeyRound,
  LogIn,
  Maximize,
  Mic,
  MicOff,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  SkipForward,
  Timer,
  Trophy,
  UserRound,
  Volume2,
  VolumeX,
  WifiOff,
  X,
  Zap,
};

const $ = (id) => document.getElementById(id);
const views = [$("home-view"), $("room-view"), $("game-view")];
const nameInput = $("player-name");
const roomCodeInput = $("room-code-input");
const entryError = $("entry-error");
const startButton = $("start-game");
const buildDock = $("build-dock");
const confirmPiece = $("confirm-piece");
const rotatePiece = $("rotate-piece");
const skipPiece = $("skip-piece");
const draftPanel = $("draft-panel");
const draftOptions = $("draft-options");
const resultsPanel = $("results-panel");
const phaseBanner = $("phase-banner");
const connectionPill = $("connection-pill");
const touchControls = $("touch-controls");
const itemDock = $("item-dock");
const useItemButton = $("use-item");
const itemTargetPrompt = $("item-target-prompt");
const scoreStrip = $("score-strip");
const voiceControls = $("voice-controls");
const voiceMeter = $("voice-meter");
const voiceMicButton = $("voice-mic");
const voiceSpeakerButton = $("voice-speaker");
const voiceStatus = $("voice-status");
const gameView = $("game-view");
const orientationGate = $("orientation-gate");
const enterLandscapeButton = $("enter-landscape");
const virtualLandscapeToolbar = $("virtual-landscape-toolbar");
const retryNativeLandscapeButton = $("retry-native-landscape");
const exitVirtualLandscapeButton = $("exit-virtual-landscape");
const orientationStatus = $("orientation-status");
const settingsModal = $("settings-modal");
const settingsPanel = settingsModal.querySelector(".settings-panel");
const settingsCloseButton = $("settings-close");
const settingsMusicEnabled = $("settings-music-enabled");
const settingsMusicVolume = $("settings-music-volume");
const settingsMusicVolumeValue = $("settings-music-volume-value");
const settingsEffectsEnabled = $("settings-effects-enabled");
const settingsEffectsVolume = $("settings-effects-volume");
const settingsEffectsVolumeValue = $("settings-effects-volume-value");
const settingsVoiceVolume = $("settings-voice-volume");
const settingsVoiceVolumeValue = $("settings-voice-volume-value");
const settingsMic = $("settings-mic");
const settingsSpeaker = $("settings-speaker");
const settingsVoiceStatus = $("settings-voice-status");
const settingsLandscapeButton = $("settings-landscape");
const settingsDisplayStatus = $("settings-display-status");
const itemTargetModal = $("item-target-modal");
const itemTargetPanel = itemTargetModal.querySelector(".item-target-panel");
const itemTargetList = $("item-target-list");
const itemTargetModalTitle = $("item-target-modal-title");
const itemTargetModalCountdown = $("item-target-modal-countdown");
const itemTargetError = $("item-target-error");
const itemTargetCancelButton = $("item-target-cancel");
const coarsePointerQuery = matchMedia("(pointer: coarse)");
const landscapeOrientationQuery = matchMedia("(orientation: landscape)");

const errorMessages = {
  room_not_found: "没有找到这个房间",
  game_in_progress: "比赛已经开始",
  room_full: "房间已经满员",
  identity_in_use: "这个身份已在房间中",
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
  voice_disabled: "网页语音暂未启用",
  voice_not_in_room: "请先加入房间",
  voice_room_full: "语音房间已经满员",
  voice_session_invalid: "语音会话已失效，请重试",
  voice_target_unavailable: "语音对象已离线",
  voice_rate_limited: "语音信令过于频繁，请稍后重试",
  voice_payload_too_large: "语音信令数据异常",
  voice_signal_invalid: "语音信令无效",
};

const phaseLabels = {
  lobby: "等待",
  draft: "选件",
  build: "同步搭建",
  race_loading: "锁定地图",
  race_countdown: "倒计时",
  race: "竞速",
  results: "结算",
  gameover: "比赛结束",
};

let currentState = null;
let currentSession = readSession();
let phaserGame = null;
let gameScene = null;
let toastTimer = null;
let pendingResume = false;
let resumeAttempt = 0;
let pendingLobbyAction = false;
let lobbyActionAttempt = 0;
let roomBound = false;
let pendingBuildId = null;
let pendingDraftId = null;
let currentPreviewValid = false;
let displayedBuildId = null;
let currentPieceAngle = 0;
let clockSyncGeneration = 0;
let bestClockSample = { offset: 0, rtt: Number.POSITIVE_INFINITY };
let pendingItemAction = null;
let itemTargetSelection = null;
let voiceCapabilities = null;
let voiceSessionId = null;
let voiceJoinPromise = null;
let voiceOpenMicRequested = false;
let voiceAttempt = 0;
let voiceUiError = null;
let voiceAutoJoinKey = null;
let voiceCoreRenderKey = "";
let gameSettings = loadGameSettings();
const gameAudio = new GameAudio({
  backend: new BrowserAudioBackend(),
  initialSettings: gameSettings,
});
let settingsOpener = null;
let itemTargetModalSignature = "";
let orientationGateVisible = false;
let virtualLandscapeEnabled = false;
let landscapeRequestPromise = null;
let lastLandscapeOutcome = null;
let virtualPointerCanvas = null;
let virtualPointerAdapter = null;

const clientId = getOrCreateClientId();
nameInput.value = localStorage.getItem("boltbound.playerName") || `工友${Math.floor(10 + Math.random() * 90)}`;

createIcons({ icons });

function unlockGameAudioFromGesture(event) {
  if (document.visibilityState === "hidden" || event.defaultPrevented) return;
  if (event.type === "pointerdown" && event.isPrimary === false) return;
  if (
    event.type === "keydown" &&
    (event.repeat || event.isComposing || ["Alt", "Control", "Meta", "Shift"].includes(event.key))
  ) return;
  const explicitSpeakerControl = event.target.closest?.(
    '#voice-speaker, #settings-speaker, label[for="settings-speaker"]',
  );
  if (!explicitSpeakerControl) {
    void voiceChat.resumePlayback().then((result) => {
      if (result.ok && voiceUiError === "playback_blocked") {
        voiceUiError = null;
        renderVoiceControls();
        renderSettingsControls();
      }
    });
  }
  if (!gameAudio.unlock()) return;
}

document.addEventListener("pointerdown", unlockGameAudioFromGesture, true);
document.addEventListener("keydown", unlockGameAudioFromGesture, true);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") gameAudio.suspend("visibility");
  else gameAudio.resume("visibility");
});
window.addEventListener("pagehide", () => gameAudio.suspend("pagehide"));
window.addEventListener("pageshow", () => gameAudio.resume("pagehide"));
window.addEventListener("blur", () => gameAudio.suspend("blur"));
window.addEventListener("focus", () => gameAudio.resume("blur"));
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("button");
  if (!button || button.disabled || !button.isConnected) return;
  if (button.closest("#touch-controls")) return;
  gameAudio.play("ui_click");
});

const socket = io({
  autoConnect: true,
  transports: ["websocket"],
  reconnection: true,
  reconnectionDelayMax: 2_000,
});
const voiceChat = new BrowserVoiceChat({
  sendSignal: async (payload) => {
    const response = await emitVoiceAck("voice:web:signal", payload);
    if (!response?.ok) {
      throw Object.assign(new Error(response?.errorCode || "signaling_error"), {
        errorCode: response?.errorCode || "signaling_error",
      });
    }
  },
  notifyLeave: async ({ sessionId, reason }) => {
    if (!socket.connected) return;
    await emitVoiceAck("voice:web:leave", { sessionId, reason }).catch(() => {});
  },
  onStateChange: (state) => {
    renderPlayerVoiceIndicators(state);
    if (state.audiblePeerCount > 0 && ["signaling_error", "playback_blocked"].includes(voiceUiError)) {
      voiceUiError = null;
    }
    const coreKey = [
      state.status, state.joined, state.micMuted, state.speakerMuted,
      state.speakerVolume, state.peerCount, state.audiblePeerCount, state.errorCode,
    ].join(":");
    if (coreKey === voiceCoreRenderKey) {
      renderVoiceMeter(state);
      return;
    }
    voiceCoreRenderKey = coreKey;
    renderVoiceControls();
    renderSettingsControls();
  },
  onError: ({ errorCode }) => handleVoiceRuntimeError(errorCode),
});

socket.on("connect", () => {
  beginClockSync();
  void refreshVoiceCapabilities().then(() => maybeAutoJoinVoice());
  connectionPill.hidden = !currentSession;
  if (currentSession && !pendingResume) resumeSession();
  renderVoiceControls();
});

socket.on("disconnect", () => {
  void stopWebVoice({ notify: false });
  voiceAutoJoinKey = null;
  resumeAttempt += 1;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  roomBound = false;
  pendingResume = false;
  pendingBuildId = null;
  pendingDraftId = null;
  pendingItemAction = null;
  cancelItemTargetSelection();
  if (Array.isArray(socket.sendBuffer)) socket.sendBuffer.length = 0;
  gameScene?.prepareForRoomResume();
  if (currentSession) gameScene?.scene?.pause?.();
  refreshBuildControls();
  if (currentSession) connectionPill.hidden = false;
  renderVoiceControls();
});

socket.on("connect_error", () => {
  void stopWebVoice({ notify: false });
  voiceAutoJoinKey = null;
  resumeAttempt += 1;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  roomBound = false;
  pendingResume = false;
  pendingItemAction = null;
  cancelItemTargetSelection();
  entryError.textContent = "房间服务暂时不可用";
  renderVoiceControls();
});
socket.on("race:correction", (correction) => {
  if (!roomBound) return;
  gameScene?.receiveRaceCorrection(correction);
});

socket.on("room:state", (state) => {
  if (!roomBound || !currentSession || state.code !== currentSession.code) return;
  applyState(state);
});

socket.on("race:peer", (motion) => {
  if (!roomBound) return;
  gameScene?.receivePeerMotion(motion);
});
socket.on("bomb:blast", (blast) => {
  if (!roomBound) return;
  gameScene?.receiveBombBlast(blast);
});
socket.on("item:used", (effect) => {
  if (!currentSession || !effect) return;
  const item = ACTIVE_ITEMS[effect.type];
  if (!item) return;
  if (effect.type !== "bomb") {
    gameAudio.play("item", {
      dedupeKey: `${effect.sourcePlayerId}:${effect.type}:${effect.startedAt}`,
    });
  }
  const source = currentState?.players?.find((player) => player.id === effect.sourcePlayerId);
  if (effect.sourcePlayerId === currentSession.playerId) {
    showToast(`${item.label}已启动`);
  } else if (effect.targetPlayerId === currentSession.playerId) {
    showToast(`${source?.name || "其他玩家"}对你使用了${item.label}`);
  }
});
socket.on("voice:web:signal", (payload) => {
  if (!voiceSessionId || payload?.sessionId !== voiceSessionId) return;
  void voiceChat.handleSignal(payload);
});
socket.on("voice:web:state", (payload) => {
  if (!voiceSessionId || payload?.sessionId !== voiceSessionId) return;
  if (payload.kind === "peer_joined") {
    void voiceChat.addPeer(payload.playerId);
  } else if (payload.kind === "peer_left") {
    voiceChat.removePeer(payload.playerId);
  } else if (payload.kind === "reservation_expired") {
    voiceUiError = "voice_session_invalid";
    void stopWebVoice({ notify: false, preserveError: true });
  }
});

function beginClockSync() {
  const generation = ++clockSyncGeneration;
  bestClockSample = { offset: 0, rtt: Number.POSITIVE_INFINITY };
  gameScene?.resetServerTimeSync();
  for (const delay of [0, 120, 360, 900]) {
    window.setTimeout(() => sampleServerClock(generation), delay);
  }
}

function sampleServerClock(generation) {
  if (!socket.connected || generation !== clockSyncGeneration) return;
  const sentAt = Date.now();
  socket.timeout(2_000).emit("time:sync", {}, (error, response) => {
    const receivedAt = Date.now();
    if (
      error ||
      generation !== clockSyncGeneration ||
      !Number.isFinite(response?.serverNow)
    ) return;
    const rtt = Math.max(0, receivedAt - sentAt);
    if (rtt >= bestClockSample.rtt) return;
    const offset = Number(response.serverNow) - (sentAt + receivedAt) / 2;
    bestClockSample = { offset, rtt };
    gameScene?.setServerTimeOffset(offset, rtt);
  });
}

function emitVoiceAck(event, payload = {}, timeoutMs = 5_000) {
  if (!socket.connected) return Promise.reject(new Error("socket_disconnected"));
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function refreshVoiceCapabilities() {
  if (!socket.connected) {
    renderVoiceControls();
    return null;
  }
  try {
    const response = await emitVoiceAck("voice:capabilities", {}, 3_000);
    if (response?.ok) voiceCapabilities = response;
  } catch {
    voiceCapabilities = null;
  }
  renderVoiceControls();
  return voiceCapabilities;
}

function voiceErrorLabel(errorCode) {
  return {
    permission_denied: "麦克风权限被拒绝",
    device_unavailable: "没有找到麦克风",
    device_busy: "麦克风正被占用",
    secure_context_required: "语音需要 HTTPS 安全连接",
    unsupported: "当前浏览器不支持语音",
    media_error: "麦克风启动失败",
    signaling_error: "语音连接不稳定",
    playback_blocked: "点击扬声器继续收听",
    voice_session_invalid: "语音会话已失效",
    voice_room_full: "语音房间已满",
    voice_disabled: "网页语音未启用",
  }[errorCode] || errorMessages[errorCode] || "语音连接失败";
}

function setVoiceButtonIcon(button, iconName) {
  if (button.dataset.voiceIcon === iconName) return;
  button.dataset.voiceIcon = iconName;
  const icon = document.createElement("i");
  icon.dataset.lucide = iconName;
  button.replaceChildren(icon);
  createIcons({ icons });
}

function playerVoiceActivityMarkup() {
  return `
    <span class="player-voice-activity" data-player-voice hidden aria-hidden="true">
      <span class="player-voice-bar" style="--voice-bar: .45; --voice-delay: -240ms"></span>
      <span class="player-voice-bar" style="--voice-bar: .72; --voice-delay: -120ms"></span>
      <span class="player-voice-bar" style="--voice-bar: 1; --voice-delay: 0ms"></span>
      <span class="player-voice-bar" style="--voice-bar: .62; --voice-delay: -180ms"></span>
    </span>
  `;
}

function renderPlayerVoiceIndicators(state = voiceChat.state) {
  const players = new Map((currentState?.players || []).map((player) => [player.id, player]));
  const speakingPeerIds = new Set(state.speakingPeerIds || []);
  const peerLevels = state.peerLevels || {};
  for (const container of document.querySelectorAll("[data-player-id]")) {
    const indicator = container.querySelector("[data-player-voice]");
    if (!indicator) continue;
    const playerId = container.dataset.playerId;
    const player = players.get(playerId);
    const self = playerId === currentSession?.playerId;
    const eligible = Boolean(player && !player.bot && player.connected !== false);
    const remoteAvailable = Object.hasOwn(peerLevels, playerId);
    const available = eligible && (self
      ? state.joined && !state.micMuted
      : remoteAvailable);
    const level = available
      ? Math.max(0, Math.min(1, Number(self ? state.localLevel : peerLevels[playerId]) || 0))
      : 0;
    const speaking = available && Boolean(self ? state.localSpeaking : speakingPeerIds.has(playerId));
    const scale = Math.max(0.34, Math.min(1, 0.34 + level * 0.66));
    const accessibleVoiceLabel = speaking
      ? `${self ? "我" : player?.name || "队友"}正在说话`
      : available
        ? `${self ? "我的麦克风" : `${player?.name || "队友"}的语音`}已连接，当前未发言`
        : `${self ? "我的麦克风" : `${player?.name || "队友"}的语音`}当前无语音`;
    const visualVoiceLabel = speaking
      ? `${accessibleVoiceLabel}，音量 ${Math.round(level * 100)}%`
      : accessibleVoiceLabel;

    indicator.hidden = !available;
    indicator.classList.toggle("speaking", speaking);
    indicator.style.setProperty("--player-voice-scale", scale.toFixed(2));
    indicator.title = available ? visualVoiceLabel : "";
    container.dataset.voiceSpeaking = String(speaking);
    const baseLabel = container.dataset.voiceBaseLabel || container.getAttribute("aria-label") || player?.name || "玩家";
    if (!container.dataset.voiceBaseLabel) container.dataset.voiceBaseLabel = baseLabel;
    const containerLabel = `${baseLabel}，${accessibleVoiceLabel}`;
    if (container.getAttribute("aria-label") !== containerLabel) container.setAttribute("aria-label", containerLabel);
  }
}

function renderVoiceMeter(state = voiceChat.state) {
  const microphoneOn = state.joined && !state.micMuted;
  const level = microphoneOn
    ? Math.max(0, Math.min(1, Number(state.localLevel) || 0))
    : 0;
  const speaking = microphoneOn && Boolean(state.localSpeaking);
  const percent = Math.round(level * 100);
  voiceMeter.style.setProperty("--voice-level", level.toFixed(2));
  voiceMeter.classList.toggle("muted", !microphoneOn);
  voiceMeter.classList.toggle("speaking", speaking);
  voiceMeter.setAttribute("aria-valuenow", String(percent));
  const levelText = !microphoneOn
    ? "麦克风已关闭"
    : speaking
      ? `正在说话，麦克风音量 ${percent}%`
      : `麦克风已开启，音量 ${percent}%`;
  voiceMeter.setAttribute("aria-valuetext", levelText);
  voiceMeter.title = levelText;
  voiceControls.classList.toggle("local-speaking", speaking);
}

function renderVoiceControls() {
  const visible = Boolean(currentSession);
  voiceControls.hidden = !visible;
  if (!visible) return;

  const state = voiceChat.state;
  const capability = voiceCapabilities?.web;
  const inGame = Boolean(currentState && currentState.phase !== "lobby");
  const disconnected = !socket.connected || !roomBound;
  const busy = Boolean(voiceJoinPromise) || ["requesting", "connecting"].includes(state.status);
  const turnWarning = capability?.turnConfigured === false;
  const unavailable = capability?.available === false;
  const checking = !voiceCapabilities && socket.connected;

  voiceControls.classList.toggle("in-game", inGame);
  voiceControls.classList.toggle("busy", busy);
  voiceControls.classList.toggle("disconnected", disconnected);
  voiceControls.classList.toggle("warning", turnWarning && !voiceUiError);
  voiceControls.classList.toggle("error", Boolean(voiceUiError));

  let label = "网页语音 · 待连接";
  if (disconnected) label = "网页语音 · 连接已断开";
  else if (checking) label = "网页语音 · 正在检测";
  else if (voiceUiError) label = `网页语音 · ${voiceErrorLabel(voiceUiError)}`;
  else if (busy) label = "网页语音 · 正在连接";
  else if (unavailable) label = "网页语音 · 暂不可用";
  else if (state.joined) {
    const mode = state.micMuted ? "仅收听" : "麦克风开启";
    const humanCount = currentState?.players?.filter((player) => !player.bot && player.connected !== false).length || 1;
    if (state.audiblePeerCount > 0) label = `网页语音 · ${mode} · 可听 ${state.audiblePeerCount} 人`;
    else if (humanCount <= 1) label = `网页语音 · ${mode} · 等待其他玩家`;
    else if (state.peerCount > 0) label = `网页语音 · ${mode} · 正在连接`;
    else label = `网页语音 · ${mode} · 等待对方语音`;
  } else if (turnWarning) label = "网页语音 · 待连接 · 公网受限";
  voiceStatus.textContent = label;

  renderVoiceMeter(state);
  const microphoneOn = state.joined && !state.micMuted;
  const speakerOn = !state.speakerMuted;
  voiceMicButton.classList.toggle("active", microphoneOn);
  voiceMicButton.classList.toggle("muted", !microphoneOn);
  voiceSpeakerButton.classList.toggle("active", speakerOn);
  voiceSpeakerButton.classList.toggle("muted", !speakerOn);
  voiceMicButton.setAttribute("aria-pressed", String(microphoneOn));
  voiceSpeakerButton.setAttribute("aria-pressed", String(speakerOn));
  setVoiceButtonIcon(voiceMicButton, microphoneOn ? "mic" : "mic-off");
  setVoiceButtonIcon(voiceSpeakerButton, speakerOn ? "volume-2" : "volume-x");

  const blocked = disconnected || checking || unavailable || busy;
  voiceMicButton.disabled = blocked;
  voiceSpeakerButton.disabled = blocked;
  const isolation = "手机浏览器与电脑版互通；微信小游戏语音频道独立";
  const relay = turnWarning ? "；未配置 TURN，中继不可用；不同公网网络可能无法通话" : "";
  const micAction = microphoneOn
    ? "关闭网页麦克风"
    : state.joined
      ? "开启网页麦克风"
      : "连接并开启网页麦克风";
  const speakerAction = state.joined
    ? speakerOn ? "关闭网页语音收听" : "开启网页语音收听"
    : "连接并收听网页语音";
  voiceMicButton.setAttribute("aria-label", micAction);
  voiceSpeakerButton.setAttribute("aria-label", speakerAction);
  voiceMicButton.title = `${micAction}；${isolation}${relay}`;
  voiceSpeakerButton.title = `${speakerAction}；${isolation}${relay}`;
}

function handleVoiceRuntimeError(errorCode) {
  if (!errorCode || errorCode === "leave_notify_failed") return;
  if (errorCode === "signaling_error" && voiceChat.state.audiblePeerCount > 0) {
    return;
  }
  voiceUiError = errorCode;
  renderVoiceControls();
  if (voiceChat.state.joined && ["playback_blocked", "signaling_error"].includes(errorCode)) {
    showToast(voiceErrorLabel(errorCode));
  }
}

async function startWebVoice({ openMic = false } = {}) {
  voiceOpenMicRequested ||= openMic;
  if (voiceChat.state.joined) {
    await voiceChat.setSpeakerVolume(gameSettings.voiceVolume);
    if (gameSettings.speakerEnabled) await voiceChat.setSpeakerMuted(false);
    if (voiceOpenMicRequested) {
      const microphone = await voiceChat.setMicrophoneMuted(false);
      if (!microphone.ok) {
        voiceUiError = microphone.errorCode;
        voiceOpenMicRequested = false;
        renderVoiceControls();
        return false;
      }
    }
    voiceOpenMicRequested = false;
    voiceUiError = null;
    renderVoiceControls();
    return true;
  }
  if (voiceJoinPromise) return voiceJoinPromise;

  const attempt = ++voiceAttempt;
  const expectedSession = sessionKey();
  let reservedSessionId = null;
  voiceUiError = null;
  const operation = (async () => {
    const capabilities = voiceCapabilities || await refreshVoiceCapabilities();
    if (!canSendRoomEvent() || expectedSession !== sessionKey()) {
      throw Object.assign(new Error("voice_not_in_room"), { errorCode: "voice_not_in_room" });
    }
    if (!capabilities?.web?.available) {
      throw Object.assign(new Error("voice_disabled"), { errorCode: "voice_disabled" });
    }

    const reserved = await emitVoiceAck("voice:web:join");
    if (!reserved?.ok) {
      throw Object.assign(new Error(reserved?.errorCode || "signaling_error"), {
        errorCode: reserved?.errorCode || "signaling_error",
      });
    }
    reservedSessionId = reserved.sessionId;
    if (attempt !== voiceAttempt || expectedSession !== sessionKey()) {
      void emitVoiceAck("voice:web:leave", { sessionId: reservedSessionId, reason: "cancelled" }).catch(() => {});
      return false;
    }
    voiceSessionId = reservedSessionId;

    const joined = await voiceChat.join({
      playerId: currentSession.playerId,
      sessionId: reservedSessionId,
      peerIds: [],
      iceServers: reserved.iceServers,
      speakerMuted: !gameSettings.speakerEnabled,
      speakerVolume: gameSettings.voiceVolume,
    });
    if (!joined.ok) {
      throw Object.assign(new Error(joined.errorCode || "media_error"), {
        errorCode: joined.errorCode || "media_error",
      });
    }
    if (attempt !== voiceAttempt || expectedSession !== sessionKey()) return false;

    const ready = await emitVoiceAck("voice:web:ready", { sessionId: reservedSessionId });
    if (!ready?.ok) {
      throw Object.assign(new Error(ready?.errorCode || "signaling_error"), {
        errorCode: ready?.errorCode || "signaling_error",
      });
    }
    for (const peerId of ready.peerIds || []) {
      if (attempt !== voiceAttempt) return false;
      await voiceChat.addPeer(peerId);
    }
    if (attempt !== voiceAttempt) return false;
    await voiceChat.setSpeakerVolume(gameSettings.voiceVolume);
    await voiceChat.setSpeakerMuted(!gameSettings.speakerEnabled);
    if (voiceOpenMicRequested) {
      const microphone = await voiceChat.setMicrophoneMuted(false);
      if (!microphone.ok) {
        throw Object.assign(new Error(microphone.errorCode || "media_error"), {
          errorCode: microphone.errorCode || "media_error",
        });
      }
    }
    voiceUiError = null;
    return true;
  })();
  voiceJoinPromise = operation;
  renderVoiceControls();

  try {
    return await operation;
  } catch (error) {
    if (reservedSessionId && socket.connected) {
      void emitVoiceAck("voice:web:leave", {
        sessionId: reservedSessionId,
        reason: "join_failed",
      }).catch(() => {});
    }
    await voiceChat.leave({ notify: false });
    if (attempt === voiceAttempt) {
      voiceSessionId = null;
      voiceUiError = error?.errorCode || "media_error";
      showToast(voiceErrorLabel(voiceUiError));
    }
    return false;
  } finally {
    if (voiceJoinPromise === operation) voiceJoinPromise = null;
    voiceOpenMicRequested = false;
    renderVoiceControls();
  }
}

async function stopWebVoice({ notify = true, preserveError = false } = {}) {
  const attempt = ++voiceAttempt;
  const sessionId = voiceSessionId;
  voiceSessionId = null;
  voiceOpenMicRequested = false;
  if (!preserveError) voiceUiError = null;
  if (notify && socket.connected && sessionId) {
    socket.emit("voice:web:leave", { sessionId, reason: "leave" }, () => {});
  }
  await voiceChat.leave({ notify: false });
  gameSettings = saveGameSettings({ ...gameSettings, micEnabled: false });
  if (attempt === voiceAttempt) renderVoiceControls();
}

async function toggleMicrophone() {
  if (!voiceChat.state.joined) {
    const joined = await startWebVoice({ openMic: true });
    gameSettings = saveGameSettings({ ...gameSettings, micEnabled: Boolean(joined) });
    renderSettingsControls();
    return;
  }
  voiceUiError = null;
  const enabling = voiceChat.state.micMuted;
  const result = await voiceChat.setMicrophoneMuted(!voiceChat.state.micMuted);
  if (!result.ok) voiceUiError = result.errorCode;
  gameSettings = saveGameSettings({ ...gameSettings, micEnabled: result.ok && enabling });
  renderVoiceControls();
  renderSettingsControls();
}

async function toggleSpeaker() {
  gameSettings = saveGameSettings({ ...gameSettings, speakerEnabled: true });
  if (!voiceChat.state.joined) {
    await startWebVoice({ openMic: false });
    renderSettingsControls();
    return;
  }
  if (voiceUiError === "playback_blocked" && !voiceChat.state.speakerMuted) {
    const retried = await voiceChat.setSpeakerMuted(false);
    voiceUiError = retried.ok ? null : "playback_blocked";
    renderVoiceControls();
    renderSettingsControls();
    return;
  }
  voiceUiError = null;
  const nextMuted = !voiceChat.state.speakerMuted;
  const result = await voiceChat.setSpeakerMuted(nextMuted);
  gameSettings = saveGameSettings({ ...gameSettings, speakerEnabled: !nextMuted });
  if (!result.ok) voiceUiError = result.errorCode;
  renderVoiceControls();
  renderSettingsControls();
}

function maybeAutoJoinVoice() {
  const key = sessionKey();
  if (
    !key ||
    !gameSettings.speakerEnabled ||
    !canSendRoomEvent() ||
    voiceChat.state.joined ||
    voiceJoinPromise ||
    voiceAutoJoinKey === key
  ) return;
  voiceAutoJoinKey = key;
  void startWebVoice({ openMic: false });
}

function getOrCreateClientId() {
  let id = localStorage.getItem("boltbound.clientId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("boltbound.clientId", id);
  }
  return id;
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem("boltbound.session")) || null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  currentSession = session;
  localStorage.setItem("boltbound.session", JSON.stringify(session));
}

function sessionKey(session = currentSession) {
  if (!session) return "";
  return `${session.code}:${session.playerId}:${session.resumeToken}`;
}

function canSendRoomEvent() {
  return Boolean(roomBound && socket.connected && currentSession);
}

function submitLobbyAction(event, payload, handleRejected = showServerError) {
  if (!socket.connected) return showToast("正在连接房间服务");
  if (pendingLobbyAction) return;
  const attempt = ++lobbyActionAttempt;
  pendingLobbyAction = true;
  entryError.textContent = "";
  socket.timeout(5_000).emit(event, payload, (error, response) => {
    if (attempt !== lobbyActionAttempt) return;
    pendingLobbyAction = false;
    if (error) {
      showToast("连接超时，请重试");
      lobbyActionAttempt += 1;
      if (Array.isArray(socket.sendBuffer)) socket.sendBuffer.length = 0;
      socket.disconnect();
      socket.connect();
      return;
    }
    if (!response?.ok) return handleRejected(response);
    enterSession(response);
  });
}

function clearSession({ stopVoice = true } = {}) {
  if (stopVoice) void stopWebVoice({ notify: false });
  resumeAttempt += 1;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  roomBound = false;
  voiceAutoJoinKey = null;
  pendingResume = false;
  pendingItemAction = null;
  cancelItemTargetSelection();
  currentSession = null;
  currentState = null;
  pendingBuildId = null;
  pendingDraftId = null;
  currentPreviewValid = false;
  displayedBuildId = null;
  localStorage.removeItem("boltbound.session");
  gameScene?.scene?.resume?.();
  gameScene?.clearRoomState();
  renderVoiceControls();
}

function releaseHeldTouchControls() {
  gameScene?.setTouchControl("left", false);
  gameScene?.setTouchControl("right", false);
  gameScene?.setTouchControl("jump", false);
}

function scheduleGameScaleRefresh() {
  const refresh = () => {
    phaserGame?.scale?.refresh?.();
    gameScene?.scale?.refresh?.();
  };
  requestAnimationFrame(refresh);
  window.setTimeout(refresh, 80);
}

function ensureVirtualPointerAdapter() {
  const canvas = $("game-canvas").querySelector("canvas");
  if (!canvas || canvas === virtualPointerCanvas) return;
  virtualPointerAdapter?.destroy();
  virtualPointerCanvas = canvas;
  virtualPointerAdapter = installVirtualPointerAdapter(canvas, {
    isActive: () => virtualLandscapeEnabled,
  });
}

function applyVirtualLandscapeState(enabled) {
  const next = Boolean(enabled);
  if (virtualLandscapeEnabled === next) return false;
  releaseHeldTouchControls();
  virtualPointerAdapter?.releaseActivePointers();
  virtualLandscapeEnabled = next;
  document.documentElement.classList.toggle("virtual-landscape", next);
  virtualLandscapeToolbar.hidden = !next;
  scheduleGameScaleRefresh();
  return true;
}

function landscapeSnapshot() {
  return readLandscapeSnapshot(window);
}

function landscapePresentation(snapshot = landscapeSnapshot()) {
  return resolveLandscapePresentation({
    gameActive: !gameView.hidden,
    coarsePointer: coarsePointerQuery.matches,
    actualLandscape: snapshot.actualLandscape,
    virtualLandscape: virtualLandscapeEnabled,
  });
}

function shouldShowOrientationGate() {
  return landscapePresentation() === "gate" &&
    settingsModal.hidden &&
    itemTargetModal.hidden;
}

function refreshOrientationGate({ focus = false } = {}) {
  const snapshot = landscapeSnapshot();
  const gameActive = !gameView.hidden;
  if (
    virtualLandscapeEnabled &&
    (snapshot.actualLandscape || !gameActive || !coarsePointerQuery.matches)
  ) {
    applyVirtualLandscapeState(false);
  }
  const presentation = landscapePresentation(snapshot);
  document.documentElement.dataset.landscapeMode = presentation;
  virtualLandscapeToolbar.hidden = presentation !== "virtual";
  const visible = shouldShowOrientationGate();
  const wasVisible = orientationGateVisible;
  orientationGateVisible = visible;
  orientationGate.hidden = !visible;
  orientationGate.setAttribute("aria-hidden", String(!visible));
  document.documentElement.classList.toggle("mobile-game-portrait", visible);

  if (!visible) {
    orientationStatus.textContent = "";
    if (orientationGate.contains(document.activeElement)) {
      const visibleView = views.find((view) => !view.hidden);
      const fallback = visibleView?.querySelector("button:not(:disabled), input:not(:disabled)");
      fallback?.focus({ preventScroll: true });
    }
    return;
  }
  if (!wasVisible || focus) {
    requestAnimationFrame(() => enterLandscapeButton.focus({ preventScroll: true }));
  }
}

async function requestLandscapeMode(statusElement = orientationStatus) {
  if (landscapeRequestPromise) return landscapeRequestPromise;
  statusElement.textContent = "";
  statusElement.textContent = "正在请求系统横屏…";
  orientationGate.setAttribute("aria-busy", "true");
  enterLandscapeButton.disabled = true;
  retryNativeLandscapeButton.disabled = true;
  settingsLandscapeButton.disabled = true;

  const operation = (async () => {
    const outcome = await requestNativeLandscape({
      root: document.documentElement,
      documentRef: document,
      screenRef: screen,
      observe: () => waitForActualLandscape({
        readSnapshot: landscapeSnapshot,
        timeoutMs: 800,
      }),
    });
    lastLandscapeOutcome = outcome;
    const serializedOutcome = JSON.stringify(outcome);
    orientationStatus.dataset.nativeOutcome = serializedOutcome;
    settingsDisplayStatus.dataset.nativeOutcome = serializedOutcome;

    if (outcome.actualLandscape) {
      applyVirtualLandscapeState(false);
      statusElement.textContent = "系统横屏已启用。";
    } else if (!gameView.hidden && coarsePointerQuery.matches) {
      applyVirtualLandscapeState(true);
      statusElement.textContent = "设备未旋转，已自动启用兼容横屏。";
    } else {
      const attempted = outcome.fullscreen.attempted || outcome.orientationLock.attempted;
      statusElement.textContent = attempted
        ? "系统未切换方向，请横拿手机后重试。"
        : "当前浏览器没有系统横屏接口。";
    }
    refreshOrientationGate();
    return outcome;
  })();
  landscapeRequestPromise = operation;
  try {
    return await operation;
  } finally {
    if (landscapeRequestPromise === operation) landscapeRequestPromise = null;
    orientationGate.setAttribute("aria-busy", "false");
    enterLandscapeButton.disabled = false;
    retryNativeLandscapeButton.disabled = false;
    settingsLandscapeButton.disabled = false;
    refreshOrientationGate();
  }
}

function listenForMediaQueryChange(query, listener) {
  if (query.addEventListener) query.addEventListener("change", listener);
  else query.addListener?.(listener);
}

function showView(target) {
  if (target !== gameView) applyVirtualLandscapeState(false);
  for (const view of views) view.hidden = view !== target;
  refreshOrientationGate();
}

function playerName() {
  const value = nameInput.value.trim().slice(0, 12);
  if (!value) {
    entryError.textContent = "先输入玩家名";
    nameInput.focus();
    return null;
  }
  localStorage.setItem("boltbound.playerName", value);
  return value;
}

function enterSession(response) {
  resumeAttempt += 1;
  pendingLobbyAction = false;
  lobbyActionAttempt += 1;
  pendingResume = false;
  pendingItemAction = null;
  cancelItemTargetSelection();
  roomBound = true;
  voiceAutoJoinKey = null;
  saveSession({
    code: response.code,
    playerId: response.playerId,
    resumeToken: response.resumeToken,
  });
  entryError.textContent = "";
  if (response.snapshot) applyState(response.snapshot);
}

function resumeSession() {
  if (!currentSession || pendingResume || !socket.connected) return;
  const attempt = ++resumeAttempt;
  const expectedSessionKey = sessionKey();
  pendingResume = true;
  roomBound = false;
  socket.timeout(5_000).emit("room:resume", currentSession, (error, response) => {
    if (attempt !== resumeAttempt || expectedSessionKey !== sessionKey()) return;
    pendingResume = false;
    if (error) {
      window.setTimeout(() => {
        if (attempt === resumeAttempt && expectedSessionKey === sessionKey()) resumeSession();
      }, 750);
      return;
    }
    if (!response?.ok) {
      if (response?.errorCode === "resume_denied") {
        clearSession();
        showView($("home-view"));
        connectionPill.hidden = true;
        showToast(errorMessages.resume_denied);
      } else {
        window.setTimeout(() => {
          if (attempt === resumeAttempt && expectedSessionKey === sessionKey()) resumeSession();
        }, 750);
      }
      return;
    }
    roomBound = true;
    gameScene?.prepareForRoomResume();
    applyState(response.snapshot);
    gameScene?.restoreLocalMotion(response.selfMotion);
    gameScene?.scene?.resume?.();
    connectionPill.hidden = true;
    renderVoiceControls();
  });
}

function applyState(state) {
  if (!currentSession) return;
  const enteringGame = state.phase !== "lobby" && (!currentState || currentState.phase === "lobby");
  currentState = state;
  gameAudio.setGameState(state, Date.now() + bestClockSample.offset);
  const item = state.race?.items?.[currentSession.playerId];
  if (item?.usedAt) pendingItemAction = null;
  if (
    itemTargetSelection &&
    (state.phase !== "race" || item?.usedAt || item?.type !== itemTargetSelection.itemType)
  ) {
    cancelItemTargetSelection();
  }
  if (state.phase === "lobby") {
    showView($("room-view"));
    renderLobby();
  } else {
    showView($("game-view"));
    ensureGame();
    if (enteringGame && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    gameScene?.applyRoomState(state, currentSession.playerId);
    renderGameHud();
  }
  renderVoiceControls();
  maybeAutoJoinVoice();
  createIcons({ icons });
}

function renderLobby() {
  $("room-code").textContent = currentState.code;
  const list = $("player-list");
  list.replaceChildren();

  currentState.players.forEach((player) => {
    const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
    const memberRole = player.id === currentState.hostId ? "房主" : player.bot ? "练习搭档" : "已加入";
    const connectionLabel = player.connected ? "在线" : "离线";
    const item = document.createElement("div");
    item.className = "player-row";
    item.dataset.playerId = player.id;
    item.dataset.voiceBaseLabel = `${player.name}，${memberRole}，${connectionLabel}`;
    item.setAttribute("aria-label", item.dataset.voiceBaseLabel);
    item.innerHTML = `
      <span class="player-avatar-wrap lobby-player-avatar">
        <img src="/assets/${style.key}.svg" alt="" />
        ${playerVoiceActivityMarkup()}
      </span>
      <div><strong>${escapeHtml(player.name)}</strong><span>${memberRole}</span></div>
      <span class="status-dot ${player.connected ? "online" : ""}" aria-label="${player.connected ? "在线" : "离线"}"></span>
    `;
    list.append(item);
  });

  for (let index = currentState.players.length; index < 4; index += 1) {
    const empty = document.createElement("div");
    empty.className = "player-row empty";
    empty.innerHTML = `<span class="empty-slot">${index + 1}</span><div><strong>空位</strong><span>等待加入</span></div>`;
    list.append(empty);
  }
  renderPlayerVoiceIndicators();

  const isHost = currentState.hostId === currentSession.playerId;
  const humans = currentState.players.filter((player) => !player.bot).length;
  startButton.hidden = !isHost;
  startButton.disabled = humans < 2;
  $("lobby-status").textContent = isHost
    ? humans < 2
      ? "再等一名玩家"
      : `${humans} 名玩家已集结`
    : "等待房主开始";
}

function ensureGame() {
  if (phaserGame) return;
  const renderProfile = qualityProfileFor(gameSettings);
  gameScene = new BoltboundScene({
    renderProfile,
    onSceneReady: () => {
      gameAudio.setGameState(currentState, Date.now() + bestClockSample.offset);
      if (currentState) gameScene.applyRoomState(currentState, currentSession.playerId);
    },
    onAudioEvent: (key, options) => gameAudio.play(key, options),
    onPreviewChanged: (valid) => {
      currentPreviewValid = valid;
      refreshBuildControls();
    },
    onPreviewRotated: (angle) => updatePieceAngle(angle),
    onPlacementRequested: (placement) => submitPlacement(placement),
    onRaceReady: (mapRevision) => {
      if (!canSendRoomEvent()) return false;
      socket.emit("race:ready", { mapRevision }, (response) => {
        if (!response?.ok && response?.errorCode !== "invalid_phase") showServerError(response);
      });
      return true;
    },
    onLocalMotion: (motion) => {
      if (!canSendRoomEvent()) return;
      if (motion.snap) socket.emit("race:update", motion);
      else socket.volatile.emit("race:update", motion);
    },
    onLocalFinish: (motion) => {
      if (!canSendRoomEvent()) return false;
      const actionId = crypto.randomUUID();
      socket.emit("race:update", motion);
      socket.emit("race:finish", { actionId }, (response) => {
        if (!response?.ok) {
          if (response?.errorCode === "finish_not_verified") gameScene?.rejectLocalFinish();
          showServerError(response);
          return;
        }
        gameAudio.play("finish", { dedupeKey: actionId });
      });
      return true;
    },
    onLocalDeath: () => {
      if (!canSendRoomEvent()) return;
      socket.emit("race:death", { actionId: crypto.randomUUID() }, (response) => {
        if (!response?.ok && response?.errorCode !== "invalid_phase") showServerError(response);
      });
    },
    onItemUseRequested: () => requestItemUse(),
    onItemTargetIndex: (index) => chooseItemTargetByIndex(index),
  });
  if (Number.isFinite(bestClockSample.rtt)) {
    gameScene.setServerTimeOffset(bestClockSample.offset, bestClockSample.rtt);
  }

  phaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game-canvas",
    width: renderProfile.width,
    height: renderProfile.height,
    backgroundColor: "#bfe0de",
    disableContextMenu: true,
    physics: {
      default: "arcade",
      arcade: { gravity: { y: 1_500 }, debug: false },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: renderProfile.width,
      height: renderProfile.height,
    },
    render: { antialias: true, pixelArt: false, roundPixels: false },
    scene: gameScene,
  });
  ensureVirtualPointerAdapter();
  requestAnimationFrame(ensureVirtualPointerAdapter);
}

function renderGameHud() {
  const state = currentState;
  const me = state.players.find((player) => player.id === currentSession.playerId);
  $("phase-label").textContent = phaseLabels[state.phase] || state.phase;
  $("round-label").textContent = `第 ${state.round} / ${state.maxRounds} 回合`;
  $("room-title").textContent = "集结工友";

  scoreStrip.replaceChildren();
  state.players.forEach((player, index) => {
    const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
    const score = document.createElement("div");
    score.className = `score-item ${player.id === currentSession.playerId ? "me" : ""}`;
    score.dataset.playerId = player.id;
    score.dataset.targetNumber = String(index + 1);
    score.style.setProperty("--player-color", style.color);
    score.dataset.voiceBaseLabel = `${player.name}，${player.score} 分`;
    score.setAttribute("aria-label", score.dataset.voiceBaseLabel);
    score.innerHTML = `
      <span class="player-avatar-wrap score-avatar-wrap">
        <img class="score-avatar" src="/assets/${style.key}.svg" alt="" />
        ${playerVoiceActivityMarkup()}
      </span>
      <b>${escapeHtml(player.name)}</b>
      <strong>${player.score}</strong>
    `;
    scoreStrip.append(score);
  });
  renderPlayerVoiceIndicators();
  refreshItemTargetSelectionUi();

  renderDraftPanel(state);
  renderResultsPanel(state);

  const buildId = state.build?.buildId || state.build?.turnId;
  const myBuildDecision = state.build?.decisions?.[currentSession.playerId];
  const canBuild =
    state.phase === "build" &&
    Boolean(PIECES[state.build?.pieces?.[currentSession.playerId]]) &&
    !myBuildDecision;
  if (!canBuild || pendingBuildId !== buildId) pendingBuildId = null;
  buildDock.hidden = !canBuild;
  if (canBuild) {
    const pieceType = state.build.pieces[currentSession.playerId];
    if (displayedBuildId !== buildId) {
      displayedBuildId = buildId;
      updatePieceAngle(0);
    }
    $("piece-name").textContent = PIECES[pieceType].label;
    $("piece-icon").src = `/assets/piece-${pieceType}.svg`;
    updatePieceAngle(currentPieceAngle);
  } else {
    displayedBuildId = null;
  }
  refreshBuildControls();
  renderItemHud();

  phaseBanner.hidden = true;
  if (state.phase === "build" && !canBuild) {
    const completed = Object.keys(state.build?.decisions || {}).length;
    const total = state.build?.participantIds?.length || Object.keys(state.build?.pieces || {}).length;
    showBanner(myBuildDecision ? "已完成搭建" : "大家同时搭建", `${completed}/${total} 人完成`);
  } else if (state.phase === "race_loading") {
    showBanner("地图锁定", "准备起跑");
  }

  const showTouch = matchMedia("(pointer: coarse)").matches && ["race", "race_countdown"].includes(state.phase);
  touchControls.hidden = !showTouch;

  const gameover = $("gameover-panel");
  gameover.hidden = state.phase !== "gameover";
  if (state.phase === "gameover") {
    const winnerIds = state.race?.winnerIds || [];
    const winners = state.players.filter((player) => winnerIds.includes(player.id));
    if (!winners.length) {
      const topScore = Math.max(...state.players.map((player) => player.score));
      winners.push(...state.players.filter((player) => player.score === topScore));
    }
    $("winner-name").textContent = winners.map((player) => player.name).join(" · ");
    $("rematch").hidden = state.hostId !== currentSession.playerId;
  }

  if (me && !me.connected) connectionPill.hidden = false;
}

function renderDraftPanel(state) {
  const isDraft = state.phase === "draft";
  draftPanel.hidden = !isDraft;
  if (!isDraft) {
    pendingDraftId = null;
    draftOptions.replaceChildren();
    return;
  }

  const draft = state.draft || {};
  const draftId = String(draft.draftId || "");
  const choices = (draft.choices?.[currentSession.playerId] || []).filter((type) => DRAFT_ITEMS[type]);
  const picked = draft.picks?.[currentSession.playerId] || null;
  if (pendingDraftId && (pendingDraftId !== draftId || picked)) pendingDraftId = null;

  const pickedCount = Object.keys(draft.picks || {}).length;
  const participantCount = Object.keys(draft.choices || {}).length;
  if (picked) {
    $("draft-status").textContent = `已选 ${DRAFT_ITEMS[picked]?.label || "零件"} · ${pickedCount}/${participantCount} 人完成`;
  } else if (pendingDraftId === draftId) {
    $("draft-status").textContent = "正在确认选择";
  } else if (choices.length) {
    $("draft-status").textContent = `请选择 1 件 · ${pickedCount}/${participantCount} 人完成`;
  } else {
    $("draft-status").textContent = "等待发放零件";
  }

  draftOptions.replaceChildren();
  for (const type of choices) {
    const piece = DRAFT_ITEMS[type];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `draft-choice ${picked === type ? "selected" : ""}`;
    button.dataset.pieceType = type;
    button.disabled = Boolean(picked) || pendingDraftId === draftId;
    button.setAttribute("aria-label", `选择${piece.label}`);
    button.setAttribute("aria-pressed", String(picked === type));

    const image = document.createElement("img");
    image.src = `/assets/piece-${type}.svg`;
    image.alt = "";
    const name = document.createElement("strong");
    name.textContent = piece.label;
    button.append(image, name);
    draftOptions.append(button);
  }
}

function resultOutcomeLabel(result) {
  if (["finished", "finish"].includes(result.outcome)) {
    return Number.isFinite(Number(result.rank)) ? `第 ${Number(result.rank)} 名` : "抵达终点";
  }
  if (["dead", "death"].includes(result.outcome)) return "本轮出局";
  if (["timed_out", "timeout"].includes(result.outcome)) return "未到终点";
  if (result.outcome === "disconnected") return "中途离线";
  return "本轮结束";
}

function renderResultsPanel(state) {
  const isResults = state.phase === "results";
  resultsPanel.hidden = !isResults;
  if (!isResults) {
    $("results-list").replaceChildren();
    return;
  }

  const list = $("results-list");
  list.replaceChildren();
  const results = Array.isArray(state.race?.results) ? [...state.race.results] : [];
  results.sort((a, b) => {
    const rankA = Number(a.rank) > 0 ? Number(a.rank) : Number.POSITIVE_INFINITY;
    const rankB = Number(b.rank) > 0 ? Number(b.rank) : Number.POSITIVE_INFINITY;
    return rankA - rankB;
  });

  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "results-empty";
    empty.textContent = "正在核对成绩";
    list.append(empty);
    return;
  }

  for (const result of results) {
    const player = state.players.find((candidate) => candidate.id === result.playerId);
    if (!player) continue;
    const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
    const delta = Number(result.pointsDelta) || 0;
    const totalScore = Number.isFinite(Number(result.totalScore)) ? Number(result.totalScore) : player.score;
    const row = document.createElement("div");
    row.className = "result-row";

    const avatar = document.createElement("img");
    avatar.src = `/assets/${style.key}.svg`;
    avatar.alt = "";
    const playerBlock = document.createElement("div");
    playerBlock.className = "result-player";
    const name = document.createElement("strong");
    name.textContent = player.name;
    const outcome = document.createElement("span");
    outcome.textContent = resultOutcomeLabel(result);
    playerBlock.append(name, outcome);

    const scoreBlock = document.createElement("div");
    scoreBlock.className = "result-score";
    const change = document.createElement("strong");
    change.className = delta > 0 ? "positive" : "";
    change.textContent = delta > 0 ? `+${delta}` : String(delta);
    const total = document.createElement("span");
    total.textContent = `总分 ${totalScore}`;
    scoreBlock.append(change, total);
    row.append(avatar, playerBlock, scoreBlock);
    list.append(row);
  }
}

function updatePieceAngle(angle) {
  const numeric = Number(angle);
  currentPieceAngle = Number.isFinite(numeric) ? ((numeric % 360) + 360) % 360 : 0;
  $("piece-angle").textContent = `${currentPieceAngle}°`;
  const pieceIcon = $("piece-icon");
  pieceIcon.style.setProperty("--piece-angle", `${currentPieceAngle}deg`);

  const pieceType = currentState?.build?.pieces?.[currentSession?.playerId];
  const piece = PIECES[pieceType];
  if (piece) {
    const quarterTurn = currentPieceAngle % 180 === 90;
    const rotatedWidth = quarterTurn ? piece.height : piece.width;
    const rotatedHeight = quarterTurn ? piece.width : piece.height;
    const previewScale = Math.min(64 / rotatedWidth, 40 / rotatedHeight);
    pieceIcon.style.width = `${piece.width * previewScale}px`;
    pieceIcon.style.height = `${piece.height * previewScale}px`;
  }
  pieceIcon.style.setProperty("--piece-scale", "1");
  const label = piece?.rotatable
    ? `旋转${piece.label}，当前 ${currentPieceAngle} 度`
    : `${piece?.label || "零件"}不可旋转`;
  rotatePiece.setAttribute("aria-label", label);
  rotatePiece.title = label;
}

function refreshBuildControls() {
  const build = currentState?.build;
  const buildId = build?.buildId || build?.turnId;
  const myTurn =
    roomBound && currentState?.phase === "build" &&
    Boolean(PIECES[build?.pieces?.[currentSession?.playerId]]) &&
    !build?.decisions?.[currentSession?.playerId];
  const pieceType = build?.pieces?.[currentSession?.playerId];
  const busy = myTurn && pendingBuildId === buildId;
  rotatePiece.disabled = !myTurn || busy || !PIECES[pieceType]?.rotatable;
  skipPiece.disabled = !myTurn || busy;
  confirmPiece.disabled = !myTurn || busy || !currentPreviewValid;
}

function showBanner(kicker, title) {
  $("banner-kicker").textContent = kicker;
  $("banner-title").textContent = title;
  phaseBanner.hidden = false;
}

function updateTimer() {
  if (!currentState) return;
  const now = Date.now() + bestClockSample.offset;
  gameAudio.setGameState(currentState, now);
  if (currentState.phase === "lobby") return;
  let target = currentState.phaseDeadline;
  if (currentState.phase === "race_countdown") target = currentState.race?.countdownAt;
  if (currentState.phase === "race") target = currentState.race?.endsAt;
  if (!target) {
    $("phase-timer").textContent = "--";
    return;
  }
  const remaining = Math.max(0, target - now);
  if (currentState.phase === "race_countdown") {
    const count = Math.max(1, Math.ceil(remaining / 1_000));
    $("phase-timer").textContent = String(count);
    showBanner("比赛开始", String(count));
  } else {
    $("phase-timer").textContent = String(Math.ceil(remaining / 1_000));
  }
  refreshItemHudStatus();
  refreshItemTargetSelectionUi();
}

function showServerError(response) {
  showToast(errorMessages[response?.errorCode] || "操作没有成功");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    toast.textContent = "";
  }, 2_600);
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function leaveCurrentRoom() {
  if (!currentSession) return;
  const cancelUnsettledResume = !roomBound && socket.connected;
  void stopWebVoice({ notify: roomBound });
  if (roomBound) socket.emit("room:leave", {}, () => {});
  clearSession({ stopVoice: false });
  if (cancelUnsettledResume) {
    socket.disconnect();
    socket.connect();
  }
  showView($("home-view"));
  connectionPill.hidden = true;
}

$("entry-panel").addEventListener("submit", (event) => event.preventDefault());
nameInput.addEventListener("input", () => {
  entryError.textContent = "";
  localStorage.setItem("boltbound.playerName", nameInput.value.trim());
});

function applyQualityProfile() {
  const profile = qualityProfileFor(gameSettings);
  const actual = gameScene?.applyRenderProfile(profile);
  if (actual && (
    actual.width !== profile.width ||
    actual.height !== profile.height ||
    Math.abs(actual.zoom - profile.zoom) > 0.001 ||
    actual.scrollX !== 0 ||
    actual.scrollY !== 0
  )) {
    settingsDisplayStatus.textContent = "画质切换未完全生效，请重新进入比赛。";
    return false;
  }
  return true;
}

function applyAudioSettings(patch) {
  gameSettings = saveGameSettings({ ...gameSettings, ...patch });
  gameAudio.setSettings(gameSettings);
  renderSettingsControls();
}

function renderSettingsControls() {
  settingsMusicEnabled.checked = gameSettings.musicEnabled;
  settingsMusicVolume.value = String(Math.round(gameSettings.musicVolume * 100));
  settingsMusicVolumeValue.value = `${Math.round(gameSettings.musicVolume * 100)}%`;
  settingsMusicVolumeValue.textContent = settingsMusicVolumeValue.value;
  settingsMusicVolume.disabled = !gameSettings.musicEnabled;
  settingsEffectsEnabled.checked = gameSettings.effectsEnabled;
  settingsEffectsVolume.value = String(Math.round(gameSettings.effectsVolume * 100));
  settingsEffectsVolumeValue.value = `${Math.round(gameSettings.effectsVolume * 100)}%`;
  settingsEffectsVolumeValue.textContent = settingsEffectsVolumeValue.value;
  settingsEffectsVolume.disabled = !gameSettings.effectsEnabled;
  settingsVoiceVolume.value = String(Math.round(gameSettings.voiceVolume * 100));
  settingsVoiceVolumeValue.value = `${Math.round(gameSettings.voiceVolume * 100)}%`;
  settingsVoiceVolumeValue.textContent = settingsVoiceVolumeValue.value;
  settingsSpeaker.checked = gameSettings.speakerEnabled;
  settingsMic.checked = voiceChat.state.joined && !voiceChat.state.micMuted;
  settingsMic.disabled = !currentSession || !roomBound || voiceCapabilities?.web?.available === false;
  for (const radio of settingsModal.querySelectorAll('input[name="quality"]')) {
    radio.checked = radio.value === gameSettings.quality;
  }

  if (!currentSession) settingsVoiceStatus.textContent = "手机浏览器与电脑版可在同一房间互通；微信小游戏语音频道独立。";
  else if (voiceUiError) settingsVoiceStatus.textContent = voiceErrorLabel(voiceUiError);
  else if (voiceChat.state.audiblePeerCount > 0) settingsVoiceStatus.textContent = `正在收听 ${voiceChat.state.audiblePeerCount} 名远端玩家`;
  else if (voiceChat.state.joined) settingsVoiceStatus.textContent = "已进入网页语音，等待其他玩家。";
  else settingsVoiceStatus.textContent = "网页语音待连接。";
}

function focusableElements(container) {
  return [...container.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function openSettings(opener) {
  if (!settingsModal.hidden) return;
  cancelItemTargetSelection();
  settingsOpener = opener || document.activeElement;
  renderSettingsControls();
  settingsModal.hidden = false;
  document.documentElement.classList.add("settings-open");
  refreshOrientationGate();
  requestAnimationFrame(() => settingsPanel.focus({ preventScroll: true }));
}

function closeSettings() {
  if (settingsModal.hidden) return;
  settingsModal.hidden = true;
  document.documentElement.classList.remove("settings-open");
  refreshOrientationGate();
  const opener = settingsOpener;
  settingsOpener = null;
  if (opener?.isConnected && !opener.closest("[hidden]")) opener.focus({ preventScroll: true });
}

function trapModalFocus(event, panel) {
  if (event.key !== "Tab") return;
  const focusable = focusableElements(panel);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-settings-open]");
  if (opener) openSettings(opener);
});
settingsCloseButton.addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) closeSettings();
});
settingsModal.addEventListener("keydown", (event) => trapModalFocus(event, settingsPanel));
settingsMusicEnabled.addEventListener("change", () => {
  applyAudioSettings({ musicEnabled: settingsMusicEnabled.checked });
});
settingsMusicVolume.addEventListener("input", () => {
  applyAudioSettings({ musicVolume: Number(settingsMusicVolume.value) / 100 });
});
settingsEffectsEnabled.addEventListener("change", () => {
  applyAudioSettings({ effectsEnabled: settingsEffectsEnabled.checked });
});
settingsEffectsVolume.addEventListener("input", () => {
  applyAudioSettings({ effectsVolume: Number(settingsEffectsVolume.value) / 100 });
});
settingsVoiceVolume.addEventListener("input", () => {
  gameSettings = saveGameSettings({ ...gameSettings, voiceVolume: Number(settingsVoiceVolume.value) / 100 });
  void voiceChat.setSpeakerVolume(gameSettings.voiceVolume);
  renderSettingsControls();
});
settingsMic.addEventListener("change", async () => {
  if (!currentSession || !roomBound) {
    settingsMic.checked = false;
    settingsVoiceStatus.textContent = "请先加入房间。";
    return;
  }
  if (settingsMic.checked) await toggleMicrophone();
  else if (voiceChat.state.joined && !voiceChat.state.micMuted) await toggleMicrophone();
  renderSettingsControls();
});
settingsSpeaker.addEventListener("change", async () => {
  const enabled = settingsSpeaker.checked;
  gameSettings = saveGameSettings({ ...gameSettings, speakerEnabled: enabled });
  if (!enabled) {
    if (voiceChat.state.joined) await voiceChat.setSpeakerMuted(true);
  } else if (currentSession && roomBound) {
    if (!voiceChat.state.joined) {
      voiceAutoJoinKey = null;
      await startWebVoice({ openMic: false });
    } else {
      const result = await voiceChat.setSpeakerMuted(false);
      voiceUiError = result.ok ? null : result.errorCode;
    }
  }
  renderVoiceControls();
  renderSettingsControls();
});
settingsModal.addEventListener("change", (event) => {
  const quality = event.target.closest('input[name="quality"]');
  if (!quality) return;
  gameSettings = saveGameSettings({ ...gameSettings, quality: quality.value });
  settingsDisplayStatus.textContent = applyQualityProfile() ? "画质已切换。" : settingsDisplayStatus.textContent;
  renderSettingsControls();
});
settingsLandscapeButton.addEventListener("click", () => {
  void requestLandscapeMode(settingsDisplayStatus);
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 5);
  entryError.textContent = "";
});

$("create-room").addEventListener("click", () => {
  const name = playerName();
  if (!name) return;
  submitLobbyAction("room:create", { clientId, name });
});

$("practice").addEventListener("click", () => {
  const name = playerName();
  if (!name) return;
  submitLobbyAction("room:practice", { clientId, name });
});

$("join-room").addEventListener("click", () => {
  const name = playerName();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 5) {
    entryError.textContent = "输入 5 位房间码";
    roomCodeInput.focus();
    return;
  }
  submitLobbyAction("room:join", { clientId, name, code }, (response) => {
    entryError.textContent = errorMessages[response?.errorCode] || "加入失败";
  });
});

startButton.addEventListener("click", () => {
  if (!currentState || !canSendRoomEvent()) return;
  startButton.disabled = true;
  socket.emit("game:start", { expectedRevision: currentState.revision }, (response) => {
    if (!response?.ok) {
      startButton.disabled = false;
      showServerError(response);
    }
  });
});

$("copy-room-code").addEventListener("click", async () => {
  if (!currentState) return;
  try {
    await navigator.clipboard.writeText(currentState.code);
    $("copy-feedback").textContent = "已复制";
  } catch {
    $("copy-feedback").textContent = currentState.code;
  }
  setTimeout(() => ($("copy-feedback").textContent = ""), 1_800);
});

$("leave-room").addEventListener("click", leaveCurrentRoom);
$("game-exit").addEventListener("click", leaveCurrentRoom);
$("game-leave").addEventListener("click", leaveCurrentRoom);
enterLandscapeButton.addEventListener("click", () => {
  void requestLandscapeMode();
});
retryNativeLandscapeButton.addEventListener("click", async () => {
  const outcome = await requestLandscapeMode();
  showToast(outcome?.actualLandscape
    ? "系统横屏已启用"
    : "系统仍未旋转，继续使用兼容横屏");
});
exitVirtualLandscapeButton.addEventListener("click", () => {
  applyVirtualLandscapeState(false);
  refreshOrientationGate({ focus: true });
  orientationStatus.textContent = "已退出兼容横屏；可重试系统横屏。";
});
listenForMediaQueryChange(coarsePointerQuery, () => refreshOrientationGate());
listenForMediaQueryChange(landscapeOrientationQuery, () => refreshOrientationGate());
window.addEventListener("resize", () => refreshOrientationGate());
window.addEventListener("orientationchange", () => refreshOrientationGate());
window.visualViewport?.addEventListener?.("resize", () => refreshOrientationGate());
document.addEventListener("fullscreenchange", () => refreshOrientationGate());
document.addEventListener("webkitfullscreenchange", () => refreshOrientationGate());
screen.orientation?.addEventListener?.("change", () => refreshOrientationGate());

voiceMicButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.currentTarget.blur();
  void toggleMicrophone();
});

voiceSpeakerButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.currentTarget.blur();
  void toggleSpeaker();
});

rotatePiece.addEventListener("click", (event) => {
  event.preventDefault();
  event.currentTarget.blur();
  gameScene?.rotatePreview();
});

draftOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-piece-type]");
  if (!button || !draftOptions.contains(button)) return;
  button.blur();
  submitDraftPick(button.dataset.pieceType);
});

function submitDraftPick(pieceType) {
  if (!canSendRoomEvent()) return;
  const state = currentState;
  const draft = state?.draft;
  const choices = draft?.choices?.[currentSession?.playerId] || [];
  if (
    state?.phase !== "draft" ||
    !draft?.draftId ||
    !DRAFT_ITEMS[pieceType] ||
    !choices.includes(pieceType) ||
    draft.picks?.[currentSession.playerId] ||
    pendingDraftId
  ) return;

  const draftId = draft.draftId;
  const actionId = crypto.randomUUID();
  pendingDraftId = draftId;
  renderDraftPanel(state);
  socket.timeout(5_000).emit(
    "draft:pick",
    {
      draftId,
      round: state.round,
      pieceType,
      actionId,
      expectedRevision: state.revision,
    },
    (error, response) => {
      if (!error && response?.ok) {
        gameAudio.play("draft", { dedupeKey: actionId });
        return;
      }
      if (pendingDraftId === draftId) pendingDraftId = null;
      if (error) showToast("选件超时，请重试");
      else showServerError(response);
      if (currentState?.phase === "draft") renderDraftPanel(currentState);
    },
  );
}

function currentRaceItem() {
  return currentState?.race?.items?.[currentSession?.playerId] || null;
}

function itemTargetOptions() {
  if (!currentState || !currentSession) return [];
  return buildItemTargetOptions({
    players: currentState.players,
    selfPlayerId: currentSession.playerId,
    effects: currentState.race?.effects || {},
    now: Date.now() + bestClockSample.offset,
    reasonOverrides: itemTargetSelection?.reasonOverrides || {},
  });
}

function eligibleItemTargets() {
  return itemTargetOptions().filter((option) => option.selectable);
}

function renderItemHud() {
  const item = currentRaceItem();
  const config = ACTIVE_ITEMS[item?.type];
  const visible = Boolean(config && ["race_loading", "race_countdown", "race"].includes(currentState?.phase));
  itemDock.hidden = !visible;
  if (!visible) {
    itemTargetPrompt.hidden = true;
    return;
  }
  $("item-icon").src = `/assets/piece-${item.type}.svg`;
  $("item-name").textContent = config.label;
  useItemButton.title = `使用${config.label} (Q)`;
  useItemButton.setAttribute("aria-label", `使用${config.label}`);
  refreshItemHudStatus();
}

function refreshItemHudStatus() {
  const item = currentRaceItem();
  const config = ACTIVE_ITEMS[item?.type];
  if (!config || itemDock.hidden) return;
  const pending = pendingItemAction?.itemType === item.type;
  const targeting = itemTargetSelection?.itemType === item.type;
  let status = "待使用";
  if (item.usedAt) {
    const effect = currentState?.race?.effects?.[item.targetPlayerId || currentSession.playerId];
    const active = [effect?.self, effect?.debuff].find(
      (candidate) => candidate?.type === item.type && Number(candidate.endsAt) > Date.now() + bestClockSample.offset,
    );
    status = active
      ? `生效中 ${Math.max(1, Math.ceil((active.endsAt - Date.now() - bestClockSample.offset) / 1_000))}s`
      : "已使用";
  } else if (currentState?.phase !== "race") status = "起跑后可用";
  else if (pending) status = "正在使用";
  else if (targeting) {
    status = `选择目标 ${Math.max(1, Math.ceil((itemTargetSelection.expiresAt - Date.now()) / 1_000))}`;
  }
  $("item-status").textContent = status;
  const me = currentState?.players?.find((player) => player.id === currentSession?.playerId);
  useItemButton.disabled = Boolean(
    item.usedAt || pending || targeting || currentState?.phase !== "race" || me?.status !== "racing",
  );
  itemTargetPrompt.hidden = true;
  if (targeting) {
    $("item-target-title").textContent = `选择${config.label}目标`;
    $("item-target-countdown").textContent = String(
      Math.max(1, Math.ceil((itemTargetSelection.expiresAt - Date.now()) / 1_000)),
    );
  }
}

function refreshItemTargetSelectionUi() {
  const active = Boolean(itemTargetSelection && Date.now() < itemTargetSelection.expiresAt);
  const options = active ? itemTargetOptions() : [];
  const targetIds = new Set(options.filter((option) => option.selectable).map((option) => option.playerId));
  for (const score of scoreStrip.querySelectorAll("[data-player-id]")) {
    const targetable = active && targetIds.has(score.dataset.playerId);
    score.classList.toggle("targetable", targetable);
    score.setAttribute("aria-disabled", String(!targetable));
    if (targetable) {
      score.setAttribute("role", "button");
      score.tabIndex = 0;
    } else {
      score.removeAttribute("role");
      score.removeAttribute("tabindex");
    }
  }

  itemTargetModal.hidden = !active;
  document.documentElement.classList.toggle("target-modal-open", active);
  if (!active) {
    itemTargetModalSignature = "";
    itemTargetList.replaceChildren();
    return;
  }

  const config = ACTIVE_ITEMS[itemTargetSelection.itemType];
  itemTargetModalTitle.textContent = `选择${config?.label || "道具"}目标`;
  itemTargetModalCountdown.textContent = String(Math.max(1, Math.ceil((itemTargetSelection.expiresAt - Date.now()) / 1_000)));
  const signature = JSON.stringify(options.map((option) => [
    option.playerId,
    option.name,
    option.selectable,
    option.reasonCode,
    option.shortcut,
    Boolean(pendingItemAction),
  ]));
  if (signature !== itemTargetModalSignature) {
    itemTargetModalSignature = signature;
    itemTargetList.replaceChildren(...options.map((option) => {
      const style = PLAYER_STYLES[option.styleIndex % PLAYER_STYLES.length];
      const button = document.createElement("button");
      button.type = "button";
      button.className = `item-target-option ${option.selectable ? "available" : "unavailable"}`;
      button.dataset.targetPlayerId = option.playerId;
      button.disabled = !option.selectable || Boolean(pendingItemAction);
      button.innerHTML = `
        <img src="/assets/${style.key}.svg" alt="" />
        <span><strong>${escapeHtml(option.name)}</strong><small>${escapeHtml(option.reasonLabel)}</small></span>
        ${option.shortcut ? `<kbd>${option.shortcut}</kbd>` : ""}
      `;
      return button;
    }));
    createIcons({ icons });
    if (itemTargetSelection.focusPending) {
      itemTargetSelection.focusPending = false;
      requestAnimationFrame(() => {
        const first = itemTargetList.querySelector("button:not(:disabled)") || itemTargetCancelButton;
        first.focus({ preventScroll: true });
      });
    }
  }
}

function cancelItemTargetSelection() {
  if (itemTargetSelection?.timer) clearTimeout(itemTargetSelection.timer);
  itemTargetSelection = null;
  itemTargetError.hidden = true;
  itemTargetError.textContent = "";
  refreshItemTargetSelectionUi();
  if (itemTargetPrompt) itemTargetPrompt.hidden = true;
  refreshItemHudStatus();
  refreshOrientationGate();
}

function beginItemTargetSelection(itemType) {
  closeSettings();
  cancelItemTargetSelection();
  const expiresAt = Date.now() + TARGET_SELECTION_MS;
  const timer = setTimeout(() => {
    if (itemTargetSelection?.itemType !== itemType) return;
    cancelItemTargetSelection();
    showToast("没有选择目标");
  }, TARGET_SELECTION_MS);
  itemTargetSelection = { itemType, expiresAt, timer, reasonOverrides: {}, focusPending: true };
  refreshItemTargetSelectionUi();
  refreshItemHudStatus();
  refreshOrientationGate();
}

function requestItemUse() {
  const me = currentState?.players?.find((player) => player.id === currentSession?.playerId);
  if (!canSendRoomEvent() || currentState?.phase !== "race" || me?.status !== "racing" || pendingItemAction) return;
  const item = currentRaceItem();
  const config = ACTIVE_ITEMS[item?.type];
  if (!config || item.usedAt) return;
  if (config.kind === "target_debuff") {
    beginItemTargetSelection(item.type);
    return;
  }
  submitItemUse(null);
}

function chooseItemTargetByIndex(index) {
  if (!itemTargetSelection || Date.now() >= itemTargetSelection.expiresAt) return;
  const shortcut = String(Number(index) + 1);
  const option = itemTargetOptions().find((candidate) => candidate.shortcut === shortcut);
  if (option?.selectable) submitItemUse(option.playerId);
}

function submitItemUse(targetPlayerId) {
  if (!canSendRoomEvent() || pendingItemAction || currentState?.phase !== "race") return;
  const item = currentRaceItem();
  const config = ACTIVE_ITEMS[item?.type];
  if (!config || item.usedAt) return;
  if (config.kind === "target_debuff" && !eligibleItemTargets().some((option) => option.playerId === targetPlayerId)) {
    return showToast("请选择有效目标");
  }
  const selectionAtSubmit = itemTargetSelection;
  const action = { actionId: crypto.randomUUID(), itemType: item.type, round: currentState.round, targetPlayerId };
  pendingItemAction = action;
  refreshItemHudStatus();
  socket.timeout(5_000).emit(
    "item:use",
    { ...action, targetPlayerId },
    (error, response) => {
      if (!pendingItemAction || pendingItemAction.actionId !== action.actionId) return;
      pendingItemAction = null;
      if (!error && response?.ok) {
        cancelItemTargetSelection();
      } else if (selectionAtSubmit && itemTargetSelection === selectionAtSubmit) {
        if (itemTargetSelection.timer) clearTimeout(itemTargetSelection.timer);
        itemTargetSelection.expiresAt = Date.now() + TARGET_SELECTION_MS;
        itemTargetSelection.timer = setTimeout(() => cancelItemTargetSelection(), TARGET_SELECTION_MS);
        itemTargetSelection.focusPending = true;
        if (!error && isTargetSelectionError(response?.errorCode)) {
          itemTargetSelection.reasonOverrides[targetPlayerId] = response.errorCode;
        }
        itemTargetError.textContent = error
          ? "请求超时，请重新选择目标。"
          : `${errorMessages[response?.errorCode] || "目标状态已变化"}，请重新选择。`;
        itemTargetError.hidden = false;
        showServerError(error ? { errorCode: "target_unavailable" } : response);
      } else if (error) showToast("道具使用超时，请重试");
      else showServerError(response);
      refreshItemTargetSelectionUi();
      refreshItemHudStatus();
    },
  );
}

function submitPlacement(placement = gameScene?.getPlacement()) {
  if (!canSendRoomEvent()) return;
  const state = currentState;
  const build = state?.build;
  if (
    !placement ||
    state?.phase !== "build" ||
    !build ||
    !build.pieces?.[currentSession?.playerId] ||
    build.decisions?.[currentSession?.playerId] ||
    pendingBuildId === (build.buildId || build.turnId)
  ) {
    return;
  }

  const buildId = build.buildId || build.turnId;
  const actionId = crypto.randomUUID();
  pendingBuildId = buildId;
  refreshBuildControls();
  socket.timeout(5_000).emit(
    "build:place",
    {
      placement,
      actionId,
      round: state.round,
      buildId,
    },
    (error, response) => {
      if (error) {
        if (pendingBuildId === buildId) pendingBuildId = null;
        refreshBuildControls();
        showToast("放置超时，请重试");
        return;
      }
      if (!response?.ok) {
        if (pendingBuildId === buildId) pendingBuildId = null;
        showServerError(response);
        refreshBuildControls();
        return;
      }
      gameAudio.play("place", { dedupeKey: actionId });
    },
  );
}

function submitBuildSkip() {
  if (!canSendRoomEvent()) return;
  const state = currentState;
  const build = state?.build;
  if (
    state?.phase !== "build" ||
    !build ||
    !build.pieces?.[currentSession?.playerId] ||
    build.decisions?.[currentSession?.playerId] ||
    pendingBuildId === (build.buildId || build.turnId)
  ) return;

  const buildId = build.buildId || build.turnId;
  pendingBuildId = buildId;
  refreshBuildControls();
  socket.timeout(5_000).emit(
    "build:skip",
    {
      buildId,
      actionId: crypto.randomUUID(),
      round: state.round,
    },
    (error, response) => {
      if (!error && response?.ok) return;
      if (pendingBuildId === buildId) pendingBuildId = null;
      if (error) showToast("跳过超时，请重试");
      else showServerError(response);
      refreshBuildControls();
    },
  );
}

skipPiece.addEventListener("click", (event) => {
  event.preventDefault();
  event.currentTarget.blur();
  submitBuildSkip();
});
itemTargetList.addEventListener("click", (event) => {
  const option = event.target.closest("[data-target-player-id]");
  if (!option || option.disabled) return;
  submitItemUse(option.dataset.targetPlayerId);
});
itemTargetCancelButton.addEventListener("click", () => cancelItemTargetSelection());
itemTargetModal.addEventListener("click", (event) => {
  if (event.target === itemTargetModal) cancelItemTargetSelection();
});
itemTargetModal.addEventListener("keydown", (event) => trapModalFocus(event, itemTargetPanel));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!itemTargetModal.hidden) {
      event.preventDefault();
      cancelItemTargetSelection();
    } else if (!settingsModal.hidden) {
      event.preventDefault();
      closeSettings();
    }
    return;
  }
  if (!itemTargetModal.hidden && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    chooseItemTargetByIndex(Number(event.key) - 1);
  }
});

confirmPiece.addEventListener("click", (event) => {
  event.preventDefault();
  event.currentTarget.blur();
  submitPlacement();
});

useItemButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.currentTarget.blur();
  requestItemUse();
});

scoreStrip.addEventListener("click", (event) => {
  const score = event.target.closest("[data-player-id]");
  if (!score?.classList.contains("targetable")) return;
  submitItemUse(score.dataset.playerId);
});
scoreStrip.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const score = event.target.closest("[data-player-id]");
  if (!score?.classList.contains("targetable")) return;
  event.preventDefault();
  submitItemUse(score.dataset.playerId);
});

$("rematch").addEventListener("click", () => {
  if (!currentState) return;
  socket.emit("game:rematch", { expectedRevision: currentState.revision }, (response) => {
    if (!response?.ok) showServerError(response);
  });
});

for (const button of touchControls.querySelectorAll("[data-control]")) {
  const control = button.dataset.control;
  const press = (event) => {
    event.preventDefault();
    gameScene?.setTouchControl(control, true);
  };
  const release = (event) => {
    event.preventDefault();
    gameScene?.setTouchControl(control, false);
  };
  button.addEventListener("pointerdown", press);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("pointerleave", release);
}

window.addEventListener("blur", () => {
  releaseHeldTouchControls();
});
window.addEventListener("pagehide", () => {
  applyVirtualLandscapeState(false);
  void stopWebVoice({ notify: false });
});

setInterval(updateTimer, 150);

if (!currentSession) showView($("home-view"));
void voiceChat.setSpeakerVolume(gameSettings.voiceVolume);
renderVoiceControls();
renderSettingsControls();
refreshOrientationGate();


