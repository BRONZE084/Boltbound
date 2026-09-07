import {
  AUDIO_ASSET_BY_KEY,
  GAME_AUDIO_ASSETS,
  audioAssetRelativePath,
} from "../../shared/audioAssets.js";
import {
  DEFAULT_AUDIO_SETTINGS,
  normalizeAudioSettings,
} from "../../shared/audioSettings.js";

const DEFAULT_MUSIC_KEY = GAME_AUDIO_ASSETS.find((asset) => asset.category === "music")?.key || null;

function defaultAssetUrl(asset, platform) {
  const relative = audioAssetRelativePath(asset);
  return platform === "wechat" ? `assets/${relative}` : `/assets/${relative}`;
}

function suspensionKey(reason) {
  const value = String(reason || "manual").trim();
  return value || "manual";
}

export class GameAudio {
  constructor({
    backend,
    platform = "browser",
    resolveAssetUrl = (asset) => defaultAssetUrl(asset, platform),
    initialSettings = DEFAULT_AUDIO_SETTINGS,
    maxDedupeEntries = 256,
  } = {}) {
    this.backend = backend || {};
    this.resolveAssetUrl = resolveAssetUrl;
    this.settings = normalizeAudioSettings(initialSettings);
    this.maxDedupeEntries = Math.max(16, Math.floor(Number(maxDedupeEntries) || 256));
    this.desiredMusicKey = DEFAULT_MUSIC_KEY;
    this.activeMusicKey = null;
    this.musicPaused = false;
    this.unlocked = false;
    this.destroyed = false;
    this.suspensions = new Set();
    this.seenEvents = new Map();
    this.dedupeSequence = 0;
    this.observedCountdowns = new Set();
    this.previousRacePhase = null;
    this.previousRaceKey = null;
    this.#applyBackendVolumes();
  }

  setSettings(value = {}) {
    if (this.destroyed) return { ...this.settings };
    const previous = this.settings;
    this.settings = normalizeAudioSettings({ ...previous, ...value });
    this.#applyBackendVolumes();
    if (!this.settings.musicEnabled) {
      this.backend.stopMusic?.();
      this.activeMusicKey = null;
      this.musicPaused = false;
    } else {
      this.#syncMusic();
    }
    return { ...this.settings };
  }

  setGameState(state = null, now = Date.now()) {
    if (this.destroyed) return null;
    this.#syncRaceCues(state, now);
    let nextMusicKey = DEFAULT_MUSIC_KEY;
    if (state && Object.prototype.hasOwnProperty.call(state, "musicKey")) {
      nextMusicKey = state.musicKey === false || state.musicKey === null
        ? null
        : String(state.musicKey || "");
    }
    if (!AUDIO_ASSET_BY_KEY[nextMusicKey]?.category?.includes("music")) {
      nextMusicKey = nextMusicKey ? DEFAULT_MUSIC_KEY : null;
    }
    if (nextMusicKey !== this.desiredMusicKey) {
      this.desiredMusicKey = nextMusicKey;
      if (this.activeMusicKey && this.activeMusicKey !== nextMusicKey) {
        this.backend.stopMusic?.();
        this.activeMusicKey = null;
        this.musicPaused = false;
      }
    }
    this.#syncMusic();
    return this.desiredMusicKey;
  }

  unlock() {
    if (this.destroyed) return false;
    let backendReady = true;
    try {
      backendReady = this.backend.unlock?.() !== false;
    } catch {
      backendReady = false;
    }
    if (!backendReady) return false;
    this.unlocked = true;
    this.#syncMusic();
    return true;
  }

  play(key, options = {}) {
    const asset = AUDIO_ASSET_BY_KEY[String(key || "")];
    if (!asset || asset.category !== "sfx" || this.destroyed) return false;
    const normalizedOptions = typeof options === "string" ? { dedupeKey: options } : options || {};
    const dedupeKey = normalizedOptions.dedupeKey === undefined || normalizedOptions.dedupeKey === null
      ? null
      : `${asset.key}:${String(normalizedOptions.dedupeKey)}`;
    if (dedupeKey && this.seenEvents.has(dedupeKey)) return false;
    if (dedupeKey) this.#rememberEvent(dedupeKey);
    if (!this.unlocked || this.suspensions.size || !this.settings.effectsEnabled) return false;
    const source = this.#assetUrl(asset);
    if (!source) return false;
    try {
      return this.backend.playEffect?.(source, this.settings.effectsVolume) !== false;
    } catch {
      return false;
    }
  }

