export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  musicEnabled: true,
  musicVolume: 0.45,
  effectsEnabled: true,
  effectsVolume: 0.75,
});

function clampUnit(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

export function normalizeAudioSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    musicEnabled: source.musicEnabled !== false,
    musicVolume: clampUnit(source.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume),
    effectsEnabled: source.effectsEnabled !== false,
    effectsVolume: clampUnit(source.effectsVolume, DEFAULT_AUDIO_SETTINGS.effectsVolume),
  };
}
