import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { ACTIVE_ITEM_ASSET_TYPES, GAME_ASSETS, PIECE_ASSET_TYPES } from "../shared/gameAssets.js";
import { GAME_AUDIO_ASSETS, audioAssetRelativePath } from "../shared/audioAssets.js";
import { ACTIVE_ITEMS, PIECES } from "../shared/gameConfig.js";
import {
  createAudioAssetBuffer,
  generateCanonicalAudioAssets,
  validateWaveBuffer,
} from "./generate-audio-assets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sourceAssetDir = join(projectRoot, "public", "assets");
const miniGameRoot = join(projectRoot, "wechat-minigame");
const outputAssetDir = join(miniGameRoot, "assets");
const outputAudioDir = join(outputAssetDir, "audio");
const viteConfig = join(projectRoot, "vite.wechat.config.js");
const viteCli = join(projectRoot, "node_modules", "vite", "bin", "vite.js");

const assetManifest = GAME_ASSETS.map(({ fileBase, width, height, needsTransparency }) => ({
  name: fileBase,
  width,
  height,
  needsTransparency,
  source: join(sourceAssetDir, `${fileBase}.svg`),
  output: join(outputAssetDir, `${fileBase}.png`),
}));

const audioManifest = GAME_AUDIO_ASSETS.map((asset) => ({
  ...asset,
  relativePath: audioAssetRelativePath(asset),
  source: join(sourceAssetDir, audioAssetRelativePath(asset)),
  output: join(outputAssetDir, audioAssetRelativePath(asset)),
}));

