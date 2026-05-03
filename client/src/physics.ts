// Power → impulse mapping: impulse = 0.01 + power * 0.14
// Scaled to velocity for setVelocity-based shot (matches spike)
const SPEED_SCALE = 25;

export function powerToImpulse(power: number): number {
  return (0.01 + power * 0.14) * SPEED_SCALE;
}

// Ball stopped: velocity magnitude < 0.01 for 60 consecutive frames
const STOP_THRESHOLD = 0.01;
const STOP_FRAMES = 60;

export function isBallStopped(velocityMagnitude: number, stillFrames: number): boolean {
  if (velocityMagnitude < STOP_THRESHOLD) {
    return stillFrames >= STOP_FRAMES;
  }
  return false;
}

// Ball in hole: distance to hole center < trigger radius (12px)
const HOLE_TRIGGER_RADIUS = 12;

export function isBallInHole(
  ballX: number, ballY: number,
  holeX: number, holeY: number
): boolean {
  const dx = ballX - holeX;
  const dy = ballY - holeY;
  return Math.sqrt(dx * dx + dy * dy) < HOLE_TRIGGER_RADIUS;
}

// Matter.js Verlet integration reads positionPrev — not velocity — as the
// motion source. Setting velocity directly is overwritten on the next step.
export function applyVelocity(body: MatterJS.BodyType, vx: number, vy: number): void {
  (body as any).velocity.x = vx;
  (body as any).velocity.y = vy;
  (body as any).positionPrev.x = body.position.x - vx;
  (body as any).positionPrev.y = body.position.y - vy;
  (body as any).speed = Math.sqrt(vx * vx + vy * vy);
}
