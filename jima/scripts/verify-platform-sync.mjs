import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_ITEM_ASSET_TYPES, GAME_ASSETS, PIECE_ASSET_TYPES } from "../shared/gameAssets.js";
import { ACTIVE_ITEMS, PIECES } from "../shared/gameConfig.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(projectRoot, "artifacts", "platform-build-manifest.json");
const args = new Set(process.argv.slice(2));
const knownArgs = new Set(["--source-only", "--write", "--check"]);

for (const arg of args) {
  if (!knownArgs.has(arg)) throw new Error(`Unknown argument: ${arg}`);
}
if (["--source-only", "--write", "--check"].filter((arg) => args.has(arg)).length !== 1) {
  throw new Error("Use exactly one of --source-only, --write, or --check.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function absolute(relativePath) {
  return join(projectRoot, ...relativePath.split(/[\\/]/));
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), "utf8");
}

function walkFiles(relativeDirectory) {
  const root = absolute(relativeDirectory);
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(projectRoot, path).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort();
}

function uniqueSorted(paths) {
  return [...new Set(paths)].sort();
}

function hashFiles(paths) {
  const hash = createHash("sha256");
  for (const relativePath of uniqueSorted(paths)) {
    const path = absolute(relativePath);
    assert(existsSync(path) && statSync(path).isFile(), `Missing file: ${relativePath}`);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex").toUpperCase();
}

function assertSameSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} mismatch:\nactual=${left}\nexpected=${right}`);
}

function assertSourceParity() {
  const pieceTypes = Object.keys(PIECES);
  const activeItemTypes = Object.keys(ACTIVE_ITEMS);
  assertSameSet(PIECE_ASSET_TYPES, pieceTypes, "Piece asset types");
  assertSameSet(ACTIVE_ITEM_ASSET_TYPES, activeItemTypes, "Active item asset types");
  const supportAssetCount = 6; // backdrop, four runners, and the goal
  const expectedAssetCount = pieceTypes.length + activeItemTypes.length + supportAssetCount;
  assert(
    GAME_ASSETS.length === expectedAssetCount,
    `Expected ${expectedAssetCount} canonical assets, found ${GAME_ASSETS.length}.`,
  );
  assertSameSet(new Set(GAME_ASSETS.map((asset) => asset.textureKey)), GAME_ASSETS.map((asset) => asset.textureKey), "Texture keys");
  assertSameSet(new Set(GAME_ASSETS.map((asset) => asset.fileBase)), GAME_ASSETS.map((asset) => asset.fileBase), "Asset filenames");

  for (const asset of GAME_ASSETS) {
    assert(Number.isFinite(asset.width) && asset.width > 0, `Invalid width for ${asset.fileBase}.`);
    assert(Number.isFinite(asset.height) && asset.height > 0, `Invalid height for ${asset.fileBase}.`);
    assert(existsSync(absolute(`public/assets/${asset.fileBase}.svg`)), `Missing canonical SVG: ${asset.fileBase}.svg`);
  }

  const desktopMain = readText("src/main.js");
  const wechatMain = readText("src/wechat/main.js");
  assert(desktopMain.includes("BoltboundScene"), "Desktop entry no longer uses the shared BoltboundScene.");
  assert(wechatMain.includes("BoltboundScene"), "WeChat entry no longer uses the shared BoltboundScene.");

  const sceneSource = readText("src/game/BoltboundScene.js");
  assert(sceneSource.includes("GAME_ASSETS"), "BoltboundScene must load the canonical GAME_ASSETS manifest.");
  assert(sceneSource.includes("PIECE_TEXTURE_KEYS"), "BoltboundScene must use canonical piece texture keys.");

  const assetBuildSource = readText("scripts/build-wechat-minigame.mjs");
  assert(assetBuildSource.includes("GAME_ASSETS"), "WeChat asset build must use the canonical GAME_ASSETS manifest.");

  const projectConfig = JSON.parse(readText("wechat-minigame/project.config.json"));
  assert(projectConfig.compileType === "game", "WeChat project must keep compileType=game.");
  assert(projectConfig.projectname === "boltbound-wechat-minigame", "WeChat projectname must be boltbound-wechat-minigame.");
  assert(projectConfig.description === "Boltbound native WeChat Mini Game", "WeChat project description must use Boltbound.");
  assert(readText("src/wechat/WechatUiScene.js").includes('"Boltbound"'), "WeChat home brand must be Boltbound.");
  assert(readText("vite.wechat.config.js").includes('name: "BoltboundMiniGame"'), "WeChat bundle global must be BoltboundMiniGame.");
}

function collectSourceFiles() {
  return uniqueSorted([
    ...walkFiles("shared"),
    ...walkFiles("server"),
    ...walkFiles("src"),
    ...walkFiles("public/assets"),
    "index.html",
    "lab.html",
    "package.json",
    "package-lock.json",
    "vite.config.js",
    "vite.wechat.config.js",
    "scripts/build-installer.ps1",
    "scripts/build-wechat-minigame.mjs",
    "scripts/verify-platform-sync.mjs",
    "installer/install.ps1",
    "installer/uninstall.ps1",
    "installer/Launcher.cs",
    "wechat-minigame/config.js",
    "wechat-minigame/game.js",
    "wechat-minigame/game.json",
    "wechat-minigame/project.config.json",
    "wechat-minigame/LICENSE",
    "wechat-minigame/js/libs/weapp-adapter.js",
  ]);
}

function createManifest() {
  for (const asset of GAME_ASSETS) {
    assert(existsSync(absolute(`wechat-minigame/assets/${asset.fileBase}.png`)), `Missing generated PNG: ${asset.fileBase}.png`);
  }

  const desktopFiles = walkFiles("dist");
  const wechatFiles = uniqueSorted([
    ...walkFiles("wechat-minigame/assets"),
    ...walkFiles("wechat-minigame/dist"),
    "wechat-minigame/config.js",
    "wechat-minigame/game.js",
    "wechat-minigame/game.json",
    "wechat-minigame/project.config.json",
    "wechat-minigame/LICENSE",
    "wechat-minigame/js/libs/weapp-adapter.js",
  ]);

  assert(desktopFiles.includes("dist/index.html"), "Desktop build is missing dist/index.html.");
  assert(desktopFiles.some((path) => path.endsWith(".js")), "Desktop build is missing its JavaScript bundle.");
  assert(wechatFiles.includes("wechat-minigame/dist/game.bundle.js"), "WeChat build is missing game.bundle.js.");

  const sourceFiles = collectSourceFiles();
  return {
    schemaVersion: 1,
    product: {
      desktop: "Zaolu Race",
      wechat: "Boltbound",
    },
    generatedAt: new Date().toISOString(),
    source: {
      hash: hashFiles(sourceFiles),
      fileCount: sourceFiles.length,
    },
    desktop: {
      path: "dist",
      hash: hashFiles(desktopFiles),
      fileCount: desktopFiles.length,
    },
    wechat: {
      path: "wechat-minigame",
      hash: hashFiles(wechatFiles),
      fileCount: wechatFiles.length,
    },
    assets: {
      count: GAME_ASSETS.length,
      pieceCount: PIECE_ASSET_TYPES.length,
      activeItemCount: ACTIVE_ITEM_ASSET_TYPES.length,
    },
  };
}

function comparableManifest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.generatedAt;
  return copy;
}

assertSourceParity();

if (args.has("--source-only")) {
  console.log(`[sync] shared source and Boltbound metadata verified (${PIECE_ASSET_TYPES.length} pieces, ${GAME_ASSETS.length} assets)`);
  process.exit(0);
}

const current = createManifest();

if (args.has("--write")) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`[sync] wrote ${relative(projectRoot, manifestPath)} source=${current.source.hash}`);
  console.log(`[sync] desktop=${current.desktop.hash} wechat=${current.wechat.hash}`);
  process.exit(0);
}

assert(existsSync(manifestPath), "Missing artifacts/platform-build-manifest.json. Run npm run build:all.");
const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
assert(
  JSON.stringify(comparableManifest(saved)) === JSON.stringify(comparableManifest(current)),
  "Platform outputs are not synchronized with the current source. Run npm run build:all.",
);
console.log(`[sync] desktop and Boltbound outputs match source ${current.source.hash}`);
