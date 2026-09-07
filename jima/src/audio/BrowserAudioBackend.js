function clampUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function defaultCreateAudio() {
  if (typeof globalThis.Audio !== "function") return null;
  return new globalThis.Audio();
}

function pauseAudio(audio) {
  try {
    audio?.pause?.();
  } catch {
    // Audio failures must never interrupt gameplay.
  }
}

function rewindAudio(audio) {
  try {
    if (audio) audio.currentTime = 0;
  } catch {
    // Some media elements reject seeks before metadata is available.
  }
}

function startAudio(audio, onFailure) {
  if (!audio?.play) return false;
  try {
    const result = audio.play();
    result?.catch?.(() => onFailure?.());
    return true;
  } catch {
    onFailure?.();
    return false;
  }
}

export class BrowserAudioBackend {
  constructor({ createAudio = defaultCreateAudio, effectPoolSize = 8 } = {}) {
    this.createAudio = createAudio;
    this.effectPoolSize = Math.max(1, Math.floor(Number(effectPoolSize) || 8));
    this.music = null;
    this.musicSource = null;
    this.musicVolume = 1;
    this.effectsVolume = 1;
    this.effectPool = [];
    this.nextEffectIndex = 0;
    this.destroyed = false;
  }

  unlock() {
    if (this.destroyed) return false;
    if (this.music && this.musicSource && this.music.paused === true) {
      return startAudio(this.music);
    }
    return true;
  }

  setMusicVolume(value) {
    this.musicVolume = clampUnit(value);
    if (this.music) this.music.volume = this.musicVolume;
  }

  setEffectsVolume(value) {
    this.effectsVolume = clampUnit(value);
    for (const slot of this.effectPool) slot.audio.volume = this.effectsVolume;
  }

  playMusic(source, volume = this.musicVolume) {
    if (this.destroyed || !source) return false;
    this.setMusicVolume(volume);
    if (!this.music) {
      this.music = this.createAudio?.() || null;
      if (!this.music) return false;
      this.music.preload = "auto";
      this.music.loop = true;
      this.music.playsInline = true;
    }
    if (this.musicSource !== source) {
      pauseAudio(this.music);
      rewindAudio(this.music);
      this.musicSource = source;
      this.music.src = source;
    }
    this.music.loop = true;
    this.music.volume = this.musicVolume;
    return startAudio(this.music);
  }

  pauseMusic() {
    pauseAudio(this.music);
  }

  resumeMusic() {
    if (this.destroyed || !this.music || !this.musicSource) return false;
    this.music.volume = this.musicVolume;
    return startAudio(this.music);
  }

  stopMusic() {
    pauseAudio(this.music);
    rewindAudio(this.music);
    this.musicSource = null;
  }

  playEffect(source, volume = this.effectsVolume) {
    if (this.destroyed || !source) return false;
    this.setEffectsVolume(volume);
    const slot = this.#effectSlot();
    if (!slot) return false;
    pauseAudio(slot.audio);
    rewindAudio(slot.audio);
    slot.source = source;
    slot.busy = true;
    slot.audio.src = source;
    slot.audio.loop = false;
    slot.audio.volume = this.effectsVolume;
    return startAudio(slot.audio, () => {
      slot.busy = false;
    });
  }

  suspend() {
    this.pauseMusic();
    for (const slot of this.effectPool) {
      pauseAudio(slot.audio);
      rewindAudio(slot.audio);
      slot.busy = false;
    }
  }

  resume() {
    return !this.destroyed;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopMusic();
    for (const slot of this.effectPool) {
      pauseAudio(slot.audio);
      rewindAudio(slot.audio);
      slot.busy = false;
      try {
        slot.audio.removeAttribute?.("src");
      } catch {
        // Best-effort media cleanup.
      }
    }
    if (this.music) {
      try {
        this.music.removeAttribute?.("src");
      } catch {
        // Best-effort media cleanup.
      }
    }
    this.effectPool = [];
    this.music = null;
    this.musicSource = null;
  }

  #effectSlot() {
    let slot = this.effectPool.find((candidate) =>
      !candidate.busy || candidate.audio.paused === true || candidate.audio.ended === true);
    if (!slot && this.effectPool.length < this.effectPoolSize) {
      const audio = this.createAudio?.() || null;
      if (!audio) return null;
      audio.preload = "auto";
      audio.playsInline = true;
      slot = { audio, busy: false, source: null };
      const release = () => {
        slot.busy = false;
      };
      audio.addEventListener?.("ended", release);
      audio.addEventListener?.("error", release);
      this.effectPool.push(slot);
    }
    if (!slot) {
      slot = this.effectPool[this.nextEffectIndex % this.effectPool.length];
      this.nextEffectIndex = (this.nextEffectIndex + 1) % this.effectPool.length;
    }
    return slot;
  }
}
