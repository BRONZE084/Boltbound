import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  GAME_AUDIO_ASSETS,
  audioAssetRelativePath,
} from "../shared/audioAssets.js";

const TWO_PI = Math.PI * 2;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const canonicalAssetRoot = join(projectRoot, "public", "assets");

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeSamples(durationSeconds) {
  return new Float64Array(Math.round(durationSeconds * AUDIO_SAMPLE_RATE));
}

function envelope(time, duration, attack = 0.006, release = 0.06, decay = 0) {
  const attackGain = attack > 0 ? smoothstep(time / attack) : 1;
  const releaseGain = release > 0 ? smoothstep((duration - time) / release) : 1;
  const decayGain = decay > 0 ? Math.exp((-decay * time) / duration) : 1;
  return attackGain * releaseGain * decayGain;
}

function addTone(samples, {
  start = 0,
  duration,
  frequency,
  endFrequency = frequency,
  amplitude,
  attack = 0.006,
  release = 0.06,
  decay = 0,
  harmonics = [[1, 1]],
  phaseOffset = 0,
}) {
  const startSample = Math.max(0, Math.round(start * AUDIO_SAMPLE_RATE));
  const sampleCount = Math.min(
    Math.round(duration * AUDIO_SAMPLE_RATE),
    samples.length - startSample,
  );
  let phase = phaseOffset;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / AUDIO_SAMPLE_RATE;
    const progress = sampleCount > 1 ? index / (sampleCount - 1) : 0;
    const currentFrequency = frequency + (endFrequency - frequency) * progress;
    phase += (TWO_PI * currentFrequency) / AUDIO_SAMPLE_RATE;
    let value = 0;
    for (const [multiple, strength] of harmonics) {
      value += Math.sin(phase * multiple) * strength;
    }
    samples[startSample + index] +=
      value * amplitude * envelope(time, duration, attack, release, decay);
  }
}

function addNoise(samples, {
  start = 0,
  duration,
  amplitude,
  attack = 0.001,
  release = 0.05,
  decay = 4,
  seed,
  color = 0,
}) {
  const random = seededRandom(seed);
  const startSample = Math.max(0, Math.round(start * AUDIO_SAMPLE_RATE));
  const sampleCount = Math.min(
    Math.round(duration * AUDIO_SAMPLE_RATE),
    samples.length - startSample,
  );
  let filtered = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / AUDIO_SAMPLE_RATE;
    const white = random() * 2 - 1;
    filtered += (white - filtered) * (1 - color);
    samples[startSample + index] +=
      filtered * amplitude * envelope(time, duration, attack, release, decay);
  }
}

function addKick(samples, start, amplitude = 0.45) {
  addTone(samples, {
    start,
    duration: 0.2,
    frequency: 118,
    endFrequency: 48,
    amplitude,
    attack: 0.001,
    release: 0.06,
    decay: 5,
    harmonics: [[1, 1], [2, 0.14]],
  });
}

function normalize(samples, targetPeak) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak === 0) throw new Error("Generated silent audio.");
  const scale = targetPeak / peak;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = clamp(samples[index] * scale, -0.98, 0.98);
  }
}

