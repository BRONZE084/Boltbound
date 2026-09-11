import { ACTIVE_ITEMS, PIECES } from "../../shared/gameConfig.js";
import { GAME_ASSETS } from "../../shared/gameAssets.js";

// Explanations of the existing scene behavior, not a second set of game parameters.
const PIECE_NOTES = {
  beam: ["搭建", "静态平台，用来接路、承托角色或改变落点。", "与搭建类零件贴边拼接或叠放，也可旋转成竖墙测试蹬墙。"],
  crate: ["搭建", "静态方箱，提供落脚点并阻挡角色。", "将方箱贴在横梁上，或继续叠放方箱和冰面，测试跳跃高度。"],
  spring: ["动力", "从有效接触面沿旋转朝向弹射角色。", "从弹簧正面和侧面分别接近，比较触发方向。"],
  spikes: ["陷阱", "接触危险区域后角色死亡。", "测试跳跃避让与落点；防护盾不能抵挡机关伤害。"],
  fan: ["动力", "在朝向范围内持续吹动角色，风力随距离衰减。", "旋转风机，比较迎风、顺风和空中的运动。"],
  barrier: ["搭建", "在独立运动层往返移动，可穿过其他零件，仍与角色碰撞。", "在路障轨迹上放置方箱，观察它从方箱后方穿行；旋转后可测试上下运动。"],
  blackhole: ["陷阱", "范围内吸引角色，进入核心区域后死亡。", "从不同方向靠近，试试跳跃、风机与吸引力的组合。"],
  portal: ["传送", "按放置顺序两两配对，出口方向由旋转决定；单门沿自身朝向传送。", "先测试单门，再放第二扇测试配对；删除或炸毁配对门会同时移除另一扇。"],
  conveyor: ["动力", "接触带面后沿传送带方向推动角色。", "比较顺向行走、逆向行走与松开方向键后的运动。"],
  ice: ["搭建", "降低水平阻力与加速度，使角色更容易滑行。", "松开方向键观察滑行，再使用强力抓地比较。"],
  saw: ["陷阱", "刀刃的圆形危险区域会杀死角色。", "从边缘接近，比较图案边界与实际接触范围。"],
  cannon: ["陷阱", "周期预警后发射炮弹，沿朝向攻击角色。", "改变方向与距离，观察预警、弹速和躲避窗口。"],
  laser: ["陷阱", "周期预警后短暂激活射线，命中角色后致死。", "对比预警和激活时段，练习穿越射线。"],
  bumper: ["动力", "角色进入触发范围时，从中心向外弹射。", "从上方、侧面和斜方向接近，观察弹射轨迹。"],
};

const ITEM_TIPS = {
  turbo: "比较使用前后的地面加速和移动速度。",
  jumpjet: "增强跳跃与蹬墙力度，不增加跳跃次数。",
  shield: "清除并阻挡对手的负面道具；不能抵挡尖刺、电锯、激光、黑洞或坠落。",
  grip: "先铺冰面，对比普通移动与抓地效果。",
  slow: "选择「当前角色受击」，亲自体验移动速度和加速度降低。",
  gravity: "选择「当前角色受击」，比较跳跃高度和下落速度。",
  reverse: "选择「当前角色受击」，测试左右键反转。",
  fog: "选择「当前角色受击」，观察远处视野被遮挡。",
  bomb: "只移除爆炸范围内玩家搭建的零件，基础平台保留；重置实验可恢复搭建方案。",
};

const PARAMETER_LABELS = {
  width: "宽度", height: "高度", durationMs: "持续时间", cooldownMs: "使用冷却",
  effectRange: "作用距离", effectWidth: "作用宽度", force: "作用力", travelRange: "单侧行程",
  periodMs: "周期", effectRadius: "吸引半径", coreRadius: "致死半径", triggerRadius: "触发半径",
  exitOffset: "出口偏移", soloDistance: "单门传送距离", exitSpeed: "出口速度",
  speed: "速度", acceleration: "加速度", contactGraceMs: "接触宽限", dragX: "水平阻力",
  bladeRadius: "刀刃半径", spinPeriodMs: "旋转周期", range: "射程", projectileSpeed: "弹速",
  projectileRadius: "炮弹半径", warningMs: "预警时间", muzzleOffset: "发射点偏移",
  beamWidth: "射线宽度", activeMs: "激活时间", launchSpeed: "弹射速度",
  boostGraceMs: "速度宽限", radius: "爆炸半径",
};

export const CATALOG = Object.entries({ ...PIECES, ...ACTIVE_ITEMS }).map(([type, config]) => {
  const placeable = Object.hasOwn(PIECES, type);
  const asset = GAME_ASSETS.find((entry) => entry.pieceType === type || entry.activeItemType === type);
  const notes = PIECE_NOTES[type];
  return {
    type, config, placeable, label: config.label,
    category: placeable ? notes?.[0] || "搭建" : config.kind === "target_debuff" ? "干扰" : "主动",
    description: config.description || notes?.[1] || "使用原版场景中的交互逻辑。",
    tip: placeable ? notes?.[2] || "进入实验场观察实际效果。" : ITEM_TIPS[type] || config.description,
    icon: asset ? `/assets/${asset.fileBase}.svg` : "/favicon.svg",
    parameters: Object.entries(config).filter(([, value]) => typeof value === "number").map(([key, value]) => ({
      label: PARAMETER_LABELS[key] || key,
      value: key.endsWith("Ms") ? `${value / 1000} 秒` : String(value),
    })),
  };
});

export const CATALOG_BY_TYPE = Object.fromEntries(CATALOG.map((entry) => [entry.type, entry]));
