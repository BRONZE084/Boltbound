import Phaser from "phaser";
import { ACTIVE_ITEMS, DRAFT_ITEMS, PIECES, PLAYER_STYLES, VIEWPORT } from "../../shared/gameConfig.js";
import { applyRenderProfileToScene, getWechatRenderProfile } from "./WechatSettings.js";

const WIDTH = VIEWPORT.width;
const HEIGHT = VIEWPORT.height;
const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

const COLORS = Object.freeze({
  ink: 0x183234,
  deep: 0x10282a,
  paper: 0xf7f4ed,
  paperMuted: 0xe6e6dc,
  coral: 0xf15f48,
  coralDark: 0xc74735,
  teal: 0x258d89,
  tealDark: 0x176662,
  yellow: 0xe5ba43,
  green: 0x73a454,
  red: 0xd94b42,
  white: 0xffffff,
  shadow: 0x071718,
});

const PHASE_LABELS = Object.freeze({
  lobby: "等待",
  draft: "选件",
  build: "同步搭建",
  race_loading: "锁定地图",
  race_countdown: "倒计时",
  race: "竞速",
  results: "本轮结算",
  gameover: "比赛结束",
});

const OUTCOME_LABELS = Object.freeze({
  dead: "本轮出局",
  death: "本轮出局",
  timed_out: "未到终点",
  timeout: "未到终点",
  disconnected: "中途离线",
});

function normalizeAngle(value) {
  const number = Number(value);
  return Number.isFinite(number) ? ((number % 360) + 360) % 360 : 0;
}

function normalizeName(value) {
  return String(value ?? "").trim().slice(0, 12);
}

function normalizeRoomCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, 5);
}

