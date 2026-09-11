import assert from "node:assert/strict";
import { rectCorners, rotatingRectContact, rotatingSurface, steppedRotationAngle } from "../shared/rotatingGeometry.js";

const rect = { x: 0, y: 0, width: 80, height: 80, angle: Math.PI / 4 };
assert.equal(rotatingRectContact({ x: 52, y: -52, width: 4, height: 4 }, rect), null,
  "45° 方箱外接方框的空角不应碰撞");
assert.ok(rotatingRectContact({ x: 40, y: 0, width: 10, height: 10 }, rect),
  "转出的真实箱角必须碰撞");
assert.ok(Math.abs(rotatingSurface(rect, -10, 10).y + Math.sqrt(3200)) < 1e-8,
  "45° 顶角是人物的实际承托面");
for (let degrees = 0; degrees < 360; degrees += 3) {
  rect.angle = degrees * Math.PI / 180;
  for (const point of rectCorners(rect)) assert.ok(Math.abs(Math.hypot(point.x, point.y) - Math.sqrt(3200)) < 1e-8);
  const surface = rotatingSurface(rect, -12, 12);
  assert.ok(surface && surface.ny < -0.2 && surface.y <= -39.99);
  const actor = { x: 0, y: surface.y - 15 + 0.5, width: 24, height: 30 };
  const contact = rotatingRectContact(actor, rect);
  assert.ok(contact && contact.ny < 0, `${degrees}° 落地穿入应向上分离`);
  actor.x += contact.nx * (contact.depth + 1e-6);
  actor.y += contact.ny * (contact.depth + 1e-6);
  assert.equal(rotatingRectContact(actor, rect), null, `${degrees}° 最短分离后不再重叠`);
}
console.log("旋转矩形：空角、真实顶角、承托面和全周分离验证通过");

for (let quarter = 0; quarter < 9; quarter += 1) {
  for (const offset of [0, 175, 350]) {
    assert.ok(Math.abs(steppedRotationAngle(quarter * 1500 + offset, 6000, 350) - quarter * Math.PI / 2) < 1e-9,
      `第 ${quarter} 段停顿期间角度不变`);
  }
  assert.ok(Math.abs(steppedRotationAngle(quarter * 1500 + 925, 6000, 350) - (quarter + 0.5) * Math.PI / 2) < 1e-9,
    "转动半程应到达中间的 45°");
}
assert.ok(steppedRotationAngle(1500, 6000, 350) - steppedRotationAngle(1499, 6000, 350) < 1e-5,
  "到达停顿角度前应平滑减速");
console.log("旋转方箱：每 90° 停顿 350 毫秒、转动中点与平滑停止验证通过");
