import Phaser from "phaser";
import { Construction, FolderOpen, Download, Hammer, Play, Plus, MousePointer2, Eraser, MapPin,
  Undo2, Redo2, Trash2, RefreshCw, VolumeX, Volume2, Lightbulb, RotateCw, Zap, Search, createIcons } from "lucide";
import "../style.css";
import "./lab.css";
import { ACTIVE_ITEMS, VIEWPORT } from "../../shared/gameConfig.js";
import { validatePlacementSafety } from "../../shared/placementRules.js";
import { GameAudio } from "../audio/GameAudio.js";
import { BrowserAudioBackend } from "../audio/BrowserAudioBackend.js";
import { LabScene } from "./LabScene.js";
import { LabSession, PLAYER_ID, PARTNER_ID, PLACEMENT_ERRORS } from "./LabSession.js";
import { CATALOG, CATALOG_BY_TYPE } from "./catalog.js";

const $ = (id) => document.getElementById(id);
const icons = { Construction, FolderOpen, Download, Hammer, Play, Plus, MousePointer2, Eraser, MapPin,
  Undo2, Redo2, Trash2, RefreshCw, VolumeX, Volume2, Lightbulb, RotateCw, Zap, Search };
const refreshIcons = () => createIcons({ icons });
const STORAGE_KEY = "boltbound.trap-lab.plan.v1";
const session = new LabSession();
const audio = new GameAudio({ backend: new BrowserAudioBackend(), initialSettings: { musicEnabled: false, effectsEnabled: false } });
let selectedType = "beam";
let selectedPlacementId = null;
let filter = "全部";
let deathCount = 0;
let toastTimeout;
let goalNotified = false;
let ready = false;
let soundEnabled = false;

function notify(message) {
  $("lab-toast").textContent = message;
  $("lab-toast").hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $("lab-toast").hidden = true; }, 4500);
}

function log(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.append(time, document.createTextNode(message));
  $("event-log").prepend(item);
  while ($("event-log").children.length > 30) $("event-log").lastElementChild.remove();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session.exportPlan()));
    $("save-state").textContent = "已保存到当前浏览器";
  } catch { $("save-state").textContent = "浏览器保存不可用，请导出方案"; }
}

let restored = false;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) { session.importPlan(JSON.parse(saved)); session.undoStack = []; restored = true; }
} catch { notify("未能恢复上次方案。可通过导入重新加载，当前实验仍可使用。"); }

const scene = new LabScene({
  onEditorReady: () => scene.drawEditor(session.spawn, selectedPlacementId),
  onSceneReady: () => {
    ready = true;
    $("scene-loading").hidden = true;
    syncScene();
    renderControls();
    log(restored ? "已恢复上次搭建方案。" : "实验场已准备好。选择零件，开始搭建。" );
  },
  onPreviewChanged: () => updatePreviewFeedback(),
  onPreviewRotated: (angle) => { $("rotation").textContent = `${angle}°`; },
  onPlacementRequested: (placement) => place(placement),
  onItemUseRequested: () => useItem(),
  onRespawn: () => respawn(),
  onToolPoint: (tool, point) => {
    if (tool === "spawn") {
      if (session.setSpawn(point)) {
        changed();
        log(`测试出生点：${Math.round(session.spawn.x)}, ${Math.round(session.spawn.y)}。`);
        notify("出生点已设置。可放在陷阱附近，开始试用后观察交互。");
      }
      return;
    }
    const piece = scene.pickPlacement(point);
    if (!piece) { notify("此处没有已搭建零件。基础平台不能删除。"); return; }
    if (tool === "erase") { remove(piece.id); return; }
    selectedPlacementId = piece.id;
    selectType(piece.type, false);
    $("place-x").value = piece.x;
    $("place-y").value = piece.y;
    $("rotation").textContent = `${piece.rotation}°`;
    renderControls();
    scene.drawEditor(session.spawn, selectedPlacementId);
  },
  onLocalDeath: (reason) => {
    deathCount += 1;
    session.state.players.find((player) => player.id === PLAYER_ID).status = "dead";
    const causes = { fall: "坠落", hazard: "尖刺", blackhole: "黑洞", saw: "电锯", cannon: "炮弹", laser: "激光" };
    const message = `${causes[reason] || reason}触发死亡。按 R 或点击「复位角色」继续。`;
    log(message);
    notify(message);
    queueMicrotask(() => { syncScene(); renderReadouts(); });
    return true;
  },
  onLocalFinish: () => {
    if (!goalNotified) { log("已到达终点区域；实验继续，不触发计分或结算。"); goalNotified = true; }
    return false;
  },
  onAudioEvent: (key, options) => {
    audio.play(key, options);
    if (key === "portal") log("传送门已触发。观察出口方向与位置。");
  },
});

