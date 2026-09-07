function defineAudioAsset({ key, fileBase = key, category, loop = false, durationSeconds }) {
  return Object.freeze({ key, fileBase, category, loop, durationSeconds });
}

export const AUDIO_SAMPLE_RATE = 22_050;
export const AUDIO_CHANNELS = 1;
export const AUDIO_BITS_PER_SAMPLE = 16;

export const GAME_AUDIO_ASSETS = Object.freeze([
  defineAudioAsset({
    key: "bgm_main",
    fileBase: "bgm-industrial-run",
    category: "music",
    loop: true,
    durationSeconds: 16,
  }),
  defineAudioAsset({ key: "ui_click", category: "sfx", durationSeconds: 0.08 }),
  defineAudioAsset({ key: "draft", category: "sfx", durationSeconds: 0.22 }),
  defineAudioAsset({ key: "place", category: "sfx", durationSeconds: 0.18 }),
  defineAudioAsset({ key: "jump", category: "sfx", durationSeconds: 0.22 }),
  defineAudioAsset({ key: "double_jump", category: "sfx", durationSeconds: 0.28 }),
  defineAudioAsset({ key: "land", category: "sfx", durationSeconds: 0.18 }),
  defineAudioAsset({ key: "countdown", category: "sfx", durationSeconds: 0.24 }),
  defineAudioAsset({ key: "go", category: "sfx", durationSeconds: 0.5 }),
  defineAudioAsset({ key: "item", category: "sfx", durationSeconds: 0.3 }),
  defineAudioAsset({ key: "bomb", category: "sfx", durationSeconds: 0.7 }),
  defineAudioAsset({ key: "portal", category: "sfx", durationSeconds: 0.55 }),
  defineAudioAsset({ key: "death", category: "sfx", durationSeconds: 0.75 }),
  defineAudioAsset({ key: "finish", category: "sfx", durationSeconds: 1.25 }),
]);

export const AUDIO_ASSET_BY_KEY = Object.freeze(
  Object.fromEntries(GAME_AUDIO_ASSETS.map((asset) => [asset.key, asset])),
);

export function audioAssetRelativePath(asset) {
  return `audio/${asset.fileBase}.wav`;
}