function clampAudioVolume(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function outcomeLabel(result = {}) {
  if (["finished", "finish"].includes(result.outcome)) {
    const rank = Number(result.rank);
    return Number.isFinite(rank) && rank > 0 ? `第 ${rank} 名` : "抵达终点";
  }
  return OUTCOME_LABELS[result.outcome] || "本轮结束";
}

export class WechatUiScene extends Phaser.Scene {
  constructor(bridge = {}, initial = {}) {
    super("WechatUi");
    const safeInitial = initial || {};
    this.bridge = bridge || {};
    this.homeState = {
      name: normalizeName(safeInitial.name),
      roomCode: normalizeRoomCode(safeInitial.roomCode),
      error: "",
    };
    this.roomState = null;
    this.session = null;
    this.connectionStatus = "connecting";
    this.previewState = { valid: false, angle: 0 };
    this.serverTimeOffset = 0;
    this.hasServerTimeSample = false;
    this.currentView = "home";
    this.overlay = null;
    this.ui = {};
    this.heldControls = new Set();
    this.toastTimer = null;
    this.toastObjects = [];
    this.lastClockValue = "";
    this.pendingDraftType = null;
    this.itemTargetSelection = null;
    const initialQuality = safeInitial.settings?.quality || "balanced";
    this.settingsOpen = false;
    this.settingsState = {
      quality: initialQuality,
      musicEnabled: safeInitial.settings?.musicEnabled !== false,
      musicVolume: clampAudioVolume(safeInitial.settings?.musicVolume, 0.45),
      effectsEnabled: safeInitial.settings?.effectsEnabled !== false,
      effectsVolume: clampAudioVolume(safeInitial.settings?.effectsVolume, 0.75),
      micEnabled: safeInitial.settings?.micEnabled === true,
      speakerEnabled: safeInitial.settings?.speakerEnabled !== false,
      landscape: true,
      renderProfile: safeInitial.renderProfile || getWechatRenderProfile(initialQuality),
    };
    this.voiceUiState = {
      capability: { loaded: false, available: false, reason: null, message: "正在检测微信语音" },
      state: {
        status: "idle",
        joined: false,
        micMuted: true,
        speakerMuted: false,
        memberCount: 0,
        speakingCount: 0,
        speakingPlayerIds: [],
        errorCode: null,
      },
      channelIsolation: true,
      busy: false,
    };
  }

  create() {
    this.input.setGlobalTopOnly(true);
    applyRenderProfileToScene(this, this.settingsState.quality);
    this.cameras.main.setScroll(0, 0);
    this.cameras.main.transparent = true;
    this.overlay = this.add.container(0, 0).setDepth(10_000).setScrollFactor(0);
    this.input.on("pointerdown", () => this._invoke("onAudioUnlock"));
    this.input.on("gameout", () => this._releaseAllControls());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this._releaseAllControls());
    this._render();
  }

  showHome({ name, roomCode, error } = {}) {
    if (name !== undefined) this.homeState.name = normalizeName(name);
    if (roomCode !== undefined) this.homeState.roomCode = normalizeRoomCode(roomCode);
    this.homeState.error = String(error || "");
    this.roomState = null;
    this.session = null;
    this.currentView = "home";
    this.pendingDraftType = null;
    this.settingsOpen = false;
    this.itemTargetSelection = null;
    this._render();
  }

  applyRoomState(state, session) {
    if (!state) return;
    const previousPhase = this.roomState?.phase;
    const previousBuildId = this.roomState?.build?.buildId || this.roomState?.build?.turnId;
    const nextBuildId = state.build?.buildId || state.build?.turnId;
    if (state.phase !== "build" || nextBuildId !== previousBuildId) {
      this.previewState = { valid: false, angle: 0 };
    }
    if (!this.hasServerTimeSample && Number.isFinite(Number(state.serverNow))) {
      this.serverTimeOffset = Number(state.serverNow) - Date.now();
    }
    this.roomState = state;
    this.session = session || this.session;
    this.currentView = state.phase === "lobby" ? "lobby" : "game";

    const myId = this._myPlayerId();
    if (state.phase !== "race" || state.race?.items?.[myId]?.usedAt) this.itemTargetSelection = null;
    const picked = state.draft?.picks?.[myId];
    if (picked || state.phase !== "draft") this.pendingDraftType = null;
    this._render();
  }

  setConnection(status) {
    this.connectionStatus = status;
    this._applyConnectionUi();
  }

  setPreviewState(valid, angle) {
    this.previewState.valid = Boolean(valid);
    this.previewState.angle = normalizeAngle(angle);
    this._refreshBuildTools();
  }

  setServerTimeOffset(offset) {
    const value = Number(offset);
    if (!Number.isFinite(value)) return;
    this.serverTimeOffset = value;
    this.hasServerTimeSample = true;
    this.lastClockValue = "";
    this._refreshCountdown(true);
  }

  setDraftPending(pieceType = null) {
    this.pendingDraftType = pieceType && DRAFT_ITEMS[pieceType] ? pieceType : null;
    if (this.roomState?.phase === "draft") this._render();
  }

  setItemTargetSelection(selection = null) {
    const itemType = selection?.itemType;
    const expiresAt = Number(selection?.expiresAt);
    this.itemTargetSelection = ACTIVE_ITEMS[itemType] && Number.isFinite(expiresAt)
      ? {
          itemType,
          expiresAt,
          options: Array.isArray(selection?.options)
            ? selection.options.map((option) => ({ ...option }))
            : [],
          pendingTargetPlayerId: selection?.pendingTargetPlayerId
            ? String(selection.pendingTargetPlayerId)
            : null,
        }
      : null;
    if (this.itemTargetSelection) this.settingsOpen = false;
    if (this.currentView === "game") this._render();
  }

  setSettingsState(snapshot = {}) {
    const quality = snapshot.quality || this.settingsState.quality;
    this.settingsState = {
      ...this.settingsState,
      ...snapshot,
      quality,
      renderProfile: snapshot.renderProfile || getWechatRenderProfile(quality),
    };
    if (this.settingsOpen) this._render();
    else this._refreshVoiceState();
  }

  setVoiceState(snapshot = {}) {
    this.voiceUiState = {
      ...this.voiceUiState,
      ...snapshot,
      capability: { ...this.voiceUiState.capability, ...(snapshot.capability || {}) },
      state: { ...this.voiceUiState.state, ...(snapshot.state || {}) },
    };
    this._refreshVoiceState();
  }

  releaseControls() {
    this._releaseAllControls();
  }

  showToast(message) {
    if (!this.overlay || !message) return;
    this._clearToast();
    const box = this.add
      .rectangle(WIDTH / 2, 820, 620, 82, COLORS.deep, 0.96)
      .setStrokeStyle(3, COLORS.yellow, 1)
      .setScrollFactor(0)
      .setInteractive();
    const label = this._makeText(WIDTH / 2, 820, String(message), 30, "#ffffff", {
      align: "center",
      origin: 0.5,
      wrap: 560,
      fontStyle: "bold",
    });
    this.overlay.add([box, label]);
    this.toastObjects = [box, label];
    this.toastTimer = this.time.delayedCall(2_600, () => this._clearToast());
  }

  update() {
    this._refreshCountdown();
    this._refreshItemState();
  }

  _render() {
    if (!this.overlay) return;
    this._releaseAllControls();
    this._clearToast();
    this.overlay.removeAll(true);
    this.ui = {};
    this.lastClockValue = "";

    if (this.currentView === "home") this._renderHome();
    else if (this.currentView === "lobby") this._renderLobby();
    else this._renderGame();

    this._renderConnection();
    if (this.settingsOpen) this._renderSettingsModal();
    this._refreshCountdown(true);
  }

  _renderHome() {
    this._renderBackdrop(0.55);
    this._addRect(0, HEIGHT / 2, 650, HEIGHT, COLORS.deep, 0.92).setOrigin(0, 0.5);

    this._addText(88, 230, "Boltbound", 76, "#ffffff", { fontStyle: "bold" });
    this._addText(92, 326, "微信小游戏", 34, "#e5ba43", { fontStyle: "bold" });
    this._addText(92, 400, "造路、设障、抢先抵达终点", 28, "#dbe8e4", {
      wrap: 450,
      lineSpacing: 10,
    });

    const fieldX = 1_085;
    this._addText(735, 145, "玩家名", 25, "#183234", { fontStyle: "bold" });
    this._fieldButton("name", fieldX, 220, 700, 96, this.homeState.name || "点击输入玩家名");

    this._button({
      x: fieldX,
      y: 350,
      width: 700,
      height: 96,
      label: "＋  创建房间",
      fill: COLORS.coral,
      pressedFill: COLORS.coralDark,
      fontSize: 34,
      onPress: () => {
        const name = this._validName();
        if (name) this._invoke("onCreate", name);
      },
    });

    this._addText(735, 425, "房间码", 25, "#183234", { fontStyle: "bold" });
    this._fieldButton(
      "roomCode",
      950,
      500,
      430,
      96,
      this.homeState.roomCode || "输入 5 位房间码",
    );
    this._button({
      x: 1_315,
      y: 500,
      width: 250,
      height: 96,
      label: "加入",
      fill: COLORS.teal,
      pressedFill: COLORS.tealDark,
      fontSize: 34,
      onPress: () => {
        const name = this._validName();
        if (!name) return;
        const code = normalizeRoomCode(this.homeState.roomCode);
        if (code.length !== 5) return this.showToast("请输入 5 位房间码");
        this._invoke("onJoin", name, code);
      },
    });

    this._button({
      x: fieldX,
      y: 640,
      width: 700,
      height: 96,
      label: "单人练习",
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: "#183234",
      stroke: COLORS.ink,
      fontSize: 32,
      onPress: () => {
        const name = this._validName();
        if (name) this._invoke("onPractice", name);
      },
    });
    this._renderSettingsButton(1_510, 52);

    if (this.homeState.error) {
      this._addText(fieldX, 734, this.homeState.error, 26, "#b72d27", {
        origin: 0.5,
        align: "center",
        wrap: 700,
        fontStyle: "bold",
      });
    }
  }

  _renderLobby() {
    const state = this.roomState || {};
    const players = Array.isArray(state.players) ? state.players : [];
    const myId = this._myPlayerId();
    const isHost = state.hostId === myId;
    const humans = players.filter((player) => !player.bot).length;

    this._renderBackdrop(0.42);
    this._addRect(WIDTH / 2, 92, WIDTH, 184, COLORS.deep, 0.94);
    this._addText(72, 48, "集结工友", 44, "#ffffff", { fontStyle: "bold" });
    this._addText(74, 112, `房间 ${state.code || "-----"}`, 28, "#e5ba43", {
      fontStyle: "bold",
    });
    this._button({
      x: 435,
      y: 92,
      width: 250,
      height: 82,
      label: "复制房间码",
      fill: COLORS.yellow,
      pressedFill: 0xc79a27,
      textColor: "#183234",
      fontSize: 27,
      onPress: () => this._invoke("onCopy", state.code || ""),
    });
    this._button({
      x: 1_490,
      y: 62,
      width: 140,
      height: 82,
      label: "离开",
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: "#183234",
      stroke: COLORS.ink,
      fontSize: 25,
      onPress: () => this._invoke("onLeave"),
    });
    this._renderSettingsButton(1_360, 62);
    this._renderVoiceControls();

    this._addRect(WIDTH / 2, 475, 1_180, 510, COLORS.paper, 0.96).setStrokeStyle(5, COLORS.ink, 1);
    for (let index = 0; index < 4; index += 1) {
      const y = 285 + index * 110;
      if (index > 0) this._addRect(WIDTH / 2, y - 55, 1_080, 2, COLORS.ink, 0.14);
      const player = players[index];
      if (player) {
        const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
        this._avatar(300, y, style.key, 84, player.name);
        if (!player.bot) {
          this._playerVoiceActivityIndicator(player.id, 330, y + 29, 0.34, 20);
        }
        this._addText(370, y - 24, player.name, 32, "#183234", { fontStyle: "bold" });
        const role = player.id === state.hostId ? "房主" : player.bot ? "练习搭档" : "已加入";
        this._addText(372, y + 20, role, 22, "#587073");
        this._addRect(1_285, y, 20, 20, player.connected ? COLORS.green : 0x9d9d93, 1);
        this._addText(1_250, y, player.connected ? "在线" : "离线", 22, "#587073", {
          origin: { x: 1, y: 0.5 },
        });
      } else {
        this._addRect(300, y, 70, 70, COLORS.paperMuted, 1).setStrokeStyle(3, 0xb4b8ae, 1);
        this._addText(300, y, String(index + 1), 28, "#8b9188", { origin: 0.5, fontStyle: "bold" });
        this._addText(370, y, "空位", 29, "#8b9188", { origin: { x: 0, y: 0.5 } });
      }
    }

    const lobbyStatus = isHost
      ? humans < 2
        ? "再等一名玩家"
        : `${humans} 名玩家已集结`
      : "等待房主开始";
    this._addText(WIDTH / 2, 750, lobbyStatus, 27, "#183234", {
      origin: 0.5,
      fontStyle: "bold",
    });
    this._button({
      x: WIDTH / 2,
      y: 824,
      width: 620,
      height: 96,
      label: isHost ? "开始比赛" : "等待房主开始",
      fill: COLORS.coral,
      pressedFill: COLORS.coralDark,
      fontSize: 34,
      enabled: isHost && humans >= 2,
      onPress: () => this._invoke("onStart"),
    });
  }

  _renderGame() {
    const phase = this.roomState?.phase;
    this._renderGameHeader();

    if (phase === "draft") this._renderDraft();
    else if (phase === "build") this._renderBuild();
    else if (phase === "results") this._renderResults();
    else if (phase === "gameover") this._renderGameover();
    else this._renderRaceHud();
    this._renderItemTargetPanel();
  }

  _renderGameHeader() {
    const state = this.roomState || {};
    const players = Array.isArray(state.players) ? state.players : [];
    this._addRect(WIDTH / 2, 53, WIDTH, 106, COLORS.deep, 0.94).setInteractive();

    this._button({
      x: 172,
      y: 53,
      width: 300,
      height: 82,
      label: `房间 ${state.code || "-----"}`,
      fill: COLORS.yellow,
      pressedFill: 0xc79a27,
      textColor: "#183234",
      fontSize: 25,
      onPress: () => this._invoke("onCopy", state.code || ""),
    });

    this._addText(570, 29, PHASE_LABELS[state.phase] || state.phase || "等待", 25, "#e5ba43", {
      origin: 0.5,
      fontStyle: "bold",
    });
    this._addText(570, 70, `第 ${state.round || 0} / ${state.maxRounds || 0} 回合`, 23, "#ffffff", {
      origin: 0.5,
    });
    this.ui.timerText = this._addText(745, 53, "--", 42, "#ffffff", {
      origin: 0.5,
      fontStyle: "bold",
    });
    this._button({
      x: 1_488,
      y: 53,
      width: 176,
      height: 82,
      label: "离开",
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: "#183234",
      fontSize: 26,
      onPress: () => this._invoke("onLeave"),
    });
    this._renderSettingsButton(1_360, 53);
    this._renderVoiceControls();

    this._addRect(700, 145, 1_200, 70, COLORS.deep, 0.82).setInteractive();
    const scoreWidth = 225;
    const startX = 350;
    players.forEach((player, index) => {
      const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
      const x = startX + index * scoreWidth;
      this._avatar(x, 145, style.key, 56, player.name);
      if (!player.bot) {
        this._playerVoiceActivityIndicator(player.id, x + 20, 164, 0.23, 13);
      }
      this._addText(x + 35, 130, player.name, 20, "#ffffff", {
        fontStyle: "bold",
        wrap: scoreWidth - 56,
      });
      this._addText(x + 35, 158, `${Number(player.score) || 0} 分`, 20, style.color, {
        fontStyle: "bold",
      });
    });
  }

  _renderItemTargetPanel() {
    const selection = this.itemTargetSelection;
    if (!selection || Date.now() >= selection.expiresAt || this.roomState?.phase !== "race") return;
    const item = ACTIVE_ITEMS[selection.itemType];
    if (!item) return;

    const options = Array.isArray(selection.options) ? selection.options : [];
    const rowCount = Math.max(1, options.length);
    const rowHeight = 116;
    const panelWidth = 900;
    const panelHeight = 246 + rowCount * rowHeight;
    const panelX = WIDTH / 2;
    const panelY = HEIGHT / 2 + 10;
    const panelTop = panelY - panelHeight / 2;
    const pendingTargetId = selection.pendingTargetPlayerId;

    this._addRect(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, COLORS.shadow, 0.7).setInteractive();
    this._addRect(panelX, panelY, panelWidth, panelHeight, COLORS.paper, 1)
      .setStrokeStyle(7, COLORS.ink, 1)
      .setInteractive();
    this._addText(panelX, panelTop + 46, `选择${item.label}目标`, 36, "#183234", {
      origin: 0.5,
      fontStyle: "bold",
    });
    this._addText(panelX - 24, panelTop + 88, "点击玩家，或使用对应数字键", 23, "#587073", {
      origin: 0.5,
    });
    this.ui.itemTargetCountdown = this._addText(panelX + 354, panelTop + 46, "6s", 28, "#c74735", {
      origin: 0.5,
      fontStyle: "bold",
    });

    if (!options.length) {
      const emptyY = panelTop + 174;
      this._addRect(panelX, emptyY, 780, 108, COLORS.paperMuted, 1).setStrokeStyle(3, COLORS.ink, 0.25);
      this._addText(panelX, emptyY - 14, "没有其他玩家", 28, "#183234", { origin: 0.5, fontStyle: "bold" });
      this._addText(panelX, emptyY + 24, "可以取消并保留本道具", 21, "#587073", { origin: 0.5 });
    } else {
      options.forEach((option, index) => {
        const y = panelTop + 174 + index * rowHeight;
        const selectable = Boolean(option.selectable && !pendingTargetId);
        const selectedPending = pendingTargetId === option.playerId;
        const fill = selectable ? 0xffffff : COLORS.paperMuted;
        const stroke = selectable ? COLORS.teal : 0x91a19e;
        const hit = this.add.rectangle(panelX, y, 780, 108, fill, 1)
          .setStrokeStyle(4, stroke, selectable ? 1 : 0.55);
        this.overlay.add(hit);
        if (selectable) {
          hit.setInteractive({ useHandCursor: true });
          hit.on("pointerdown", () => hit.setFillStyle(0xd9efea, 1));
          hit.on("pointerout", () => hit.setFillStyle(fill, 1));
          hit.on("pointerup", () => {
            this._invoke("onAudioEvent", "ui_click");
            this._invoke("onItemTarget", option.playerId);
          });
        }
        const styleIndex = ((Number(option.styleIndex) || 0) % PLAYER_STYLES.length + PLAYER_STYLES.length) % PLAYER_STYLES.length;
        const style = PLAYER_STYLES[styleIndex];
        this._avatar(panelX - 326, y, style.key, 70, option.name);
        this._addText(panelX - 270, y - 22, option.name, 28, "#183234", {
          origin: { x: 0, y: 0.5 },
          fontStyle: "bold",
          wrap: 420,
        });
        const statusText = selectedPending
          ? "正在使用"
          : pendingTargetId
            ? "等待确认"
            : option.reasonLabel;
        this._addText(panelX - 270, y + 23, statusText, 22, selectable ? "#176662" : "#687a78", {
          origin: { x: 0, y: 0.5 },
          fontStyle: selectable ? "bold" : "normal",
        });
        if (option.shortcut) {
          this._addRect(panelX + 332, y, 58, 58, selectable ? COLORS.yellow : 0xb8bfba, 1)
            .setStrokeStyle(3, COLORS.ink, 0.7);
          this._addText(panelX + 332, y, option.shortcut, 25, "#183234", {
            origin: 0.5,
            fontStyle: "bold",
          });
        }
      });
    }

    this._button({
      x: panelX,
      y: panelTop + panelHeight - 62,
      width: 280,
      height: 108,
      label: pendingTargetId ? "正在确认" : "取消",
      fill: COLORS.deep,
      pressedFill: COLORS.tealDark,
      fontSize: 28,
      enabled: !pendingTargetId,
      onPress: () => this._invoke("onItemTargetCancel"),
    });
  }

  _renderDraft() {
    const state = this.roomState || {};
    const myId = this._myPlayerId();
    const draft = state.draft || {};
    const choices = (draft.choices?.[myId] || []).filter((type) => DRAFT_ITEMS[type]);
    const picked = draft.picks?.[myId] || null;
    const pickedCount = Object.keys(draft.picks || {}).length;
    const participantCount = Object.keys(draft.choices || {}).length;

    this._addRect(WIDTH / 2, 540, WIDTH, 720, COLORS.shadow, 0.58);
    this._addRect(WIDTH / 2, 510, 1_300, 610, COLORS.paper, 0.98).setStrokeStyle(6, COLORS.ink, 1);
    this._addText(WIDTH / 2, 250, picked ? "零件已选定" : "三选一", 46, "#183234", {
      origin: 0.5,
      fontStyle: "bold",
    });
    const status = picked
      ? `已选 ${DRAFT_ITEMS[picked]?.label || "零件"} · ${pickedCount}/${participantCount} 人完成`
      : this.pendingDraftType
        ? "正在确认选择"
        : `请选择 1 件 · ${pickedCount}/${participantCount} 人完成`;
    this._addText(WIDTH / 2, 310, status, 25, "#587073", { origin: 0.5 });

    if (!choices.length) {
      this._addText(WIDTH / 2, 520, "等待发放零件", 34, "#587073", {
        origin: 0.5,
        fontStyle: "bold",
      });
      return;
    }

    const gap = 40;
    const cardWidth = 350;
    const totalWidth = choices.length * cardWidth + Math.max(0, choices.length - 1) * gap;
    const firstX = WIDTH / 2 - totalWidth / 2 + cardWidth / 2;
    choices.forEach((type, index) => {
      const selected = picked === type;
      const enabled = !picked && !this.pendingDraftType;
      const x = firstX + index * (cardWidth + gap);
      const button = this._button({
        x,
        y: 545,
        width: cardWidth,
        height: 360,
        label: DRAFT_ITEMS[type].label,
        labelY: 660,
        fill: selected ? 0xd8ebd0 : COLORS.white,
        pressedFill: COLORS.paperMuted,
        textColor: "#183234",
        stroke: selected ? COLORS.green : COLORS.ink,
        strokeWidth: selected ? 7 : 4,
        fontSize: 30,
        enabled,
        onPress: () => {
          this.pendingDraftType = type;
          this._setButtonEnabled(button, false);
          this._invoke("onDraftPick", type);
        },
      });
      const image = this._textureImage(x, 505, `piece-${type}`, 220, 190);
      if (image) image.setDepth(button.hit.depth + 1);
      if (selected) this._addText(x + 138, 405, "✓", 40, "#427d32", { origin: 0.5, fontStyle: "bold" });
    });
  }

  _renderBuild() {
    const state = this.roomState || {};
    const myId = this._myPlayerId();
    const decision = state.build?.decisions?.[myId];
    const type = state.build?.pieces?.[myId];
    const isMyTurn = Boolean(PIECES[type]) && !decision;

    if (!isMyTurn) {
      const completed = Object.keys(state.build?.decisions || {}).length;
      const total = state.build?.participantIds?.length || Object.keys(state.build?.pieces || {}).length;
      this._addRect(WIDTH / 2, 470, 660, 174, COLORS.deep, 0.92).setStrokeStyle(5, COLORS.yellow, 1);
      this._addText(WIDTH / 2, 432, decision ? "已完成搭建" : "大家同时搭建", 27, "#e5ba43", {
        origin: 0.5,
        fontStyle: "bold",
      });
      this._addText(WIDTH / 2, 492, `${completed}/${total} 人完成`, 40, "#ffffff", {
        origin: 0.5,
        fontStyle: "bold",
      });
      return;
    }

    const piece = PIECES[type];
    this._addRect(WIDTH / 2, 810, 1_020, 158, COLORS.paper, 0.98)
      .setStrokeStyle(5, COLORS.ink, 1)
      .setInteractive();
    this.ui.buildPieceImage = this._textureImage(385, 810, `piece-${type}`, 150, 105);
    this._addText(490, 780, piece?.label || "当前零件", 28, "#183234", { fontStyle: "bold" });
    this.ui.angleText = this._addText(490, 826, `${this.previewState.angle}°`, 23, "#587073");
    this.ui.validText = this._addText(650, 826, this.previewState.valid ? "可放置" : "位置不可用", 23,
      this.previewState.valid ? "#427d32" : "#b72d27", { fontStyle: "bold" });

    this.ui.rotateButton = this._button({
      x: 850,
      y: 810,
      width: 180,
      height: 104,
      label: "↻ 旋转",
      fill: COLORS.yellow,
      pressedFill: 0xc79a27,
      textColor: "#183234",
      fontSize: 27,
      enabled: Boolean(piece?.rotatable),
      onPress: () => this._invoke("onRotate"),
    });
    this.ui.skipButton = this._button({
      x: 1_055,
      y: 810,
      width: 180,
      height: 104,
      label: "跳过",
      fill: COLORS.paperMuted,
      pressedFill: 0xcacbc2,
      textColor: "#183234",
      stroke: COLORS.ink,
      fontSize: 27,
      onPress: () => this._invoke("onSkip"),
    });
    this.ui.confirmButton = this._button({
      x: 1_285,
      y: 810,
      width: 230,
      height: 104,
      label: "✓ 放置",
      fill: COLORS.teal,
      pressedFill: COLORS.tealDark,
      fontSize: 30,
      enabled: this.previewState.valid,
      onPress: () => this._invoke("onConfirm"),
    });
    this._refreshBuildTools();
  }

  _renderRaceHud() {
    const phase = this.roomState?.phase;
    this._renderItemControl();
    if (phase === "race_loading") {
      this._addText(WIDTH / 2, 430, "地图锁定", 34, "#e5ba43", {
        origin: 0.5,
        fontStyle: "bold",
        stroke: "#10282a",
        strokeThickness: 9,
      });
      this._addText(WIDTH / 2, 500, "准备起跑", 58, "#ffffff", {
        origin: 0.5,
        fontStyle: "bold",
        stroke: "#10282a",
        strokeThickness: 12,
      });
      return;
    }

    if (phase === "race_countdown") {
      this.ui.countdownBig = this._addText(WIDTH / 2, 465, "3", 150, "#ffffff", {
        origin: 0.5,
        fontStyle: "bold",
        stroke: "#10282a",
        strokeThickness: 18,
      });
    }

    if (phase === "race") this._renderTouchControls();
  }

  _renderItemControl() {
    const myId = this._myPlayerId();
    const record = this.roomState?.race?.items?.[myId];
    const item = ACTIVE_ITEMS[record?.type];
    if (!item || !["race_loading", "race_countdown", "race"].includes(this.roomState?.phase)) return;
    const targeting = this.itemTargetSelection?.itemType === record.type;
    const me = this.roomState.players?.find((player) => player.id === myId);
    const enabled = this.roomState.phase === "race" && me?.status === "racing" && !record.usedAt && !targeting;
    this.ui.itemButton = this._button({
      x: 1_205,
      y: 784,
      width: 190,
      height: 116,
      label: record.usedAt ? "已使用" : "使用",
      labelY: 822,
      fill: COLORS.yellow,
      pressedFill: 0xc79a27,
      textColor: "#183234",
      stroke: COLORS.ink,
      fontSize: 24,
      enabled,
      onPress: () => this._invoke("onItemUse"),
    });
    const icon = this._textureImage(1_155, 766, `piece-${record.type}`, 64, 64);
    if (icon) icon.setDepth(this.ui.itemButton.hit.depth + 1);
    this._addText(1_240, 758, item.label, 21, "#183234", {
      origin: 0.5,
      fontStyle: "bold",
      wrap: 110,
      align: "center",
    });
    this.ui.itemStatus = this._addText(1_205, 862, "待使用", 19, "#ffffff", {
      origin: 0.5,
      fontStyle: "bold",
      stroke: "#10282a",
      strokeThickness: 5,
    });
    this._refreshItemState();
  }

  _renderTouchControls() {
    this._holdButton({ x: 140, y: 780, label: "←", control: "left" });
    this._holdButton({ x: 310, y: 780, label: "→", control: "right" });
    this._holdButton({ x: 1_420, y: 770, label: "跳", control: "jump", accent: true });
  }

  _renderResults() {
    const state = this.roomState || {};
    const players = Array.isArray(state.players) ? state.players : [];
    const results = Array.isArray(state.race?.results) ? [...state.race.results] : [];
    results.sort((a, b) => {
      const rankA = Number(a.rank) > 0 ? Number(a.rank) : Number.POSITIVE_INFINITY;
      const rankB = Number(b.rank) > 0 ? Number(b.rank) : Number.POSITIVE_INFINITY;
      return rankA - rankB;
    });

    this._addRect(WIDTH / 2, 540, WIDTH, 720, COLORS.shadow, 0.64);
    this._addRect(WIDTH / 2, 500, 1_080, 640, COLORS.paper, 0.98).setStrokeStyle(6, COLORS.ink, 1);
    this._addText(WIDTH / 2, 230, "本轮成绩", 48, "#183234", { origin: 0.5, fontStyle: "bold" });

    if (!results.length) {
      this._addText(WIDTH / 2, 500, "正在核对成绩", 34, "#587073", { origin: 0.5 });
    } else {
      results.slice(0, 4).forEach((result, index) => {
        const player = players.find((candidate) => candidate.id === result.playerId);
        if (!player) return;
        const y = 330 + index * 106;
        if (index > 0) this._addRect(WIDTH / 2, y - 53, 950, 2, COLORS.ink, 0.13);
        const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
        this._avatar(410, y, style.key, 78, player.name);
        this._addText(470, y - 23, player.name, 29, "#183234", { fontStyle: "bold" });
        this._addText(470, y + 19, outcomeLabel(result), 22, "#587073");
        const delta = Number(result.pointsDelta) || 0;
        this._addText(1_060, y - 17, delta > 0 ? `+${delta}` : String(delta), 32,
          delta > 0 ? "#427d32" : "#183234", { origin: { x: 1, y: 0.5 }, fontStyle: "bold" });
        const total = Number.isFinite(Number(result.totalScore)) ? Number(result.totalScore) : Number(player.score) || 0;
        this._addText(1_060, y + 23, `总分 ${total}`, 21, "#587073", { origin: { x: 1, y: 0.5 } });
      });
    }
    this.ui.resultCountdown = this._addText(WIDTH / 2, 785, "下一轮即将开始", 25, "#587073", {
      origin: 0.5,
      fontStyle: "bold",
    });
  }

  _renderGameover() {
    const state = this.roomState || {};
    const players = Array.isArray(state.players) ? state.players : [];
    const myId = this._myPlayerId();
    const winnerIds = state.race?.winnerIds || [];
    let winners = players.filter((player) => winnerIds.includes(player.id));
    if (!winners.length && players.length) {
      const topScore = Math.max(...players.map((player) => Number(player.score) || 0));
      winners = players.filter((player) => (Number(player.score) || 0) === topScore);
    }

    this._addRect(WIDTH / 2, 540, WIDTH, 720, COLORS.shadow, 0.7);
    this._addRect(WIDTH / 2, 505, 1_080, 650, COLORS.paper, 0.98).setStrokeStyle(7, COLORS.yellow, 1);
    this._addText(WIDTH / 2, 220, "比赛结束", 42, "#587073", { origin: 0.5, fontStyle: "bold" });
    this._addText(WIDTH / 2, 292, winners.map((player) => player.name).join(" · ") || "并列冠军", 58,
      "#183234", { origin: 0.5, fontStyle: "bold", wrap: 900, align: "center" });
    this._addText(WIDTH / 2, 350, "冠军", 27, "#c28c19", { origin: 0.5, fontStyle: "bold" });

    [...players]
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, 4)
      .forEach((player, index) => {
        const y = 420 + index * 72;
        const style = PLAYER_STYLES[player.styleIndex % PLAYER_STYLES.length];
        this._addText(390, y, String(index + 1), 26, "#587073", { origin: 0.5, fontStyle: "bold" });
        this._avatar(455, y, style.key, 58, player.name);
        this._addText(505, y, player.name, 27, "#183234", { origin: { x: 0, y: 0.5 }, fontStyle: "bold" });
        this._addText(1_110, y, `${Number(player.score) || 0} 分`, 28, style.color, {
          origin: { x: 1, y: 0.5 },
          fontStyle: "bold",
        });
      });

    const isHost = state.hostId === myId;
    if (isHost) {
      this._button({
        x: 670,
        y: 805,
        width: 420,
        height: 92,
        label: "再来一局",
        fill: COLORS.coral,
        pressedFill: COLORS.coralDark,
        fontSize: 31,
        onPress: () => this._invoke("onRematch"),
      });
      this._button({
        x: 1_060,
        y: 805,
        width: 300,
        height: 92,
        label: "离开房间",
        fill: COLORS.paperMuted,
        pressedFill: 0xcacbc2,
        textColor: "#183234",
        stroke: COLORS.ink,
        fontSize: 27,
        onPress: () => this._invoke("onLeave"),
      });
    } else {
      this._button({
        x: WIDTH / 2,
        y: 805,
        width: 420,
        height: 92,
        label: "离开房间",
        fill: COLORS.paperMuted,
        pressedFill: 0xcacbc2,
        textColor: "#183234",
        stroke: COLORS.ink,
        fontSize: 28,
        onPress: () => this._invoke("onLeave"),
      });
    }
  }

  _renderBackdrop(shadeAlpha) {
    if (this.textures.exists("yard")) {
      const backdrop = this.add.image(WIDTH / 2, HEIGHT / 2, "yard").setDisplaySize(WIDTH, HEIGHT);
      this.overlay.add(backdrop);
    } else {
      this._addRect(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0xbfe0de, 1);
    }
    this._addRect(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, COLORS.white, shadeAlpha);
  }

  _renderConnection() {
    const rect = this.add
      .rectangle(1_470, 136, 220, 56, COLORS.ink, 0.92)
      .setStrokeStyle(2, COLORS.white, 0.55)
      .setInteractive();
    const dot = this.add.circle(1_390, 136, 9, COLORS.yellow, 1);
    const text = this._makeText(1_414, 136, "连接中", 21, "#ffffff", {
      origin: { x: 0, y: 0.5 },
      fontStyle: "bold",
    });
    this.overlay.add([rect, dot, text]);
    this.ui.connection = { rect, dot, text };
    this._applyConnectionUi();
  }

  _targetSelectionActive() {
    return Boolean(this.itemTargetSelection && Date.now() < this.itemTargetSelection.expiresAt);
  }

  _openSettings() {
    if (this._targetSelectionActive()) {
      this.showToast("先完成当前道具目标选择");
      return;
    }
    this.settingsOpen = true;
    this._releaseAllControls();
    this._render();
  }

  _closeSettings() {
    this.settingsOpen = false;
    this._releaseAllControls();
    this._render();
  }

  _renderSettingsButton(x, y) {
    return this._button({
      x,
      y,
      width: 72,
      height: 74,
      label: "⚙",
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: "#183234",
      stroke: COLORS.yellow,
      strokeWidth: 3,
      fontSize: 34,
      onPress: () => this._openSettings(),
    });
  }

  _renderSettingsModal() {
    const settings = this.settingsState || {};
    const profile = settings.renderProfile || getWechatRenderProfile(settings.quality);
    const voiceState = this.voiceUiState?.state || {};
    const joined = voiceState.joined === true;
    const micEnabled = joined ? !voiceState.micMuted : settings.micEnabled === true;
    const speakerEnabled = joined ? !voiceState.speakerMuted : settings.speakerEnabled !== false;
    const musicVolume = clampAudioVolume(settings.musicVolume, 0.45);
    const effectsVolume = clampAudioVolume(settings.effectsVolume, 0.75);

    this._addRect(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, COLORS.shadow, 0.76).setInteractive();
    this._addRect(WIDTH / 2, HEIGHT / 2, 1_080, 840, COLORS.paper, 1)
      .setStrokeStyle(6, COLORS.ink, 1)
      .setInteractive();
    this._addText(340, 64, "设置", 42, "#183234", { fontStyle: "bold" });
    this._addText(340, 108, "设置会自动保存在本机", 19, "#687a78");
    this._button({
      x: 1_280,
      y: 75,
      width: 82,
      height: 76,
      label: "×",
      fill: COLORS.paperMuted,
      pressedFill: 0xcacbc2,
      textColor: "#183234",
      stroke: COLORS.ink,
      fontSize: 40,
      onPress: () => this._closeSettings(),
    });

    this._addText(340, 155, "语音", 27, "#183234", { fontStyle: "bold" });
    this.ui.settingsVoiceStatus = this._addText(340, 208, "正在检测微信语音", 19, "#587073", {
      wrap: 440,
      lineSpacing: 3,
    });
    this.ui.settingsVoiceActivity = this._voiceActivityIndicator(750, 210, 0.82);
    this.ui.settingsMicButton = this._button({
      x: 875,
      y: 210,
      width: 190,
      height: 82,
      label: micEnabled ? "麦克风 开" : "麦克风 关",
      fill: micEnabled ? COLORS.coral : COLORS.paperMuted,
      pressedFill: micEnabled ? COLORS.coralDark : 0xcacbc2,
      textColor: micEnabled ? "#ffffff" : "#183234",
      stroke: COLORS.ink,
      fontSize: 23,
      onPress: () => this._invoke("onSettingsVoice", "mic"),
    });
    this.ui.settingsSpeakerButton = this._button({
      x: 1_080,
      y: 210,
      width: 190,
      height: 82,
      label: speakerEnabled ? "扬声器 开" : "扬声器 关",
      fill: speakerEnabled ? COLORS.teal : COLORS.paperMuted,
      pressedFill: speakerEnabled ? COLORS.tealDark : 0xcacbc2,
      textColor: speakerEnabled ? "#ffffff" : "#183234",
      stroke: COLORS.ink,
      fontSize: 23,
      onPress: () => this._invoke("onSettingsVoice", "speaker"),
    });
    this.ui.settingsVoiceRetryButton = this._button({
      x: 1_265,
      y: 210,
      width: 140,
      height: 82,
      label: "重试",
      fill: COLORS.yellow,
      pressedFill: 0xc79a27,
      textColor: "#183234",
      stroke: COLORS.ink,
      fontSize: 22,
      onPress: () => this._invoke("onVoiceRetry"),
    });

    this._addRect(WIDTH / 2, 278, 920, 2, COLORS.ink, 0.16);
    this._addText(340, 296, "声音", 27, "#183234", { fontStyle: "bold" });
    this._addText(340, 350, "背景音乐", 23, "#183234", { origin: { x: 0, y: 0.5 }, fontStyle: "bold" });
    this._button({
      x: 715,
      y: 350,
      width: 180,
      height: 76,
      label: settings.musicEnabled !== false ? "已开启" : "已关闭",
      fill: settings.musicEnabled !== false ? COLORS.teal : COLORS.paperMuted,
      pressedFill: settings.musicEnabled !== false ? COLORS.tealDark : 0xcacbc2,
      textColor: settings.musicEnabled !== false ? "#ffffff" : "#183234",
      stroke: COLORS.ink,
      fontSize: 22,
      onPress: () => this._invoke("onSettingsAudio", "musicEnabled", settings.musicEnabled === false),
    });
    this._button({
      x: 925,
      y: 350,
      width: 82,
      height: 76,
      label: "−",
      fill: COLORS.paperMuted,
      pressedFill: 0xcacbc2,
      textColor: "#183234",
      fontSize: 34,
      onPress: () => this._invoke("onSettingsAudio", "musicVolume", Math.round((musicVolume - 0.1) * 10) / 10),
    });
    this._addText(1_045, 350, `${Math.round(musicVolume * 100)}%`, 23, "#183234", { origin: 0.5, fontStyle: "bold" });
    this._button({
      x: 1_165,
      y: 350,
      width: 82,
      height: 76,
      label: "+",
      fill: COLORS.paperMuted,
      pressedFill: 0xcacbc2,
      textColor: "#183234",
      fontSize: 32,
      onPress: () => this._invoke("onSettingsAudio", "musicVolume", Math.round((musicVolume + 0.1) * 10) / 10),
    });
    this._addText(340, 435, "游戏音效", 23, "#183234", { origin: { x: 0, y: 0.5 }, fontStyle: "bold" });
    this._button({
      x: 715,
      y: 435,
      width: 180,
      height: 76,
      label: settings.effectsEnabled !== false ? "已开启" : "已关闭",
      fill: settings.effectsEnabled !== false ? COLORS.coral : COLORS.paperMuted,
      pressedFill: settings.effectsEnabled !== false ? COLORS.coralDark : 0xcacbc2,
      textColor: settings.effectsEnabled !== false ? "#ffffff" : "#183234",
      stroke: COLORS.ink,
      fontSize: 22,
      onPress: () => this._invoke("onSettingsAudio", "effectsEnabled", settings.effectsEnabled === false),
    });
    this._button({
      x: 925,
      y: 435,
      width: 82,
      height: 76,
      label: "−",
      fill: COLORS.paperMuted,
      pressedFill: 0xcacbc2,
      textColor: "#183234",
      fontSize: 34,
      onPress: () => this._invoke("onSettingsAudio", "effectsVolume", Math.round((effectsVolume - 0.1) * 10) / 10),
    });
    this._addText(1_045, 435, `${Math.round(effectsVolume * 100)}%`, 23, "#183234", { origin: 0.5, fontStyle: "bold" });
    this._button({
      x: 1_165,
      y: 435,
      width: 82,
      height: 76,
      label: "+",
      fill: COLORS.paperMuted,
      pressedFill: 0xcacbc2,
      textColor: "#183234",
      fontSize: 32,
      onPress: () => this._invoke("onSettingsAudio", "effectsVolume", Math.round((effectsVolume + 0.1) * 10) / 10),
    });

    this._addRect(WIDTH / 2, 490, 920, 2, COLORS.ink, 0.16);
    this._addText(340, 510, "画质", 27, "#183234", { fontStyle: "bold" });
    this._addText(340, 548, `${profile.width} × ${profile.height} 渲染`, 19, "#587073");
    [
      ["performance", "性能", 760],
      ["balanced", "平衡", 995],
      ["clear", "清晰", 1_230],
    ].forEach(([quality, label, x]) => {
      const selected = settings.quality === quality;
      this._button({
        x,
        y: 560,
        width: 210,
        height: 86,
        label,
        fill: selected ? COLORS.teal : COLORS.paperMuted,
        pressedFill: selected ? COLORS.tealDark : 0xcacbc2,
        textColor: selected ? "#ffffff" : "#183234",
        stroke: selected ? COLORS.yellow : COLORS.ink,
        fontSize: 25,
        onPress: () => this._invoke("onSettingsQuality", quality),
      });
    });

    this._addRect(WIDTH / 2, 615, 920, 2, COLORS.ink, 0.16);
    this._addText(340, 640, "屏幕", 27, "#183234", { fontStyle: "bold" });
    this._addText(760, 650, "横屏", 24, "#183234", { origin: { x: 0, y: 0.5 }, fontStyle: "bold" });
    this._addText(1_245, 650, "已启用", 23, "#427d32", { origin: { x: 1, y: 0.5 }, fontStyle: "bold" });

    this._addRect(WIDTH / 2, 685, 920, 2, COLORS.ink, 0.16);
    this._addText(340, 700, "控制", 27, "#183234", { fontStyle: "bold" });
    this._addText(760, 712, "←  →  移动", 22, "#183234", { origin: { x: 0, y: 0.5 }, fontStyle: "bold" });
    this._addText(1_075, 712, "跳  跳跃", 22, "#183234", { origin: { x: 0, y: 0.5 }, fontStyle: "bold" });
    this._addText(760, 750, "使用  道具", 20, "#587073", { origin: { x: 0, y: 0.5 } });
    this._addText(1_075, 750, "负面道具需选择玩家", 20, "#587073", { origin: { x: 0, y: 0.5 } });

    this._button({
      x: WIDTH / 2,
      y: 820,
      width: 420,
      height: 88,
      label: this.currentView === "home" ? "完成" : "返回游戏",
      fill: COLORS.coral,
      pressedFill: COLORS.coralDark,
      fontSize: 29,
      onPress: () => this._closeSettings(),
    });
    this._refreshVoiceState();
  }

  _renderVoiceControls() {
    this.ui.voiceActivity = this._voiceActivityIndicator(874, 53, 0.72);
    this.ui.voiceTitle = this._addText(900, 21, "微信语音 · 与电脑版独立", 16, "#e5ba43", {
      fontStyle: "bold",
    });
    this.ui.voiceStatus = this._addText(900, 51, "正在检测微信语音", 17, "#ffffff", {
      wrap: 220,
      lineSpacing: 2,
    });
    this.ui.voiceMicButton = this._button({
      x: 1_165,
      y: 53,
      width: 92,
      height: 74,
      label: "麦",
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: "#183234",
      stroke: COLORS.yellow,
      strokeWidth: 3,
      fontSize: 22,
      onPress: () => this._invoke("onVoiceMic"),
    });
    this.ui.voiceSpeakerButton = this._button({
      x: 1_275,
      y: 53,
      width: 92,
      height: 74,
      label: "声",
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: "#183234",
      stroke: COLORS.yellow,
      strokeWidth: 3,
      fontSize: 22,
      onPress: () => this._invoke("onVoiceSpeaker"),
    });
    this._refreshVoiceState();
  }

  _refreshVoiceState() {
    const capability = this.voiceUiState?.capability || {};
    const state = this.voiceUiState?.state || {};
    const busy = this.voiceUiState?.busy === true;
    const isolated = this.voiceUiState?.channelIsolation !== false;
    let status = capability.message || "正在检测微信语音";
    if (busy || ["requesting_permission", "connecting"].includes(state.status)) {
      status = state.status === "requesting_permission" ? "正在申请麦克风权限" : "正在加入语音";
    } else if (state.joined) {
      const members = Math.max(0, Number(state.memberCount) || 0);
      const speaking = Math.max(0, Number(state.speakingCount) || 0);
      status = `已加入 · ${members || 1} 人`;
      if (speaking) status += ` · ${speaking} 人发言`;
    } else if (state.status === "interrupted") {
      status = "语音已中断，点击可重连";
    }
    const voiceActivity = state.joined === true && Math.max(0, Number(state.speakingCount) || 0) > 0;
    this.ui.voiceTitle?.setText(isolated ? "微信原生语音 · 仅小游戏" : "微信语音");
    this.ui.voiceStatus?.setText(status);
    this.ui.settingsVoiceStatus?.setText(status);
    this._updateVoiceActivityIndicator(this.ui.voiceActivity, voiceActivity);
    this._updateVoiceActivityIndicator(this.ui.settingsVoiceActivity, voiceActivity);
    const speakingPlayerIds = new Set(
      state.joined === true && Array.isArray(state.speakingPlayerIds)
        ? state.speakingPlayerIds
        : [],
    );
    for (const [playerId, indicator] of this.ui.playerVoiceIndicators || []) {
      this._updatePlayerVoiceActivityIndicator(indicator, speakingPlayerIds.has(playerId));
    }

    const updateButton = (button, { label, fill, pressedFill, textColor = "#183234" }) => {
      if (!button?.hit) return;
      button.fill = fill;
      button.pressedFill = pressedFill;
      button.textColor = textColor;
      button.text.setText(label).setColor(textColor);
      this._setButtonEnabled(button, !busy);
      if (!busy) button.hit.setFillStyle(fill, 1);
    };
    const joined = state.joined === true;
    updateButton(this.ui.voiceMicButton, {
      label: joined ? (state.micMuted ? "麦关" : "麦开") : "麦",
      fill: joined && !state.micMuted ? COLORS.coral : COLORS.paper,
      pressedFill: joined && !state.micMuted ? COLORS.coralDark : COLORS.paperMuted,
      textColor: joined && !state.micMuted ? "#ffffff" : "#183234",
    });
    updateButton(this.ui.voiceSpeakerButton, {
      label: joined ? (state.speakerMuted ? "声关" : "声开") : "声",
      fill: joined && !state.speakerMuted ? COLORS.teal : COLORS.paper,
      pressedFill: joined && !state.speakerMuted ? COLORS.tealDark : COLORS.paperMuted,
      textColor: joined && !state.speakerMuted ? "#ffffff" : "#183234",
    });
    const micEnabled = joined ? !state.micMuted : this.settingsState?.micEnabled === true;
    const speakerEnabled = joined ? !state.speakerMuted : this.settingsState?.speakerEnabled !== false;
    updateButton(this.ui.settingsMicButton, {
      label: micEnabled ? "麦克风 开" : "麦克风 关",
      fill: micEnabled ? COLORS.coral : COLORS.paperMuted,
      pressedFill: micEnabled ? COLORS.coralDark : 0xcacbc2,
      textColor: micEnabled ? "#ffffff" : "#183234",
    });
    updateButton(this.ui.settingsSpeakerButton, {
      label: speakerEnabled ? "扬声器 开" : "扬声器 关",
      fill: speakerEnabled ? COLORS.teal : COLORS.paperMuted,
      pressedFill: speakerEnabled ? COLORS.tealDark : 0xcacbc2,
      textColor: speakerEnabled ? "#ffffff" : "#183234",
    });
    this._setButtonEnabled(this.ui.settingsVoiceRetryButton, !busy);
  }

  _voiceActivityIndicator(x, y, scale = 1) {
    const heights = [14, 24, 34, 24];
    const bars = heights.map((height, index) => {
      const width = 7 * scale;
      const gap = 5 * scale;
      const bar = this._addRect(
        x + index * (width + gap),
        y + (34 * scale - height * scale) / 2,
        width,
        height * scale,
        0x8ea19f,
        0.42,
      );
      return bar;
    });
    return { bars };
  }

  _updateVoiceActivityIndicator(indicator, active) {
    for (const bar of indicator?.bars || []) {
      bar.setFillStyle(active ? COLORS.coral : 0x8ea19f, active ? 1 : 0.42);
    }
  }

  _playerVoiceActivityIndicator(playerId, x, y, scale, radius) {
    const badge = this.add
      .circle(x, y, radius, COLORS.paperMuted, 0.72)
      .setStrokeStyle(Math.max(2, Math.round(radius * 0.15)), COLORS.ink, 0.9)
      .setScrollFactor(0);
    this.overlay.add(badge);
    const width = 7 * scale;
    const gap = 5 * scale;
    const totalWidth = width * 4 + gap * 3;
    const indicator = {
      badge,
      ...this._voiceActivityIndicator(x - totalWidth / 2 + width / 2, y, scale),
    };
    this.ui.playerVoiceIndicators ||= new Map();
    this.ui.playerVoiceIndicators.set(String(playerId), indicator);
    const state = this.voiceUiState?.state || {};
    const active = state.joined === true &&
      Array.isArray(state.speakingPlayerIds) &&
      state.speakingPlayerIds.includes(playerId);
    this._updatePlayerVoiceActivityIndicator(indicator, active);
    return indicator;
  }

  _updatePlayerVoiceActivityIndicator(indicator, active) {
    indicator?.badge
      ?.setFillStyle(active ? COLORS.coral : COLORS.paperMuted, active ? 1 : 0.72)
      .setAlpha(active ? 1 : 0.62);
    for (const bar of indicator?.bars || []) {
      bar
        .setFillStyle(active ? COLORS.white : 0x587073, active ? 1 : 0.52)
        .setAlpha(active ? 1 : 0.72);
    }
  }

  _applyConnectionUi() {
    if (!this.ui.connection) return;
    const raw = this.connectionStatus;
    const status = raw === true ? "connected" : raw === false ? "disconnected" : String(raw || "connecting").toLowerCase();
    let label = "连接中";
    let color = COLORS.yellow;
    if (["connected", "online", "open", "ready"].includes(status)) {
      label = "已联网";
      color = COLORS.green;
    } else if (["disconnected", "offline", "closed", "error", "failed"].includes(status)) {
      label = "正在重连";
      color = COLORS.red;
    }
    this.ui.connection.dot.setFillStyle(color, 1);
    this.ui.connection.text.setText(label);
  }

  _fieldButton(field, x, y, width, height, value) {
    return this._button({
      x,
      y,
      width,
      height,
      label: value,
      fill: COLORS.paper,
      pressedFill: COLORS.paperMuted,
      textColor: value.startsWith("点击") || value.startsWith("输入") ? "#7a8786" : "#183234",
      stroke: COLORS.ink,
      fontSize: field === "roomCode" ? 30 : 29,
      align: "left",
      onPress: () => this._editField(field),
    });
  }

  _editField(field) {
    const currentValue = field === "roomCode" ? this.homeState.roomCode : this.homeState.name;
    const commit = (value) => {
      if (field === "roomCode") this.homeState.roomCode = normalizeRoomCode(value);
      else this.homeState.name = normalizeName(value);
      this.homeState.error = "";
      if (this.currentView === "home") this._render();
    };
    const result = this._invoke("onEditField", field, currentValue, commit);
    if (typeof result === "string") commit(result);
    else if (result && typeof result.then === "function") {
      result.then((value) => {
        if (typeof value === "string") commit(value);
      }).catch(() => this.showToast("输入没有成功"));
    }
  }

  _validName() {
    const name = normalizeName(this.homeState.name);
    if (!name) {
      this.showToast("请先输入玩家名");
      return null;
    }
    this.homeState.name = name;
    return name;
  }

  _button({
    x,
    y,
    width,
    height,
    label,
    onPress,
    fill = COLORS.teal,
    pressedFill = COLORS.tealDark,
    textColor = "#ffffff",
    stroke = COLORS.deep,
    strokeWidth = 4,
    fontSize = 30,
    enabled = true,
    align = "center",
    labelY = y,
  }) {
    const hit = this.add.rectangle(x, y, width, Math.max(80, height), fill, 1).setStrokeStyle(strokeWidth, stroke, 1);
    const labelX = align === "left" ? x - width / 2 + 30 : x;
    const text = this._makeText(labelX, labelY, label, fontSize, textColor, {
      origin: align === "left" ? { x: 0, y: 0.5 } : 0.5,
      align,
      fontStyle: "bold",
      wrap: width - 42,
    });
    this.overlay.add([hit, text]);
    const button = { hit, text, enabled: true, fill, pressedFill, textColor };

    hit.setInteractive({ useHandCursor: true });
    hit.on("pointerdown", () => {
      if (!button.enabled) return;
      hit.setFillStyle(button.pressedFill, 1);
      hit.setScale(0.985);
      text.setScale(0.985);
    });
    hit.on("pointerup", () => {
      if (!button.enabled) return;
      hit.setFillStyle(button.fill, 1).setScale(1);
      text.setScale(1);
      this._invoke("onAudioEvent", "ui_click");
      onPress?.();
    });
    const cancel = () => {
      hit.setFillStyle(button.enabled ? button.fill : COLORS.paperMuted, button.enabled ? 1 : 0.82).setScale(1);
      text.setScale(1);
    };
    hit.on("pointerout", cancel);
    hit.on("pointerupoutside", cancel);
    this._setButtonEnabled(button, enabled);
    return button;
  }

  _setButtonEnabled(button, enabled) {
    if (!button?.hit) return;
    button.enabled = Boolean(enabled);
    button.hit.setAlpha(button.enabled ? 1 : 0.58);
    button.text.setAlpha(button.enabled ? 1 : 0.58);
    button.hit.setFillStyle(button.enabled ? button.fill : COLORS.paperMuted, 1);
    if (button.hit.input) button.hit.input.enabled = button.enabled;
  }

  _holdButton({ x, y, label, control, accent = false }) {
    const size = accent ? 154 : 138;
    const fill = accent ? COLORS.coral : COLORS.deep;
    const pressedFill = accent ? COLORS.coralDark : COLORS.tealDark;
    const hit = this.add.circle(x, y, size / 2, fill, 0.86).setStrokeStyle(5, COLORS.white, 0.82);
    const text = this._makeText(x, y, label, accent ? 40 : 64, "#ffffff", {
      origin: 0.5,
      fontStyle: "bold",
    });
    this.overlay.add([hit, text]);
    hit.setInteractive({ useHandCursor: true });

    const press = () => {
      if (this.heldControls.has(control)) return;
      this.heldControls.add(control);
      hit.setFillStyle(pressedFill, 0.98).setScale(0.95);
      text.setScale(0.95);
      this._invoke("onTouchControl", control, true);
    };
    const release = () => {
      if (!this.heldControls.delete(control)) return;
      hit.setFillStyle(fill, 0.86).setScale(1);
      text.setScale(1);
      this._invoke("onTouchControl", control, false);
    };
    hit.on("pointerdown", press);
    hit.on("pointerup", release);
    hit.on("pointerout", release);
    hit.on("pointerupoutside", release);
  }

  _releaseAllControls() {
    for (const control of [...this.heldControls]) {
      this.heldControls.delete(control);
      this._invoke("onTouchControl", control, false);
    }
  }

  _refreshBuildTools() {
    const angle = normalizeAngle(this.previewState.angle);
    this.ui.angleText?.setText(`${angle}°`);
    if (this.ui.buildPieceImage) this.ui.buildPieceImage.setAngle(angle);
    if (this.ui.validText) {
      this.ui.validText
        .setText(this.previewState.valid ? "可放置" : "位置不可用")
        .setColor(this.previewState.valid ? "#427d32" : "#b72d27");
    }
    this._setButtonEnabled(this.ui.confirmButton, this.previewState.valid);
  }

  _refreshItemState() {
    const record = this.roomState?.race?.items?.[this._myPlayerId()];
    const config = ACTIVE_ITEMS[record?.type];
    if (!record || !config) return;
    const targeting = this.itemTargetSelection?.itemType === record.type &&
      Date.now() < this.itemTargetSelection.expiresAt;
    if (this.itemTargetSelection && !targeting) {
      this.itemTargetSelection = null;
    }
    let status = this.roomState.phase === "race" ? "待使用" : "起跑后可用";
    if (record.usedAt) {
      const effectState = this.roomState.race?.effects?.[record.targetPlayerId || this._myPlayerId()];
      const effect = [effectState?.self, effectState?.debuff].find(
        (candidate) => candidate?.type === record.type && Number(candidate.endsAt) > Date.now() + this.serverTimeOffset,
      );
      status = effect
        ? `生效中 ${Math.max(1, Math.ceil((effect.endsAt - Date.now() - this.serverTimeOffset) / 1_000))}s`
        : "已使用";
    } else if (targeting) {
      status = this.itemTargetSelection.pendingTargetPlayerId
        ? "正在确认目标"
        : `选择目标 ${Math.max(1, Math.ceil((this.itemTargetSelection.expiresAt - Date.now()) / 1_000))}`;
    }
    this.ui.itemStatus?.setText(status);
    this.ui.itemTargetCountdown?.setText(
      `${Math.max(1, Math.ceil(((this.itemTargetSelection?.expiresAt || Date.now()) - Date.now()) / 1_000))}s`,
    );
    this._setButtonEnabled(
      this.ui.itemButton,
      this.roomState.phase === "race" &&
        this.roomState.players?.find((player) => player.id === this._myPlayerId())?.status === "racing" &&
        !record.usedAt && !targeting,
    );
  }

  _refreshCountdown(force = false) {
    const state = this.roomState;
    if (!state) return;
    let target = state.phaseDeadline;
    if (state.phase === "race_countdown") target = state.race?.countdownAt ?? target;
    else if (state.phase === "race") target = state.race?.endsAt ?? target;

    const numericTarget = Number(target);
    const seconds = Number.isFinite(numericTarget)
      ? Math.max(0, Math.ceil((numericTarget - (Date.now() + this.serverTimeOffset)) / 1_000))
      : null;
    const key = `${state.phase}:${seconds ?? "--"}`;
    if (!force && key === this.lastClockValue) return;
    this.lastClockValue = key;

    if (this.ui.timerText) {
      this.ui.timerText.setText(seconds === null ? "--" : state.phase === "race_countdown" ? String(Math.max(1, seconds)) : `${seconds}s`);
    }
    if (this.ui.countdownBig) this.ui.countdownBig.setText(String(Math.max(1, seconds || 1)));
    if (this.ui.resultCountdown) {
      this.ui.resultCountdown.setText(seconds === null ? "下一轮即将开始" : `${seconds} 秒后进入下一轮`);
    }
  }

  _myPlayerId() {
    if (typeof this.session === "string") return this.session;
    return this.session?.playerId || this.session?.id || null;
  }

  _invoke(name, ...args) {
    const callback = this.bridge?.[name];
    if (typeof callback !== "function") return undefined;
    try {
      const result = callback(...args);
      if (result && typeof result.then === "function" && name !== "onEditField") {
        result.catch(() => this.showToast("操作没有成功"));
      }
      return result;
    } catch {
      this.showToast("操作没有成功");
      return undefined;
    }
  }

  _textureImage(x, y, key, maxWidth, maxHeight) {
    if (!key || !this.textures.exists(key)) return null;
    const image = this.add.image(x, y, key);
    const width = Math.max(1, image.width);
    const height = Math.max(1, image.height);
    image.setScale(Math.min(maxWidth / width, maxHeight / height));
    this.overlay.add(image);
    return image;
  }

  _avatar(x, y, key, size, name) {
    const image = this._textureImage(x, y, key, size, size);
    if (image) return image;
    this._addRect(x, y, size, size, COLORS.teal, 1).setStrokeStyle(3, COLORS.ink, 1);
    this._addText(x, y, String(name || "工").slice(0, 1), Math.round(size * 0.42), "#ffffff", {
      origin: 0.5,
      fontStyle: "bold",
    });
    return null;
  }

  _addRect(x, y, width, height, color, alpha = 1) {
    const rectangle = this.add.rectangle(x, y, width, height, color, alpha).setScrollFactor(0);
    this.overlay.add(rectangle);
    return rectangle;
  }

  _addText(x, y, value, size, color, options = {}) {
    const text = this._makeText(x, y, value, size, color, options);
    this.overlay.add(text);
    return text;
  }

  _makeText(x, y, value, size, color, options = {}) {
    const style = {
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
      align: options.align || "left",
      fontStyle: options.fontStyle || "normal",
      lineSpacing: options.lineSpacing || 0,
    };
    if (options.wrap) style.wordWrap = { width: options.wrap, useAdvancedWrap: true };
    if (options.stroke) {
      style.stroke = options.stroke;
      style.strokeThickness = options.strokeThickness || 0;
    }
    const text = this.add.text(x, y, String(value ?? ""), style).setScrollFactor(0);
    if (options.origin !== undefined) {
      if (typeof options.origin === "number") text.setOrigin(options.origin);
      else text.setOrigin(options.origin.x, options.origin.y);
    }
    return text;
  }

  _clearToast() {
    this.toastTimer?.remove(false);
    this.toastTimer = null;
    for (const object of this.toastObjects) {
      if (object?.active) object.destroy();
    }
    this.toastObjects = [];
  }
}
