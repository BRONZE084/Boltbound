function defineAsset({
  textureKey,
  fileBase = textureKey,
  width,
  height,
  needsTransparency,
  pieceType,
  activeItemType,
}) {
  return Object.freeze({
    textureKey,
    fileBase,
    width,
    height,
    needsTransparency,
    ...(pieceType ? { pieceType } : {}),
    ...(activeItemType ? { activeItemType } : {}),
  });
}

export const GAME_ASSETS = Object.freeze([
  defineAsset({ textureKey: "yard", fileBase: "yard-backdrop", width: 1600, height: 900, needsTransparency: false }),
  defineAsset({ textureKey: "runner-coral", width: 96, height: 112, needsTransparency: true }),
  defineAsset({ textureKey: "runner-green", width: 96, height: 112, needsTransparency: true }),
  defineAsset({ textureKey: "runner-teal", width: 96, height: 112, needsTransparency: true }),
  defineAsset({ textureKey: "runner-yellow", width: 96, height: 112, needsTransparency: true }),
  defineAsset({ textureKey: "piece-turbo", width: 96, height: 96, needsTransparency: true, activeItemType: "turbo" }),
  defineAsset({ textureKey: "piece-jumpjet", width: 96, height: 96, needsTransparency: true, activeItemType: "jumpjet" }),
  defineAsset({ textureKey: "piece-shield", width: 96, height: 96, needsTransparency: true, activeItemType: "shield" }),
  defineAsset({ textureKey: "piece-grip", width: 96, height: 96, needsTransparency: true, activeItemType: "grip" }),
  defineAsset({ textureKey: "piece-slow", width: 96, height: 96, needsTransparency: true, activeItemType: "slow" }),
  defineAsset({ textureKey: "piece-gravity", width: 96, height: 96, needsTransparency: true, activeItemType: "gravity" }),
  defineAsset({ textureKey: "piece-reverse", width: 96, height: 96, needsTransparency: true, activeItemType: "reverse" }),
  defineAsset({ textureKey: "piece-fog", width: 96, height: 96, needsTransparency: true, activeItemType: "fog" }),
  defineAsset({ textureKey: "piece-bomb", width: 96, height: 96, needsTransparency: true, activeItemType: "bomb" }),
  defineAsset({ textureKey: "piece-barrier", width: 160, height: 40, needsTransparency: true, pieceType: "barrier" }),
  defineAsset({ textureKey: "piece-windmill", width: 360, height: 360, needsTransparency: true, pieceType: "windmill" }),
  defineAsset({ textureKey: "piece-rotating-crate", width: 88, height: 88, needsTransparency: true, pieceType: "rotatingCrate" }),
  defineAsset({ textureKey: "piece-beam", width: 180, height: 52, needsTransparency: true, pieceType: "beam" }),
  defineAsset({ textureKey: "piece-blackhole", width: 100, height: 100, needsTransparency: true, pieceType: "blackhole" }),
  defineAsset({ textureKey: "piece-bumper", width: 96, height: 96, needsTransparency: true, pieceType: "bumper" }),
  defineAsset({ textureKey: "piece-cannon", width: 100, height: 80, needsTransparency: true, pieceType: "cannon" }),
  defineAsset({ textureKey: "piece-conveyor", width: 160, height: 40, needsTransparency: true, pieceType: "conveyor" }),
  defineAsset({ textureKey: "piece-crate", width: 88, height: 88, needsTransparency: true, pieceType: "crate" }),
  defineAsset({ textureKey: "piece-fan", width: 80, height: 80, needsTransparency: true, pieceType: "fan" }),
  defineAsset({ textureKey: "piece-ice", width: 160, height: 40, needsTransparency: true, pieceType: "ice" }),
  defineAsset({ textureKey: "piece-laser", width: 80, height: 120, needsTransparency: true, pieceType: "laser" }),
  defineAsset({ textureKey: "piece-portal", width: 80, height: 120, needsTransparency: true, pieceType: "portal" }),
  defineAsset({ textureKey: "piece-saw", width: 96, height: 96, needsTransparency: true, pieceType: "saw" }),
  defineAsset({ textureKey: "piece-spikes", width: 92, height: 58, needsTransparency: true, pieceType: "spikes" }),
  defineAsset({ textureKey: "piece-spring", width: 92, height: 58, needsTransparency: true, pieceType: "spring" }),
  defineAsset({ textureKey: "goal", width: 104, height: 160, needsTransparency: true }),
]);

export const PIECE_ASSET_TYPES = Object.freeze(
  GAME_ASSETS.flatMap((asset) => (asset.pieceType ? [asset.pieceType] : [])),
);

export const ACTIVE_ITEM_ASSET_TYPES = Object.freeze(
  GAME_ASSETS.flatMap((asset) => (asset.activeItemType ? [asset.activeItemType] : [])),
);

export const PIECE_TEXTURE_KEYS = Object.freeze(
  Object.fromEntries(
    GAME_ASSETS.flatMap((asset) =>
      asset.pieceType ? [[asset.pieceType, asset.textureKey]] : [],
    ),
  ),
);

export const ACTIVE_ITEM_TEXTURE_KEYS = Object.freeze(
  Object.fromEntries(
    GAME_ASSETS.flatMap((asset) =>
      asset.activeItemType ? [[asset.activeItemType, asset.textureKey]] : [],
    ),
  ),
);