const game = new Phaser.Game({
  type: Phaser.AUTO, parent: "lab-canvas", width: VIEWPORT.width, height: VIEWPORT.height,
  backgroundColor: "#bfe0de", disableContextMenu: true,
  physics: { default: "arcade", arcade: { gravity: { y: 1500 }, debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: VIEWPORT.width, height: VIEWPORT.height },
  render: { antialias: true, pixelArt: false, roundPixels: false }, scene,
});

function syncScene() {
  if (!ready) return;
  scene.applyRoomState(structuredClone(session.state), PLAYER_ID);
  if (session.state.phase === "build") scene.physics.pause();
  else scene.physics.resume();
  scene.buildGrid.setVisible(session.state.phase === "build");
  scene.drawEditor(session.spawn, selectedPlacementId);
}

function changed() {
  syncScene();
  renderControls();
  save();
}

function setTool(tool) {
  if (!ready || session.state.phase !== "build") return;
  scene.setTool(tool);
  if (tool !== "inspect") selectedPlacementId = null;
  renderControls();
  scene.drawEditor(session.spawn, selectedPlacementId);
}

function place(placement) {
  const result = session.place(placement);
  if (result.error) {
    const message = PLACEMENT_ERRORS[result.error] || result.error;
    notify(message);
    $("placement-feedback").textContent = message;
    $("placement-feedback").classList.add("error");
    return false;
  }
  selectedPlacementId = null;
  changed();
  audio.play("place");
  log(`放置${CATALOG_BY_TYPE[placement.type].label} · (${placement.x}, ${placement.y}) · ${placement.rotation}°。`);
  return true;
}

function remove(id) {
  const piece = session.blueprint.find((entry) => entry.id === id);
  const previousCount = session.blueprint.length;
  if (!session.remove(id)) return;
  selectedPlacementId = null;
  changed();
  const paired = previousCount - session.blueprint.length > 1;
  log(`删除${CATALOG_BY_TYPE[piece.type].label}${paired ? "及其配对门" : ""}。可撤销。`);
  if (paired) notify("已同时移除配对传送门，保持其余传送关系。可撤销恢复。");
}

function selectType(type, placeTool = true) {
  selectedType = type;
  session.selectPiece(type);
  if (placeTool) selectedPlacementId = null;
  if (ready && session.state.phase === "build" && placeTool) scene.setTool("place");
  syncScene();
  renderCatalog();
  renderInspector();
  renderControls();
}

function setMode(mode) {
  if (!ready) return;
  const testing = mode === "test";
  session.enterMode(mode);
  selectedPlacementId = null;
  goalNotified = false;
  clearInput();
  scene.clearBombEffects();
  syncScene();
  scene.resetForRace();
  if (testing) scene.restoreLocalMotion({ ...session.spawn, vx: 0, vy: 0 });
  else { scene.setTool("place"); syncScene(); }
  renderControls();
  renderReadouts();
  log(testing ? "开始试用。搭建方案已载入，机关运行中。" : "返回搭建。试用中的破坏已恢复。" );
}

function respawn() {
  if (!ready || session.state.phase !== "race") return;
  clearInput();
  session.state.players.forEach((player) => { player.status = "racing"; });
  session.clearEffects();
  syncScene();
  scene.resetForRace();
  scene.restoreLocalMotion({ ...session.spawn, vx: 0, vy: 0 });
  goalNotified = false;
  log("角色已复位，效果和冷却已清除；试用场地保持当前状态。" );
  renderReadouts();
}

function useItem() {
  if (!ready || !Object.hasOwn(ACTIVE_ITEMS, selectedType)) return;
  if (session.state.phase !== "race") { setMode("test"); return; }
  const sprite = scene.playerSprites.get(PLAYER_ID)?.sprite;
  const result = session.useItem(selectedType, { received: $("item-target").value === "received", position: { x: sprite.x, y: sprite.y } });
  if (result.error) { notify(result.error); $("item-feedback").textContent = result.error; return; }
  syncScene();
  if (result.blast) {
    scene.receiveBombBlast(result.blast);
    log(`爆破炸弹移除了 ${result.blast.removedPlacementIds.length} 件零件。搭建方案已保留。`);
  } else {
    audio.play("item");
    log(`${CATALOG_BY_TYPE[selectedType].label} → ${result.targetId === PLAYER_ID ? "实验员" : "陪练"}，持续 ${ACTIVE_ITEMS[selectedType].durationMs / 1000} 秒。`);
  }
  $("item-feedback").textContent = "已使用。效果结束后可再次使用，或清除效果立即重试。";
  renderControls();
  renderReadouts();
}

function renderCatalog() {
  const query = $("catalog-search").value.trim().toLowerCase();
  const entries = CATALOG.filter((entry) => (filter === "全部" || entry.category === filter) &&
    `${entry.label} ${entry.type} ${entry.description}`.toLowerCase().includes(query));
  $("catalog-count").textContent = `${CATALOG.length} 种`;
  $("catalog").replaceChildren(...entries.map((entry) => {
    const button = document.createElement("button");
    button.className = `lab-card${entry.type === selectedType ? " active" : ""}`;
    button.dataset.type = entry.type;
    button.setAttribute("aria-label", `${entry.label}，${entry.placeable ? "搭建零件" : "主动道具"}`);
    button.setAttribute("aria-pressed", String(entry.type === selectedType));
    button.innerHTML = `<img src="${entry.icon}" alt="" /><strong>${entry.label}</strong><small>${entry.category}</small>`;
    button.addEventListener("click", () => selectType(entry.type));
    return button;
  }));
  if (!entries.length) { const empty = document.createElement("p"); empty.className = "lab-empty"; empty.textContent = "没有匹配的道具。试试其他关键词。"; $("catalog").append(empty); }
}

function renderInspector() {
  const entry = CATALOG_BY_TYPE[selectedType];
  $("selected-kind").textContent = entry.placeable ? "搭建零件" : "主动道具";
  $("selected-icon").src = entry.icon;
  $("selected-code").textContent = `${entry.category} / ${entry.type}`;
  $("selected-name").textContent = entry.label;
  $("selected-description").textContent = entry.description;
  $("selected-tip").textContent = entry.tip;
  $("piece-controls").hidden = !entry.placeable;
  $("item-controls").hidden = entry.placeable;
  $("target-control").hidden = entry.config.kind !== "target_debuff";
  $("selected-parameters").replaceChildren(...entry.parameters.map((parameter) => {
    const row = document.createElement("div");
    const label = document.createElement("dt");
    const value = document.createElement("dd");
    label.textContent = parameter.label;
    value.textContent = parameter.value;
    row.append(label, value);
    return row;
  }));
}

function updatePreviewFeedback() {
  if (!ready || !scene.preview) { $("placement-feedback").textContent = ""; return; }
  const candidate = { type: scene.preview.pieceType, x: scene.preview.x, y: scene.preview.y, rotation: scene.previewRotation,
    ...scene.pieceDimensions(scene.preview.pieceType, scene.previewRotation) };
  const error = validatePlacementSafety(candidate, session.state.placements, session.state.build.blockers);
  $("placement-feedback").textContent = error ? PLACEMENT_ERRORS[error] : `可放置 · (${candidate.x}, ${candidate.y}) · ${candidate.rotation}°`;
  $("placement-feedback").classList.toggle("error", Boolean(error));
}

function renderControls() {
  const building = session.state.phase === "build";
  $("mode-build").classList.toggle("active", building);
  $("mode-test").classList.toggle("active", !building);
  $("mode-build").setAttribute("aria-pressed", String(building));
  $("mode-test").setAttribute("aria-pressed", String(!building));
  $("toggle-test").querySelector("span").textContent = building ? "开始试用" : "返回搭建";
  $("stage-mode").textContent = building ? "搭建模式" : "交互试用中";
  $("placement-count").textContent = `${session.state.placements.length} 件零件`;
  const hints = { place: "选中零件，在场地点击放置；空格 / R 旋转。", inspect: "点击已搭建零件查看说明，黄色外框标出选中零件。", erase: "点击已搭建零件删除，支持撤销。基础平台保留。", spawn: "点击设置实验员出生点，可放到机关附近测试。" };
  $("canvas-hint").textContent = building ? hints[scene.labTool] : "A / D 移动 · W / 空格跳跃 · Q 使用道具 · R 复位";
  for (const button of document.querySelectorAll("[data-tool]")) {
    button.disabled = !ready || !building;
    button.classList.toggle("active", building && button.dataset.tool === scene.labTool);
    button.setAttribute("aria-pressed", String(building && button.dataset.tool === scene.labTool));
  }
  for (const id of ["rotate", "place-exact", "place-x", "place-y", "clear-map", "import-plan", "delete-selected"]) $(id).disabled = !ready || !building;
  for (const id of ["respawn", "reset-test", "clear-effects"]) $(id).disabled = !ready || building;
  for (const button of document.querySelectorAll("[data-control]")) button.disabled = !ready || building;
  for (const id of ["mode-build", "mode-test", "toggle-test", "use-item", "debug-bodies"]) $(id).disabled = !ready;
  $("undo").disabled = !ready || !building || !session.undoStack.length;
  $("redo").disabled = !ready || !building || !session.redoStack.length;
  $("delete-selected").hidden = !building || !selectedPlacementId;
  $("use-item").querySelector("span").textContent = building ? "进入试用模式" : "使用道具";
  renderReadouts();
}

function renderReadouts() {
  if (!ready) return;
  const sprite = scene.playerSprites.get(PLAYER_ID)?.sprite;
  const state = session.state;
  const dead = state.players.find((player) => player.id === PLAYER_ID).status === "dead";
  $("player-status").textContent = state.phase === "build" ? "等待试用" : dead ? "已死亡 · 按 R 复位" : "试用中";
  if (sprite?.body) {
    $("position-readout").textContent = `${Math.round(sprite.x)} / ${Math.round(sprite.y)}`;
    $("velocity-readout").textContent = `${Math.round(sprite.body.velocity.x)} / ${Math.round(sprite.body.velocity.y)}`;
  }
  const now = Date.now();
  const labels = [];
  for (const id of [PLAYER_ID, PARTNER_ID]) {
    const effects = state.race.effects[id] || {};
    for (const slot of ["self", "debuff"]) {
      const effect = effects[slot];
      if (effect?.endsAt > now) labels.push(`${id === PARTNER_ID ? "陪练 · " : ""}${ACTIVE_ITEMS[effect.type].label} ${((effect.endsAt - now) / 1000).toFixed(1)}s`);
    }
  }
  $("effect-readout").textContent = labels.join(" / ") || "无";
  $("death-readout").textContent = `${deathCount} 次`;
}

function clearInput() {
  for (const key of ["left", "right", "jump"]) scene.setTouchControl(key, false);
  scene.input.keyboard?.resetKeys();
  scene.resetJumpState();
}

$("mode-build").addEventListener("click", () => { if (session.state.phase !== "build") setMode("build"); });
$("mode-test").addEventListener("click", () => { if (session.state.phase !== "race") setMode("test"); });
$("toggle-test").addEventListener("click", () => setMode(session.state.phase === "build" ? "test" : "build"));
$("respawn").addEventListener("click", respawn);
$("reset-test").addEventListener("click", () => { deathCount = 0; setMode("test"); });
$("clear-effects").addEventListener("click", () => { session.clearEffects(); syncScene(); renderReadouts(); log("所有道具效果与冷却已清除。" ); });
$("use-item").addEventListener("click", useItem);
$("rotate").addEventListener("click", () => { setTool("place"); scene.rotatePreview(); });
$("place-exact").addEventListener("click", () => {
  setTool("place");
  const x = Number($("place-x").value);
  const y = Number($("place-y").value);
  scene.movePreview(x, y, true);
  place({ type: selectedType, x, y, rotation: scene.previewRotation });
});
$("delete-selected").addEventListener("click", () => remove(selectedPlacementId));
for (const button of document.querySelectorAll("[data-tool]")) button.addEventListener("click", () => setTool(button.dataset.tool));
for (const direction of ["undo", "redo"]) $(direction).addEventListener("click", () => {
  if (session.history(direction)) { selectedPlacementId = null; changed(); log(direction === "undo" ? "已撤销上一步搭建操作。" : "已重做搭建操作。" ); }
});
$("clear-map").addEventListener("click", () => { if (session.clear()) { selectedPlacementId = null; changed(); log("已清空搭建并恢复初始出生点。可撤销。" ); } });
$("debug-bodies").addEventListener("change", (event) => scene.setDebug(event.target.checked));
$("sound-toggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  audio.unlock();
  audio.setSettings({ effectsEnabled: soundEnabled });
  $("sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
  $("sound-toggle").setAttribute("aria-label", soundEnabled ? "关闭音效" : "开启音效");
  $("sound-toggle").title = soundEnabled ? "关闭音效" : "开启音效";
  $("sound-toggle").innerHTML = `<i data-lucide="${soundEnabled ? "volume-2" : "volume-x"}"></i>`;
  refreshIcons();
  if (soundEnabled) audio.play("ui_click");
});
$("catalog-search").addEventListener("input", renderCatalog);
for (const category of ["全部", ...new Set(CATALOG.map((entry) => entry.category))]) {
  const button = document.createElement("button");
  button.textContent = category;
  button.classList.toggle("active", category === filter);
  button.setAttribute("aria-pressed", String(category === filter));
  button.addEventListener("click", () => {
    filter = category;
    for (const other of $("catalog-filters").children) { other.classList.toggle("active", other === button); other.setAttribute("aria-pressed", String(other === button)); }
    renderCatalog();
  });
  $("catalog-filters").append(button);
}

$("export-plan").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(session.exportPlan(), null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "boltbound-trap-lab.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log("已导出搭建方案，可交给其他开发者复现实验。" );
});
$("import-plan").addEventListener("click", () => $("plan-file").click());
$("plan-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 256000) throw new Error("方案文件过大，请使用实验室导出的 JSON 文件。");
    session.importPlan(JSON.parse(await file.text()));
    selectedPlacementId = null;
    changed();
    log(`已导入 ${session.blueprint.length} 件零件。可撤销本次导入。`);
  } catch (error) { notify(`导入失败：${error.message}`); }
  event.target.value = "";
});

