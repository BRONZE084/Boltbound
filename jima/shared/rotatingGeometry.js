// 连续旋转矩形的真实几何；不把倾斜方箱当成变大的轴对齐方框。
export function rotatePoint(x, y, angle) {
  return { x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle) };
}

export function rectCorners(rect) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const point = rotatePoint(sx * rect.width / 2, sy * rect.height / 2, rect.angle);
    return { x: rect.x + point.x, y: rect.y + point.y };
  });
}

// 分离轴检测：返回将直立人物推出旋转箱体所需的最短位移。
export function rotatingRectContact(body, rect) {
  const c = Math.cos(rect.angle);
  const s = Math.sin(rect.angle);
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: c, y: s }, { x: -s, y: c }];
  let contact = null;
  for (const axis of axes) {
    const distance = (body.x - rect.x) * axis.x + (body.y - rect.y) * axis.y;
    const reach = (Math.abs(axis.x) * body.width + Math.abs(axis.y) * body.height +
      Math.abs(axis.x * c + axis.y * s) * rect.width +
      Math.abs(-axis.x * s + axis.y * c) * rect.height) / 2;
    const depth = reach - Math.abs(distance);
    if (depth <= 1e-7) return null;
    if (!contact || depth < contact.depth) {
      const direction = distance < 0 ? -1 : 1;
      contact = { depth, nx: axis.x * direction, ny: axis.y * direction };
    }
  }
  return contact;
}

// 人物保持直立，脚底由其宽度范围内最高的箱面接触点承托。
export function rotatingSurface(rect, left, right) {
  const points = rectCorners(rect);
  let surface = null;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (-dx / length > -0.2) continue;
    const start = Math.max(left, a.x);
    const end = Math.min(right, b.x);
    if (end <= start + 1e-6) continue;
    const x = dy >= 0 ? start : end;
    const y = a.y + (x - a.x) * dy / dx;
    if (!surface || y < surface.y) surface = { x, y, nx: dy / length, ny: -dx / length };
  }
  return surface;
}


// 一圈分为四段，每段先停顿再平滑转过 90°，避免启停时瞬间跳变。
export function steppedRotationAngle(elapsed, periodMs, pauseMs) {
  const quarterMs = periodMs / 4;
  const time = Math.max(0, elapsed);
  const quarter = Math.floor(time / quarterMs);
  const phase = time - quarter * quarterMs;
  const pause = Math.max(0, Math.min(pauseMs, quarterMs - 1));
  const progress = Math.max(0, Math.min(1, (phase - pause) / (quarterMs - pause)));
  const eased = progress * progress * (3 - 2 * progress);
  return (quarter + eased) * Math.PI / 2;
}