function synthesizeBackgroundMusic(asset) {
  const samples = makeSamples(asset.durationSeconds);
  const duration = asset.durationSeconds;
  const chordRoots = [65.406, 73.416, 82.407, 73.416];
  const chordRatios = [1, 1.25, 1.5, 2];

  // The two quiet drones complete an integer number of periods per loop.
  for (const baseFrequency of [98, 196]) {
    const periodicFrequency = Math.round(baseFrequency * duration) / duration;
    for (let index = 0; index < samples.length; index += 1) {
      const time = index / AUDIO_SAMPLE_RATE;
      const pulse = 0.78 + 0.22 * Math.sin((TWO_PI * 4 * time) / duration);
      samples[index] +=
        Math.sin(TWO_PI * periodicFrequency * time) * 0.035 * pulse;
    }
  }

  for (let step = 0; step < 32; step += 1) {
    const start = step * 0.5;
    const root = chordRoots[Math.floor(start / 4) % chordRoots.length];
    addTone(samples, {
      start,
      duration: 0.36,
      frequency: root,
      amplitude: 0.19,
      attack: 0.004,
      release: 0.08,
      decay: 2.4,
      harmonics: [[1, 1], [2, 0.24], [3, 0.1]],
    });
    addKick(samples, start, step % 4 === 0 ? 0.48 : 0.36);
    if (step % 4 === 1 || step % 4 === 3) {
      addNoise(samples, {
        start,
        duration: 0.13,
        amplitude: 0.12,
        release: 0.055,
        decay: 3,
        seed: 2_000 + step,
        color: 0.36,
      });
      addTone(samples, {
        start,
        duration: 0.11,
        frequency: 780,
        endFrequency: 610,
        amplitude: 0.055,
        attack: 0.001,
        release: 0.04,
        decay: 4,
      });
    }
  }

  for (let step = 0; step < 64; step += 1) {
    const start = step * 0.25;
    const root = chordRoots[Math.floor(start / 4) % chordRoots.length];
    const frequency = root * 4 * chordRatios[step % chordRatios.length];
    addTone(samples, {
      start,
      duration: 0.19,
      frequency,
      amplitude: step % 2 === 0 ? 0.095 : 0.07,
      attack: 0.003,
      release: 0.045,
      decay: 2.5,
      harmonics: [[1, 1], [2.01, 0.38], [3.98, 0.16]],
    });
    addNoise(samples, {
      start,
      duration: 0.045,
      amplitude: 0.026,
      release: 0.02,
      decay: 4,
      seed: 5_000 + step,
      color: 0.08,
    });
  }

  normalize(samples, 0.72);
  return samples;
}

