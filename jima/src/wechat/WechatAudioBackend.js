function clampUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function pauseContext(context) {
  try {
    context?.pause?.();
  } catch {
    // Audio failures must never interrupt gameplay.
  }
}

function stopContext(context) {
  try {
    context?.stop?.();
  } catch {
    // Audio failures must never interrupt gameplay.
  }
}

function playContext(context, onFailure) {
  if (!context?.play) return false;
  try {
    context.play();
    return true;
  } catch {
    onFailure?.();
    return false;
  }
}

export class WechatAudioBackend {
  constructor({ wxApi = globalThis.wx, effectPoolSize = 8 } = {}) {
    this.wxApi = wxApi;
    this.effectPoolSize = Math.max(1, Math.floor(Number(effectPoolSize) || 8));
    this.music = null;
    this.musicSource = null;
    this.musicVolume = 1;
    this.effectsVolume = 1;
    this.effectPool = [];
    this.nextEffectIndex = 0;
    this.destroyed = false;
    try {
      this.wxApi?.setInnerAudioOption?.({
        mixWithOther: false,
        obeyMuteSwitch: true,
        fail: () => {},
      });
    } catch {
      // Older runtimes may not expose global inner-audio options.
    }
  }

  unlock() {
    return !this.destroyed && typeof this.wxApi?.createInnerAudioContext === "function";
  }

  setMusicVolume(value) {
    this.musicVolume = clampUnit(value);
    if (this.music) this.music.volume = this.musicVolume;
  }

  setEffectsVolume(value) {
    this.effectsVolume = clampUnit(value);
    for (const slot of this.effectPool) slot.context.volume = this.effectsVolume;
  }

  playMusic(source, volume = this.musicVolume) {
    if (this.destroyed || !source) return false;
    this.setMusicVolume(volume);
    if (!this.music) {
      this.music = this.#createContext();
      if (!this.music) return false;
    }
    if (this.musicSource !== source) {
      stopContext(this.music);
      this.musicSource = source;
      this.music.src = source;
    }
    this.music.autoplay = false;
    this.music.loop = true;
    this.music.volume = this.musicVolume;
    return playContext(this.music);
  }

  pauseMusic() {
    pauseContext(this.music);
  }

  resumeMusic() {
    if (this.destroyed || !this.music || !this.musicSource) return false;
    this.music.volume = this.musicVolume;
    return playContext(this.music);
  }

  stopMusic() {
    stopContext(this.music);
    this.musicSource = null;
  }

  playEffect(source, volume = this.effectsVolume) {
    if (this.destroyed || !source) return false;
    this.setEffectsVolume(volume);
    const slot = this.#effectSlot();
    if (!slot) return false;
    stopContext(slot.context);
    slot.source = source;
    slot.busy = true;
    slot.context.src = source;
    slot.context.autoplay = false;
    slot.context.loop = false;
    slot.context.volume = this.effectsVolume;
    return playContext(slot.context, () => {
      slot.busy = false;
    });
  }

  suspend() {
    this.pauseMusic();
    for (const slot of this.effectPool) {
      stopContext(slot.context);
      slot.busy = false;
    }
  }

  resume() {
    return !this.destroyed;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    stopContext(this.music);
    try {
      this.music?.destroy?.();
    } catch {
      // Best-effort native cleanup.
    }
    for (const slot of this.effectPool) {
      stopContext(slot.context);
      try {
        slot.context.destroy?.();
      } catch {
        // Best-effort native cleanup.
      }
      slot.busy = false;
    }
    this.effectPool = [];
    this.music = null;
    this.musicSource = null;
  }

  #createContext() {
    if (typeof this.wxApi?.createInnerAudioContext !== "function") return null;
    try {
      const context = this.wxApi.createInnerAudioContext();
      context.autoplay = false;
      context.obeyMuteSwitch = true;
      return context;
    } catch {
      return null;
    }
  }

  #effectSlot() {
    let slot = this.effectPool.find((candidate) => !candidate.busy);
    if (!slot && this.effectPool.length < this.effectPoolSize) {
      const context = this.#createContext();
      if (!context) return null;
      slot = { context, busy: false, source: null };
      const release = () => {
        slot.busy = false;
      };
      context.onEnded?.(release);
      context.onError?.(release);
      this.effectPool.push(slot);
    }
    if (!slot) {
      slot = this.effectPool[this.nextEffectIndex % this.effectPool.length];
      this.nextEffectIndex = (this.nextEffectIndex + 1) % this.effectPool.length;
    }
    return slot;
  }
}