  suspend(reason = "manual") {
    if (this.destroyed) return false;
    const wasActive = this.suspensions.size > 0;
    this.suspensions.add(suspensionKey(reason));
    if (!wasActive) {
      try {
        this.backend.suspend?.();
      } catch {
        // Lifecycle audio failures are intentionally silent.
      }
      this.musicPaused = Boolean(this.activeMusicKey);
    }
    return true;
  }

  resume(reason = "manual") {
    if (this.destroyed) return false;
    this.suspensions.delete(suspensionKey(reason));
    if (this.suspensions.size) return false;
    try {
      this.backend.resume?.();
    } catch {
      // The next user gesture may retry playback.
    }
    return this.#syncMusic();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unlocked = false;
    this.suspensions.clear();
    this.seenEvents.clear();
    this.observedCountdowns.clear();
    this.previousRacePhase = null;
    this.previousRaceKey = null;
    this.activeMusicKey = null;
    this.desiredMusicKey = null;
    this.musicPaused = false;
    try {
      this.backend.destroy?.();
    } catch {
      // Best-effort teardown.
    }
  }

  #syncRaceCues(state, now) {
    const phase = String(state?.phase || "");
    const hasRound = state?.round !== undefined && state?.round !== null;
    const round = hasRound ? String(state.round) : null;
    const countdownAt = Number(state?.race?.countdownAt ?? state?.countdownAt);
    const raceKey = round === null
      ? null
      : `${round}:${Number.isFinite(countdownAt) ? countdownAt : "unknown"}`;

    if (phase === "race_countdown" && raceKey) {
      this.observedCountdowns.add(raceKey);
      while (this.observedCountdowns.size > 16) {
        this.observedCountdowns.delete(this.observedCountdowns.values().next().value);
      }
      const currentTime = Number(now);
      if (Number.isFinite(countdownAt) && Number.isFinite(currentTime)) {
        const remaining = countdownAt - currentTime;
        if (remaining > 0) {
          const seconds = Math.max(1, Math.min(3, Math.ceil(remaining / 1_000)));
          this.play("countdown", {
            dedupeKey: `${raceKey}:countdown:${seconds}`,
          });
        }
      }
    } else if (
      phase === "race" &&
      raceKey &&
      this.observedCountdowns.has(raceKey) &&
      (this.previousRacePhase !== "race" || this.previousRaceKey !== raceKey)
    ) {
      this.play("go", { dedupeKey: `${raceKey}:go` });
    }

    this.previousRacePhase = phase || null;
    this.previousRaceKey = raceKey;
  }
  #applyBackendVolumes() {


    try {
      this.backend.setMusicVolume?.(this.settings.musicEnabled ? this.settings.musicVolume : 0);
      this.backend.setEffectsVolume?.(this.settings.effectsEnabled ? this.settings.effectsVolume : 0);
    } catch {
      // Invalid or unavailable platform audio must degrade silently.
    }
  }

  #assetUrl(asset) {
    try {
      return String(this.resolveAssetUrl?.(asset) || "");
    } catch {
      return "";
    }
  }

  #syncMusic() {
    if (
      this.destroyed ||
      !this.unlocked ||
      this.suspensions.size ||
      !this.settings.musicEnabled ||
      !this.desiredMusicKey
    ) return false;
    const asset = AUDIO_ASSET_BY_KEY[this.desiredMusicKey];
    if (!asset || asset.category !== "music") return false;
    if (this.activeMusicKey === this.desiredMusicKey) {
      if (!this.musicPaused) return true;
      try {
        const resumed = this.backend.resumeMusic?.() !== false;
        if (resumed) this.musicPaused = false;
        return resumed;
      } catch {
        return false;
      }
    }
    const source = this.#assetUrl(asset);
    if (!source) return false;
    try {
      const started = this.backend.playMusic?.(source, this.settings.musicVolume) !== false;
      if (started) {
        this.activeMusicKey = this.desiredMusicKey;
        this.musicPaused = false;
      }
      return started;
    } catch {
      return false;
    }
  }

  #rememberEvent(key) {
    this.dedupeSequence += 1;
    this.seenEvents.set(key, this.dedupeSequence);
    while (this.seenEvents.size > this.maxDedupeEntries) {
      const oldest = this.seenEvents.keys().next().value;
      this.seenEvents.delete(oldest);
    }
  }
}
