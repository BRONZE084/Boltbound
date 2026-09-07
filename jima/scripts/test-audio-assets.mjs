import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_AUDIO_ASSETS, audioAssetRelativePath } from "../shared/audioAssets.js";
import { createAudioAssetBuffer, validateWaveBuffer } from "./generate-audio-assets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const canonicalRoot = join(projectRoot, "public", "assets");
const miniGameRoot = join(projectRoot, "wechat-minigame", "assets");
const digest = createHash("sha256");
let totalBytes = 0;

for (const asset of GAME_AUDIO_ASSETS) {
  const relativePath = audioAssetRelativePath(asset);
  const canonical = readFileSync(join(canonicalRoot, relativePath));
  const miniGameCopy = readFileSync(join(miniGameRoot, relativePath));
  const expected = createAudioAssetBuffer(asset);
  const stats = validateWaveBuffer(canonical, asset);
  if (!canonical.equals(expected)) {
    throw new Error(`${relativePath}: canonical file is not reproducible`);
  }
  if (!miniGameCopy.equals(canonical)) {
    throw new Error(`${relativePath}: mini-game copy differs from canonical file`);
  }
  digest.update(relativePath);
  digest.update(canonical);
  totalBytes += canonical.length;
  const seam = stats.seamDelta === null ? "" : ` seam=${stats.seamDelta.toFixed(5)}`;
  console.log(`[audio-test] PASS ${relativePath} ${stats.durationSeconds.toFixed(3)}s${seam}`);
}

console.log(
  `[audio-test] PASS ${GAME_AUDIO_ASSETS.length} files, ${totalBytes} bytes, ` +
  `set-sha256=${digest.digest("hex").toUpperCase()}`,
);
