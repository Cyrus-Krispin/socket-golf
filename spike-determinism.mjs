// Headless determinism spike — matches the browser HTML exactly.
// Run: node spike-determinism.mjs
// Compare with browser tab results at spike-determinism.html

import Matter from 'matter-js';

const { Engine, Bodies, Body, Composite } = Matter;

const engine = Engine.create({
  gravity: { x: 0, y: 0, scale: 0 }
});

const ball = Bodies.circle(80, 140, 5, {
  restitution: 0.6,
  friction: 0.05,
  frictionAir: 0.01,
  density: 0.002
});

const walls = [
  Bodies.rectangle(300, 0, 600, 10, { isStatic: true }),
  Bodies.rectangle(300, 300, 600, 10, { isStatic: true }),
  Bodies.rectangle(0, 150, 10, 300, { isStatic: true }),
  Bodies.rectangle(600, 150, 10, 300, { isStatic: true }),
  Bodies.rectangle(160, 80, 20, 20, { isStatic: true }),
  Bodies.rectangle(300, 120, 30, 10, { isStatic: true }),
  Bodies.rectangle(420, 160, 15, 15, { isStatic: true }),
  Bodies.rectangle(120, 160, 25, 10, { isStatic: true }),
  Bodies.rectangle(340, 60, 15, 20, { isStatic: true }),
];

Composite.add(engine.world, [ball, ...walls]);

const FIXED_DELTA = 1000 / 60;
const RUN_DURATION = 5000;
const TOTAL_FRAMES = RUN_DURATION / FIXED_DELTA;

const angle = 1.047;
const power = 0.5;
const impulseMag = 0.01 + power * 0.14; // 0.08
const speedScale = 25;
const vx = Math.cos(angle) * impulseMag * speedScale;
const vy = Math.sin(angle) * impulseMag * speedScale;
Body.setVelocity(ball, { x: vx, y: vy });

for (let i = 0; i < TOTAL_FRAMES; i++) {
  Engine.update(engine, FIXED_DELTA);
}

const px = ball.position.x.toFixed(2);
const py = ball.position.y.toFixed(2);
const velMag = Math.sqrt(ball.velocity.x ** 2 + ball.velocity.y ** 2).toFixed(4);

console.log(`NODE.JS (V8) REFERENCE RESULT`);
console.log(`x=${px}`);
console.log(`y=${py}`);
console.log(`velocity=${velMag}`);
console.log(`frames=${TOTAL_FRAMES}`);
console.log(``);
console.log(`Compare with TWO browser tabs at spike-determinism.html`);
console.log(`Target divergence: <10px for GO, 10-30px for RISK, >30px for NO-GO`);
