import { DEBUFF_IMMUNITY_MS } from "./gameConfig.js";

const SERVER_ERROR_REASON = Object.freeze({
  target_unavailable: "unavailable",
  target_shielded: "shielded",
  target_debuff_active: "debuff_active",
  target_immune: "immune",
});

const REASON_LABELS = Object.freeze({
  available: "可使用",
  finished: "已到终点",
  dead: "已出局",
  disconnected: "已离线",
  not_racing: "尚未起跑",
  shielded: "护盾生效中",
  debuff_active: "已有负面效果",
  immune: "短暂无敌",
  unavailable: "当前不可用",
});

function finiteTime(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stateReason(player, effects, now) {
  const status = String(player?.status || "");
  if (status === "finished") return { reasonCode: "finished", remainingMs: 0 };
  if (status === "dead" || status === "death") return { reasonCode: "dead", remainingMs: 0 };
  if (status === "disconnected" || (!player?.bot && player?.connected === false)) {
    return { reasonCode: "disconnected", remainingMs: 0 };
  }
  if (status !== "racing") return { reasonCode: "not_racing", remainingMs: 0 };

  const selfEffect = effects?.self;
  if (selfEffect?.type === "shield" && finiteTime(selfEffect.endsAt) > now) {
    return { reasonCode: "shielded", remainingMs: finiteTime(selfEffect.endsAt) - now };
  }

  const debuff = effects?.debuff;
  const debuffEndsAt = finiteTime(debuff?.endsAt);
  if (debuff && debuffEndsAt > now) {
    return { reasonCode: "debuff_active", remainingMs: debuffEndsAt - now };
  }

  const immunityUntil = Math.max(
    finiteTime(effects?.immunityUntil),
    debuffEndsAt > 0 ? debuffEndsAt + DEBUFF_IMMUNITY_MS : 0,
  );
  if (immunityUntil > now) {
    return { reasonCode: "immune", remainingMs: immunityUntil - now };
  }
  return { reasonCode: "available", remainingMs: 0 };
}

function reasonLabel(reasonCode, remainingMs) {
  if (reasonCode === "immune" && remainingMs > 0) {
    return `${REASON_LABELS.immune} ${Math.max(1, Math.ceil(remainingMs / 1_000))}s`;
  }
  return REASON_LABELS[reasonCode] || REASON_LABELS.unavailable;
}

export function isTargetSelectionError(errorCode) {
  return Boolean(SERVER_ERROR_REASON[String(errorCode || "")]);
}

export function buildItemTargetOptions({
  players = [],
  selfPlayerId = "",
  effects = {},
  now = Date.now(),
  reasonOverrides = {},
} = {}) {
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const selfId = String(selfPlayerId || "");
  let visibleIndex = 0;
  return (Array.isArray(players) ? players : []).flatMap((player) => {
    const playerId = String(player?.id || "");
    if (!playerId || playerId === selfId) return [];

    const shortcut = visibleIndex < 4 ? String(visibleIndex + 1) : null;
    visibleIndex += 1;
    const state = stateReason(player, effects?.[playerId], safeNow);
    const overrideCode = SERVER_ERROR_REASON[String(reasonOverrides?.[playerId] || "")];
    const preserveDetailedUnavailable = overrideCode === "unavailable" && state.reasonCode !== "available";
    const reasonCode = overrideCode && !preserveDetailedUnavailable ? overrideCode : state.reasonCode;
    const remainingMs = reasonCode === state.reasonCode ? state.remainingMs : 0;
    return [Object.freeze({
      playerId,
      name: String(player?.name || "玩家"),
      styleIndex: Number.isInteger(Number(player?.styleIndex)) ? Number(player.styleIndex) : 0,
      status: String(player?.status || ""),
      shortcut,
      selectable: reasonCode === "available",
      reasonCode,
      reasonLabel: reasonLabel(reasonCode, remainingMs),
      remainingMs,
    })];
  });
}