function synthesizeSoundEffect(asset) {
  const samples = makeSamples(asset.durationSeconds);
  const add = (options) => addTone(samples, options);
  switch (asset.key) {
    case "ui_click":
      add({ duration: 0.065, frequency: 1_650, endFrequency: 1_180, amplitude: 0.5, release: 0.028, decay: 2 });
      break;
    case "draft":
      add({ duration: 0.13, frequency: 440, endFrequency: 700, amplitude: 0.35, release: 0.04, decay: 1.4, harmonics: [[1, 1], [2, 0.22]] });
      add({ start: 0.075, duration: 0.135, frequency: 660, endFrequency: 990, amplitude: 0.27, release: 0.04, decay: 1.6 });
      addNoise(samples, { duration: 0.1, amplitude: 0.075, release: 0.035, seed: 101, color: 0.18 });
      break;
    case "place":
      add({ duration: 0.16, frequency: 250, endFrequency: 170, amplitude: 0.4, release: 0.06, decay: 2.4, harmonics: [[1, 1], [2.7, 0.3]] });
      addNoise(samples, { duration: 0.105, amplitude: 0.15, release: 0.05, seed: 102, color: 0.72 });
      break;
    case "jump":
      add({ duration: 0.2, frequency: 360, endFrequency: 760, amplitude: 0.45, release: 0.05, decay: 0.7, harmonics: [[1, 1], [2, 0.12]] });
      break;
    case "double_jump":
      add({ duration: 0.245, frequency: 480, endFrequency: 1_080, amplitude: 0.44, release: 0.055, decay: 0.65, harmonics: [[1, 1], [2, 0.18], [3, 0.07]] });
      add({ start: 0.055, duration: 0.15, frequency: 980, endFrequency: 1_420, amplitude: 0.18, release: 0.045, decay: 1.3 });
      break;
    case "land":
      add({ duration: 0.15, frequency: 128, endFrequency: 62, amplitude: 0.55, release: 0.055, decay: 3.2 });
      addNoise(samples, { duration: 0.12, amplitude: 0.13, release: 0.05, seed: 103, color: 0.8 });
      break;
    case "countdown":
      add({ duration: 0.2, frequency: 660, amplitude: 0.48, attack: 0.003, release: 0.065, decay: 1.8, harmonics: [[1, 1], [2, 0.12]] });
      break;
    case "go":
      add({ duration: 0.42, frequency: 523.25, amplitude: 0.28, release: 0.12, decay: 0.8 });
      add({ duration: 0.42, frequency: 659.25, amplitude: 0.25, release: 0.12, decay: 0.8 });
      add({ start: 0.045, duration: 0.42, frequency: 783.99, amplitude: 0.3, release: 0.12, decay: 0.8 });
      break;
    case "item":
      for (const [index, frequency] of [880, 1_174.66, 1_568].entries()) {
        add({ start: index * 0.055, duration: 0.16, frequency, amplitude: 0.27, release: 0.055, decay: 1.7, harmonics: [[1, 1], [2, 0.18]] });
      }
      break;
    case "bomb":
      add({ duration: 0.62, frequency: 105, endFrequency: 34, amplitude: 0.6, release: 0.16, decay: 3.2, harmonics: [[1, 1], [2, 0.25], [3, 0.11]] });
      addNoise(samples, { duration: 0.64, amplitude: 0.5, attack: 0.001, release: 0.2, decay: 4.5, seed: 104, color: 0.7 });
      addNoise(samples, { start: 0.02, duration: 0.36, amplitude: 0.16, release: 0.12, decay: 3.5, seed: 105, color: 0.08 });
      break;
    case "portal":
      add({ duration: 0.5, frequency: 240, endFrequency: 1_440, amplitude: 0.33, release: 0.1, decay: 0.45, harmonics: [[1, 1], [2.02, 0.22]] });
      add({ start: 0.08, duration: 0.4, frequency: 1_180, endFrequency: 420, amplitude: 0.2, release: 0.09, decay: 0.6 });
      break;
    case "death":
      add({ duration: 0.7, frequency: 510, endFrequency: 82, amplitude: 0.48, release: 0.14, decay: 0.9, harmonics: [[1, 1], [2, 0.17]] });
      addNoise(samples, { start: 0.38, duration: 0.3, amplitude: 0.12, release: 0.11, decay: 2.8, seed: 106, color: 0.76 });
      break;
    case "finish": {
      const notes = [523.25, 659.25, 783.99, 1_046.5];
      for (const [index, frequency] of notes.entries()) {
        add({ start: index * 0.18, duration: 0.48, frequency, amplitude: 0.28, release: 0.16, decay: 0.8, harmonics: [[1, 1], [2, 0.14]] });
      }
      add({ start: 0.72, duration: 0.48, frequency: 1_318.5, amplitude: 0.22, release: 0.18, decay: 0.7 });
      break;
    }
    default:
      throw new Error(`No synthesizer for audio key: ${asset.key}`);
  }
  normalize(samples, 0.82);
  return samples;
}

function encodePcmWave(samples) {
  const bytesPerSample = AUDIO_BITS_PER_SAMPLE / 8;
  const dataSize = samples.length * AUDIO_CHANNELS * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(AUDIO_CHANNELS, 22);
  buffer.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * bytesPerSample, 28);
  buffer.writeUInt16LE(AUDIO_CHANNELS * bytesPerSample, 32);
  buffer.writeUInt16LE(AUDIO_BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const pcm = Math.round(clamp(samples[index], -1, 1) * 32_767);
    buffer.writeInt16LE(pcm, 44 + index * bytesPerSample);
  }
  return buffer;
}

export function createAudioAssetBuffer(asset) {
  const samples = asset.category === "music"
    ? synthesizeBackgroundMusic(asset)
    : synthesizeSoundEffect(asset);
  return encodePcmWave(samples);
}

