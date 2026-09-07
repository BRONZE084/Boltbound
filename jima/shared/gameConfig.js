export const VIEWPORT = Object.freeze({
  width: 1600,
  height: 900,
});

export const WORLD = Object.freeze({
  width: VIEWPORT.width,
  height: 900,
  groundY: 812,
  grid: 20,
});

export const GAME = Object.freeze({
  minPlayers: 2,
  maxPlayers: 4,
  maxRounds: 5,
  buildTurnMs: 25_000,
  raceMs: 45_000,
  raceCountdownMs: 2_500,
  resultsMs: 5_000,
  reconnectGraceMs: 120_000,
});

export const PLAYER_COLLISION_BOUNDS = Object.freeze({
  left: 20,
  right: 20,
  top: 29,
  bottom: 38,
});

export const PIECES = Object.freeze({
  beam: { width: 160, height: 40, label: "横梁", rotatable: true },
  crate: { width: 80, height: 80, label: "方箱", rotatable: true },
  spring: { width: 80, height: 40, label: "弹簧", rotatable: true },
  spikes: { width: 80, height: 40, label: "尖刺", rotatable: true },
  fan: { width: 80, height: 80, label: "\u98ce\u673a", rotatable: true, effectRange: 320, effectWidth: 160, force: 2_400 },
  barrier: { width: 160, height: 40, label: "\u79fb\u52a8\u8def\u969c", rotatable: true, travelRange: 120, periodMs: 2_800 },
  blackhole: { width: 100, height: 100, label: "\u9ed1\u6d1e", rotatable: true, effectRadius: 190, coreRadius: 34, force: 1_250 },
  portal: { width: 80, height: 120, label: "\u4f20\u9001\u95e8", rotatable: true, triggerRadius: 58, cooldownMs: 700, exitOffset: 88, soloDistance: 280, exitSpeed: 560 },
  conveyor: { width: 160, height: 40, label: "\u4f20\u9001\u5e26", rotatable: true, speed: 420, acceleration: 2_200, contactGraceMs: 90 },
  ice: { width: 160, height: 40, label: "\u51b0\u9762", rotatable: true, dragX: 45, acceleration: 620, contactGraceMs: 90 },
  saw: { width: 96, height: 96, label: "\u7535\u952f", rotatable: true, bladeRadius: 46, spinPeriodMs: 780 },
  cannon: { width: 100, height: 80, label: "\u70ae\u53f0", rotatable: true, range: 640, projectileSpeed: 640, projectileRadius: 14, periodMs: 2_600, warningMs: 500, muzzleOffset: 40 },
  laser: { width: 80, height: 120, label: "\u6fc0\u5149\u5668", rotatable: true, range: 680, beamWidth: 18, periodMs: 3_000, warningMs: 900, activeMs: 650, muzzleOffset: 60 },
  bumper: { width: 96, height: 96, label: "\u5f39\u529b\u4fdd\u9669\u6760", rotatable: true, triggerRadius: 78, launchSpeed: 780, boostGraceMs: 260 },
});

export const ACTIVE_ITEMS = Object.freeze({
  turbo: {
    kind: "self_buff",
    label: "\u6da1\u8f6e\u589e\u538b",
    durationMs: 7_000,
    cooldownMs: 750,
    description: "\u79fb\u52a8\u901f\u5ea6\u548c\u52a0\u901f\u5ea6\u63d0\u5347",
  },
  jumpjet: {
    kind: "self_buff",
    label: "\u8df3\u8dc3\u80cc\u5305",
    durationMs: 8_000,
    cooldownMs: 750,
    description: "\u8df3\u8dc3\u548c\u8e6c\u5899\u80fd\u529b\u63d0\u5347",
  },
  shield: {
    kind: "self_buff",
    label: "\u9632\u62a4\u76fe",
    durationMs: 3_500,
    cooldownMs: 750,
    description: "\u6e05\u9664\u5e76\u62b5\u6321\u654c\u65b9\u8d1f\u9762\u6548\u679c",
  },
  grip: {
    kind: "self_buff",
    label: "\u5f3a\u529b\u6293\u5730",
    durationMs: 9_000,
    cooldownMs: 750,
    description: "\u589e\u5f3a\u6293\u5730\u529b\u5e76\u514b\u5236\u51b0\u9762",
  },
  slow: {
    kind: "target_debuff",
    label: "\u51cf\u901f\u80f6",
    durationMs: 4_500,
    cooldownMs: 750,
    description: "\u8ba9\u6307\u5b9a\u73a9\u5bb6\u51cf\u901f",
  },
  gravity: {
    kind: "target_debuff",
    label: "\u91cd\u529b\u9524",
    durationMs: 4_500,
    cooldownMs: 750,
    description: "\u8ba9\u6307\u5b9a\u73a9\u5bb6\u53d8\u91cd",
  },
  reverse: {
    kind: "target_debuff",
    label: "\u53cd\u5411\u5668",
    durationMs: 3_500,
    cooldownMs: 750,
    description: "\u77ed\u6682\u5bf9\u8c03\u6307\u5b9a\u73a9\u5bb6\u7684\u5de6\u53f3\u64cd\u4f5c",
  },
  fog: {
    kind: "target_debuff",
    label: "\u70df\u96fe\u7f50",
    durationMs: 5_000,
    cooldownMs: 750,
    description: "\u906e\u6321\u6307\u5b9a\u73a9\u5bb6\u7684\u8fdc\u5904\u89c6\u91ce",
  },
  bomb: {
    kind: "self_instant",
    label: "\u7206\u7834\u70b8\u5f39",
    radius: 220,
    cooldownMs: 750,
    description: "\u70b8\u6bc1\u81ea\u8eab\u5468\u56f4\u7684\u73a9\u5bb6\u653e\u7f6e\u969c\u788d",
  },
});

export const DRAFT_ITEMS = Object.freeze({ ...PIECES, ...ACTIVE_ITEMS });
export const TARGET_SELECTION_MS = 6_000;
export const DEBUFF_IMMUNITY_MS = 1_500;

export function isActiveItem(type) {
  return Boolean(ACTIVE_ITEMS[type]);
}

export function isPlaceablePiece(type) {
  return Boolean(PIECES[type]);
}

export const PLAYER_STYLES = Object.freeze([
  { key: "runner-coral", color: "#ef624a", name: "珊瑚" },
  { key: "runner-teal", color: "#258a86", name: "青绿" },
  { key: "runner-yellow", color: "#e7b93f", name: "金黄" },
  { key: "runner-green", color: "#6ca747", name: "草绿" },
]);

export const BASE_PLATFORMS = Object.freeze([
  // Three compact platforms form a clean descent with a lethal void beneath them.
  { id: "start-upper-left", x: 170, y: 196, width: 300, height: 32 },
  { id: "middle-step", x: 760, y: 436, width: 340, height: 32 },
  { id: "final-step", x: 1_440, y: 676, width: 320, height: 32 },
]);

export const SPAWN = Object.freeze({ x: 80, y: 142 });
export const GOAL = Object.freeze({ x: 1510, y: 595, width: 90, height: 130 });
