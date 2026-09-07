import { VIEWPORT } from "../../shared/gameConfig.js";
import { DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from "../../shared/audioSettings.js";

export const WECHAT_SETTINGS_STORAGE_KEY = "settingsV1";

export const WECHAT_QUALITY_PROFILES = Object.freeze({
  performance: Object.freeze({ key: "performance", width: 960, height: 540, scale: 0.6 }),
  balanced: Object.freeze({ key: "balanced", width: 1_280, height: 720, scale: 0.8 }),
  clear: Object.freeze({ key: "clear", width: 1_600, height: 900, scale: 1 }),
});

export const DEFAULT_WECHAT_SETTINGS = Object.freeze({
  version: 1,
  quality: "balanced",
  ...DEFAULT_AUDIO_SETTINGS,
  micEnabled: false,
  speakerEnabled: true,
});

function settingsObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeWechatSettings(value) {
  const source = settingsObject(value);
  const audio = normalizeAudioSettings(source);
  return {
    version: 1,
    quality: WECHAT_QUALITY_PROFILES[source.quality] ? source.quality : DEFAULT_WECHAT_SETTINGS.quality,
    micEnabled: source.micEnabled === true,
    speakerEnabled: source.speakerEnabled !== false,
    ...audio,
  };
}

export function loadWechatRuntimeSettings(value) {
  return {
    ...normalizeWechatSettings(value),
    // Microphone permission and capture must always start from an explicit user gesture.
    micEnabled: false,
  };
}

export function planWechatSettingsVoiceGesture({
  kind,
  hasSession = false,
  joined = false,
  micMuted = true,
  speakerMuted = false,
  micEnabled = false,
  speakerEnabled = true,
} = {}) {
  const normalizedKind = kind === "mic" ? "mic" : "speaker";
  const preferenceEnabled = normalizedKind === "mic" ? micEnabled === true : speakerEnabled !== false;
  const currentEnabled = joined
    ? normalizedKind === "mic"
      ? !micMuted
      : !speakerMuted
    : preferenceEnabled;
  const joinWithEnabledPreference = Boolean(hasSession && !joined && currentEnabled);
  const desiredEnabled = joinWithEnabledPreference ? true : !currentEnabled;
  return {
    kind: normalizedKind,
    desiredEnabled,
    preferenceChanged: desiredEnabled !== preferenceEnabled,
    shouldRunVoiceAction: Boolean(hasSession && (joined || desiredEnabled)),
    joinRequested: Boolean(hasSession && !joined && desiredEnabled),
  };
}

export function getWechatRenderProfile(quality) {
  return WECHAT_QUALITY_PROFILES[quality] || WECHAT_QUALITY_PROFILES[DEFAULT_WECHAT_SETTINGS.quality];
}

export function applyRenderProfileToScene(scene, quality) {
  const profile = getWechatRenderProfile(quality);
  const camera = scene?.cameras?.main;
  if (!camera) return profile;
  camera.setViewport(0, 0, profile.width, profile.height);
  camera.setZoom(profile.scale);
  camera.setScroll(0, 0);
  return profile;
}

export function applyWechatRenderProfile({ game, scenes = [], quality } = {}) {
  const profile = getWechatRenderProfile(quality);
  const scale = game?.scale;
  if (
    scale?.setGameSize &&
    (Number(scale.width) !== profile.width || Number(scale.height) !== profile.height)
  ) {
    scale.setGameSize(profile.width, profile.height);
  }
  for (const scene of scenes) applyRenderProfileToScene(scene, profile.key);
  return {
    ...profile,
    logicalWidth: VIEWPORT.width,
    logicalHeight: VIEWPORT.height,
  };
}