const args = new Set(process.argv.slice(2));
const assetsOnly = args.has("--assets-only");
const verifyOnly = args.has("--verify-only");
const forceAssets = args.has("--force-assets");
const knownArgs = new Set(["--assets-only", "--verify-only", "--force-assets"]);
for (const arg of args) {
  if (!knownArgs.has(arg)) {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

function assertSourceDimensions(asset) {
  if (!existsSync(asset.source)) {
    throw new Error(`Missing SVG source: ${asset.source}`);
  }
  const svg = readFileSync(asset.source, "utf8");
  const width = Number(svg.match(/<svg\b[^>]*\bwidth=["'](\d+)["']/i)?.[1]);
  const height = Number(svg.match(/<svg\b[^>]*\bheight=["'](\d+)["']/i)?.[1]);
  if (width !== asset.width || height !== asset.height) {
    throw new Error(
      `${basename(asset.source)} declares ${width}x${height}; expected ${asset.width}x${asset.height}.`,
    );
  }
}

function parsePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("not a PNG file");
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error("truncated PNG chunk");
    }
    if (type === "IDAT") idat.push(buffer.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  return { width, height, bitDepth, colorType, idat };
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function hasTransparentPixel(png) {
  if (png.colorType !== 6 || png.bitDepth !== 8 || png.idat.length === 0) return false;
  const bytesPerPixel = 4;
  const rowBytes = png.width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(png.idat));
  if (raw.length !== (rowBytes + 1) * png.height) {
    throw new Error("unexpected RGBA scanline length");
  }

  let previous = Buffer.alloc(rowBytes);
  let cursor = 0;
  for (let y = 0; y < png.height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const current = Buffer.allocUnsafe(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[cursor + x];
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      current[x] = (value + predictor) & 0xff;
    }
    cursor += rowBytes;
    for (let x = 3; x < rowBytes; x += bytesPerPixel) {
      if (current[x] < 255) return true;
    }
    previous = current;
  }
  return false;
}

function validatePng(asset) {
  if (!existsSync(asset.output)) return "missing";
  try {
    const png = parsePng(readFileSync(asset.output));
    if (png.width !== asset.width || png.height !== asset.height) {
      return `${png.width}x${png.height}, expected ${asset.width}x${asset.height}`;
    }
    if (png.bitDepth !== 8 || ![2, 6].includes(png.colorType)) {
      return `unsupported PNG bit depth/color type ${png.bitDepth}/${png.colorType}`;
    }
    if (asset.needsTransparency && !hasTransparentPixel(png)) {
      return "transparent artwork lost its alpha background";
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const edge = candidates.find((candidate) => existsSync(candidate));
  if (!edge) {
    throw new Error("Microsoft Edge was not found. Set EDGE_PATH to msedge.exe.");
  }
  return edge;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited with ${code}\\n${stdout}\\n${stderr}`));
    });
  });
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const size = statSync(file).size;
      stableChecks = size > 0 && size === lastSize ? stableChecks + 1 : 0;
      lastSize = size;
      if (stableChecks >= 2) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Edge did not create ${file} within ${timeoutMs} ms.`);
}

async function convertWithEdge(edge, asset) {
  const profileDir = mkdtempSync(join(tmpdir(), "zaolu-edge-profile-"));
  const temporaryPng = join(tmpdir(), `zaolu-${asset.name}-${process.pid}-${Date.now()}.png`);
  try {
    await run(edge, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--user-data-dir=${profileDir}`,
      `--window-size=${asset.width},${asset.height}`,
      `--screenshot=${temporaryPng}`,
      pathToFileURL(asset.source).href,
    ]);
    await waitForFile(temporaryPng);
    mkdirSync(outputAssetDir, { recursive: true });
    copyFileSync(temporaryPng, asset.output);
    const validationError = validatePng(asset);
    if (validationError) {
      throw new Error(`${asset.name}.png: ${validationError}`);
    }
  } finally {
    rmSync(temporaryPng, { force: true });
    try {
      rmSync(profileDir, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Edge can briefly retain its temporary profile on Windows; it is safe to leave in TEMP.
    }
  }
}

function assertScaffold() {
  for (const relativePath of [
    "game.js",
    "game.json",
    "project.config.json",
    "config.js",
    "README.md",
    "LICENSE",
    "js/libs/weapp-adapter.js",
  ]) {
    const file = join(miniGameRoot, relativePath);
    if (!existsSync(file)) throw new Error(`Missing mini-game project file: ${file}`);
  }
  const pngFiles = readdirSync(outputAssetDir).filter((file) => file.endsWith(".png"));
  if (pngFiles.length !== assetManifest.length) {
    throw new Error(`Expected ${assetManifest.length} PNG assets, found ${pngFiles.length}.`);
  }
  if (!existsSync(outputAudioDir)) {
    throw new Error(`Missing mini-game audio directory: ${outputAudioDir}`);
  }
  const wavFiles = readdirSync(outputAudioDir).filter((file) => file.endsWith(".wav"));
  if (wavFiles.length !== audioManifest.length) {
    throw new Error(`Expected ${audioManifest.length} WAV assets, found ${wavFiles.length}.`);
  }
}

function assertPieceAssetCoverage() {
  const configuredItemTypes = Object.keys(ACTIVE_ITEMS).sort();
  const itemAssetTypes = [...ACTIVE_ITEM_ASSET_TYPES].sort();
  const configuredTypes = Object.keys(PIECES).sort();
  const assetTypes = [...PIECE_ASSET_TYPES].sort();
  const uniqueAssetTypes = [...new Set(assetTypes)];
  if (
    uniqueAssetTypes.length !== assetTypes.length ||
    configuredTypes.length !== assetTypes.length ||
    configuredTypes.some((type, index) => type !== assetTypes[index])
  ) {
    throw new Error(
      `Piece asset coverage mismatch. PIECES=[${configuredTypes.join(", ")}], assets=[${assetTypes.join(", ")}].`,
    );
  }
  if (
    new Set(itemAssetTypes).size !== itemAssetTypes.length ||
    configuredItemTypes.length !== itemAssetTypes.length ||
    configuredItemTypes.some((type, index) => type !== itemAssetTypes[index])
  ) {
    throw new Error(
      `Active item asset coverage mismatch. ACTIVE_ITEMS=[${configuredItemTypes.join(", ")}], assets=[${itemAssetTypes.join(", ")}].`,
    );
  }
}

async function prepareAssets() {
  mkdirSync(outputAssetDir, { recursive: true });
  for (const asset of assetManifest) assertSourceDimensions(asset);

  let edge;
  for (const asset of assetManifest) {
    const validationError = validatePng(asset);
    const sourceIsNewer =
      existsSync(asset.output) && statSync(asset.source).mtimeMs > statSync(asset.output).mtimeMs;
    const needsBuild = forceAssets || validationError || sourceIsNewer;
    if (!needsBuild) {
      console.log(`[assets] verified ${asset.name}.png (${asset.width}x${asset.height})`);
      continue;
    }
    if (verifyOnly) {
      const reason = validationError || "source SVG is newer";
      throw new Error(`${asset.name}.png needs regeneration: ${reason}`);
    }
    edge ??= findEdge();
    console.log(`[assets] rendering ${asset.name}.svg -> ${asset.name}.png`);
    await convertWithEdge(edge, asset);
  }

  generateCanonicalAudioAssets({ verifyOnly });
  mkdirSync(outputAudioDir, { recursive: true });
  for (const asset of audioManifest) {
    const canonical = readFileSync(asset.source);
    validateWaveBuffer(canonical, asset);
    const expected = createAudioAssetBuffer(asset);
    if (!canonical.equals(expected)) {
      throw new Error(`${asset.relativePath} does not match its deterministic source`);
    }
    const outputMatches = existsSync(asset.output) && readFileSync(asset.output).equals(canonical);
    if (!outputMatches && verifyOnly) {
      throw new Error(`${asset.relativePath} is missing or differs in the mini-game project`);
    }
    if (!outputMatches || forceAssets) {
      copyFileSync(asset.source, asset.output);
      console.log(`[audio] synced ${asset.relativePath}`);
    } else {
      console.log(`[audio] verified ${asset.relativePath}`);
    }
  }
}

async function main() {
  assertPieceAssetCoverage();
  await prepareAssets();
  assertScaffold();
  if (assetsOnly) {
    console.log(
      `[wechat] ${assetManifest.length} PNG and ${audioManifest.length} WAV assets are ready in ${outputAssetDir}`,
    );
    return;
  }

  if (verifyOnly) {
    const bundle = join(miniGameRoot, "dist", "game.bundle.js");
    if (!existsSync(bundle)) throw new Error(`Missing built bundle: ${bundle}`);
    console.log(
      `[wechat] project scaffold, ${assetManifest.length} PNG, ${audioManifest.length} WAV, and bundle verified`,
    );
    return;
  }

  const entry = join(projectRoot, "src", "wechat", "main.js");
  if (!existsSync(entry)) {
    throw new Error(`Missing WeChat entry: ${entry}`);
  }
  if (!existsSync(viteCli)) {
    throw new Error("Vite is not installed. Run npm install first.");
  }
  console.log("[wechat] building one IIFE bundle (code splitting disabled)");
  await run(process.execPath, [viteCli, "build", "--config", viteConfig], {
    stdio: "inherit",
  });
  const bundle = join(miniGameRoot, "dist", "game.bundle.js");
  if (!existsSync(bundle)) throw new Error(`Vite did not create ${bundle}`);
  console.log(`[wechat] ready to import: ${miniGameRoot}`);
}

main().catch((error) => {
  console.error(`[wechat] ${error.message}`);
  process.exitCode = 1;
});