for (const button of document.querySelectorAll("[data-control]")) {
  button.addEventListener("pointerdown", (event) => {
    if (button.disabled) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    scene.setTouchControl(button.dataset.control, true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, () => scene.setTouchControl(button.dataset.control, false));
}

const editing = (element) => element?.matches("input, select, textarea, [contenteditable=true]");
document.addEventListener("focusin", (event) => {
  if (ready && editing(event.target)) {
    clearInput();
    scene.input.keyboard.enabled = false;
    scene.input.keyboard.manager.enabled = false;
  }
});
document.addEventListener("focusout", () => {
  if (ready) {
    scene.input.keyboard.enabled = true;
    scene.input.keyboard.manager.enabled = true;
  }
});
document.addEventListener("keydown", (event) => {
  if (!ready || editing(event.target)) return;
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") { event.preventDefault(); $(event.shiftKey ? "redo" : "undo").click(); }
  if (event.code === "Delete" && selectedPlacementId && session.state.phase === "build") { event.preventDefault(); remove(selectedPlacementId); }
});
window.addEventListener("blur", () => { if (ready) clearInput(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (ready) clearInput(); audio.suspend("hidden"); }
  else audio.resume("hidden");
});
window.addEventListener("pagehide", (event) => { if (!event.persisted) { clearInterval(readoutTimer); audio.destroy(); game.destroy(true); } });
new ResizeObserver(() => game.scale.refresh()).observe($("lab-canvas"));
const readoutTimer = setInterval(renderReadouts, 100);
renderCatalog();
renderInspector();
renderControls();
refreshIcons();