export function validateWaveBuffer(buffer, asset) {
  if (buffer.length < 46 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`${asset.fileBase}: missing RIFF header`);
  }
  if (buffer.toString("ascii", 8, 12) !== "WAVE" || buffer.toString("ascii", 12, 16) !== "fmt ") {
    throw new Error(`${asset.fileBase}: unsupported WAV layout`);
  }
  const format = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataTag = buffer.toString("ascii", 36, 40);
  const dataSize = buffer.readUInt32LE(40);
  const expectedSamples = Math.round(asset.durationSeconds * AUDIO_SAMPLE_RATE);
  const expectedDataSize = expectedSamples * AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8);
  if (format !== 1 || channels !== AUDIO_CHANNELS || sampleRate !== AUDIO_SAMPLE_RATE) {
    throw new Error(`${asset.fileBase}: expected PCM ${AUDIO_SAMPLE_RATE} Hz mono`);
  }
  if (bitsPerSample !== AUDIO_BITS_PER_SAMPLE || dataTag !== "data") {
    throw new Error(`${asset.fileBase}: expected ${AUDIO_BITS_PER_SAMPLE}-bit PCM data`);
  }
  if (dataSize !== expectedDataSize || buffer.length !== 44 + dataSize) {
    throw new Error(`${asset.fileBase}: unexpected duration or truncated PCM data`);
  }

  let peak = 0;
  for (let offset = 44; offset < buffer.length; offset += 2) {
    peak = Math.max(peak, Math.abs(buffer.readInt16LE(offset)) / 32_768);
  }
  if (peak < 0.1 || peak > 0.99) {
    throw new Error(`${asset.fileBase}: invalid normalized peak ${peak.toFixed(4)}`);
  }

  let seamDelta = null;
  if (asset.loop) {
    const first = buffer.readInt16LE(44) / 32_768;
    const last = buffer.readInt16LE(buffer.length - 2) / 32_768;
    seamDelta = Math.abs(first - last);
    if (seamDelta > 0.03) {
      throw new Error(`${asset.fileBase}: loop seam delta ${seamDelta.toFixed(5)} is too large`);
    }
  }
  return {
    durationSeconds: expectedSamples / AUDIO_SAMPLE_RATE,
    peak,
    seamDelta,
  };
}

export function generateCanonicalAudioAssets({ verifyOnly = false } = {}) {
  let totalBytes = 0;
  const results = [];
  for (const asset of GAME_AUDIO_ASSETS) {
    const expected = createAudioAssetBuffer(asset);
    const stats = validateWaveBuffer(expected, asset);
    const output = join(canonicalAssetRoot, audioAssetRelativePath(asset));
    const matches = existsSync(output) && readFileSync(output).equals(expected);
    if (!matches && verifyOnly) {
      throw new Error(`${audioAssetRelativePath(asset)} is missing or not reproducible`);
    }
    if (!matches) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, expected);
    }
    totalBytes += expected.length;
    results.push({ asset, output, bytes: expected.length, ...stats });
  }
  return { totalBytes, results };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const verifyOnly = args.has("--verify");
  for (const arg of args) {
    if (arg !== "--verify") throw new Error(`Unknown argument: ${arg}`);
  }
  const { totalBytes, results } = generateCanonicalAudioAssets({ verifyOnly });
  for (const result of results) {
    const loopInfo = result.asset.loop ? `, seam=${result.seamDelta.toFixed(5)}` : "";
    console.log(
      `[audio] ${verifyOnly ? "verified" : "ready"} ${audioAssetRelativePath(result.asset)} ` +
      `(${result.durationSeconds.toFixed(3)}s, ${result.bytes} bytes${loopInfo})`,
    );
  }
  console.log(`[audio] ${results.length} files, ${totalBytes} bytes total`);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`[audio] ${error.message}`);
    process.exitCode = 1;
  });
}
