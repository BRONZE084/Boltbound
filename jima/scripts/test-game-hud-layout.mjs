import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

assert.match(
  css,
  /\.game-bar\s*>\s*\.game-settings\s*\{[^}]*right:\s*max\(84px,\s*calc\(env\(safe-area-inset-right\)\s*\+\s*68px\)\)/s,
  "desktop settings must sit to the left of the 56px timer",
);
assert.match(
  css,
  /@media\s*\(orientation:\s*landscape\)[\s\S]*?\(pointer:\s*coarse\)[\s\S]*?\.game-bar\s*>\s*\.game-settings\s*\{[^}]*right:\s*max\(46px,\s*calc\(env\(safe-area-inset-right\)\s*\+\s*46px\)\)/s,
  "mobile landscape must retain its compact non-overlapping settings offset",
);

function horizontalRect(viewportWidth, right, width) {
  return { left: viewportWidth - right - width, right: viewportWidth - right };
}

function gap(leftRect, rightRect) {
  return rightRect.left - leftRect.right;
}

const desktopGear = horizontalRect(1_600, 84, 42);
const desktopTimer = horizontalRect(1_600, 16, 56);
assert.equal(gap(desktopGear, desktopTimer), 12);

const mobileGear = horizontalRect(844, 46, 34);
const mobileTimer = horizontalRect(844, 6, 34);
assert.equal(gap(mobileGear, mobileTimer), 6);

console.log("game HUD: desktop and mobile-landscape settings hit targets do not overlap the timer");
