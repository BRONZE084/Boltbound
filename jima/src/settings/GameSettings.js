import { DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from "../../shared/audioSettings.js";

export const GAME_SETTINGS_STORAGE_KEY = "boltbound.settings.v1";

export const QUALITY_PROFILES = Object.freeze({
  performance: Object.freeze({ key: "performance", width: 1200, height: 675, zoom: 0.75 }),
  balanced: Object.freeze({ key: "balanced", width: 1600, height: 900, zoom: 1 }),
  clear: Object.freeze({ key: "clear", width: 2000, height: 1125, zoom: 1.25 }),
});

export const DEFAULT_GAME_SETTINGS = Object.freeze({
  ...DEFAULT_AUDIO_SETTINGS,
  voiceVolume: 0.8,
  micEnabled: false,
  speakerEnabled: true,
  quality: "balanced",
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeGameSettings(value = {}) {
  const audio = normalizeAudioSettings(value);
  const voiceVolume = Number(value?.voiceVolume);
  const quality = String(value?.quality || "");
  return {
    ...audio,
    voiceVolume: Number.isFinite(voiceVolume)
      ? clamp(voiceVolume, 0, 1)
      : DEFAULT_GAME_SETTINGS.voiceVolume,
    micEnabled: value?.micEnabled === true,
    speakerEnabled: value?.speakerEnabled !== false,
    quality: QUALITY_PROFILES[quality] ? quality : DEFAULT_GAME_SETTINGS.quality,
  };
}

export function loadGameSettings(storage = globalThis.localStorage) {
  if (!storage?.getItem) return { ...DEFAULT_GAME_SETTINGS };
  try {
    const stored = JSON.parse(storage.getItem(GAME_SETTINGS_STORAGE_KEY) || "null");
    return { ...normalizeGameSettings(stored || {}), micEnabled: false };
  } catch {
    return { ...DEFAULT_GAME_SETTINGS };
  }
}

export function saveGameSettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeGameSettings(settings);
  try {
    storage?.setItem?.(GAME_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Settings remain usable for this tab when storage is unavailable.
  }
  return normalized;
}

export function qualityProfileFor(value) {
  const key = typeof value === "string" ? value : value?.quality;
  return QUALITY_PROFILES[key] || QUALITY_PROFILES[DEFAULT_GAME_SETTINGS.quality];
}
