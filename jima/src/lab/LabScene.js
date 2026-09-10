import { BoltboundScene } from "../game/BoltboundScene.js";
import { dimensionsForPiece } from "../../shared/placementRules.js";

// The original scene owns movement, collisions, mechanisms, previews and effects.
// This subclass only supplies editor gestures and an experiment spawn marker.
export class LabScene extends BoltboundScene {
  constructor(bridge) {
    super(bridge);
    this.labTool = "place";
  }

  create() {
    super.create();
    this.editorOverlay = this.add.graphics().setDepth(15);
    this.bridge.onEditorReady?.();
    this.input.keyboard.on("keydown-R", (event) => {
      if (event.repeat) return;
      if (this.roomState?.phase === "build") this.rotatePreview();
      else this.bridge.onRespawn?.();
    });
  }

  canBuildNow() { return this.labTool === "place" && super.canBuildNow(); }

  handlePreviewPointerDown(pointer) {
    if (this.roomState?.phase !== "build" || !pointer.primaryDown) return;
    if (this.labTool === "place") return super.handlePreviewPointerDown(pointer);
    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.bridge.onToolPoint?.(this.labTool, { x: point.x, y: point.y });
  }

  setTool(tool) {
    this.labTool = tool;
    this.ensurePreview();
    this.buildGrid?.setVisible(this.roomState?.phase === "build");
  }

  pickPlacement(point) {
    return [...(this.roomState?.placements || [])].reverse().find((placement) => {
      const dimensions = dimensionsForPiece(placement.type, placement.rotation);
      return Math.abs(point.x - placement.x) <= dimensions.width / 2 &&
        Math.abs(point.y - placement.y) <= dimensions.height / 2;
    });
  }

  setDebug(enabled) {
    if (enabled && !this.physics.world.debugGraphic) this.physics.world.createDebugGraphic();
    this.physics.world.drawDebug = enabled;
    this.physics.world.debugGraphic?.setVisible(enabled);
    if (!enabled) this.physics.world.debugGraphic?.clear();
  }

  drawEditor(spawn, selectedId) {
    const graphics = this.editorOverlay;
    if (!graphics) return;
    graphics.clear();
    if (this.roomState?.phase !== "build") return;
    graphics.lineStyle(3, 0xef624a, 0.95);
    graphics.strokeCircle(spawn.x, spawn.y, 24);
    graphics.lineBetween(spawn.x - 34, spawn.y, spawn.x + 34, spawn.y);
    graphics.lineBetween(spawn.x, spawn.y - 34, spawn.x, spawn.y + 34);
    const selected = this.roomState.placements.find((piece) => piece.id === selectedId);
    if (selected) {
      const dimensions = dimensionsForPiece(selected.type, selected.rotation);
      graphics.lineStyle(4, 0xf2c84a, 1);
      graphics.strokeRect(selected.x - dimensions.width / 2 - 6, selected.y - dimensions.height / 2 - 6,
        dimensions.width + 12, dimensions.height + 12);
    }
  }
}
