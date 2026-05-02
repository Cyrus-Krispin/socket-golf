import Phaser from 'phaser';
import { powerToImpulse, isBallStopped, isBallInHole } from '../physics';
import { socket } from '../network';
import type { ShotMessage } from 'shared';

interface CourseData {
  name: string;
  par: number;
  tee: { x: number; y: number };
  hole: { x: number; y: number; visualRadius: number; triggerRadius: number };
  walls: { x: number; y: number; width: number; height: number; rotation?: number }[];
  fairway: { vertices: { x: number; y: number }[] };
}

const STROKE_LIMIT_FACTOR = 2; // double par
const STROKE_LIMIT_BONUS = 3;  // + 3

export class GameScene extends Phaser.Scene {
  private holeIndex = 0;
  private courseData!: CourseData;
  private ball!: MatterJS.BodyType;
  private holeBody!: MatterJS.BodyType;
  private wallBodies: MatterJS.BodyType[] = [];
  private strokeCount = 0;
  private stillFrames = 0;
  private isAiming = false;
  private aimStart = new Phaser.Math.Vector2();
  private aimCurrent = new Phaser.Math.Vector2();
  private graphics!: Phaser.GameObjects.Graphics;
  private powerMeterBg!: Phaser.GameObjects.Graphics;
  private powerMeterFill!: Phaser.GameObjects.Graphics;
  private turnText!: Phaser.GameObjects.Text;
  private strokeText!: Phaser.GameObjects.Text;
  private holeText!: Phaser.GameObjects.Text;
  private holeDone = false;
  private maxStrokes = 0;

  constructor() {
    super({ key: 'GameScene' });
  }

  preload() {
    // Load all 3 courses
    this.load.json('hole1', '/src/courses/hole1.json');
    this.load.json('hole2', '/src/courses/hole2.json');
    this.load.json('hole3', '/src/courses/hole3.json');
  }

  init(data: { holeIndex: number }) {
    this.holeIndex = data.holeIndex ?? 0;
    this.strokeCount = 0;
    this.stillFrames = 60; // Ball starts "stopped" so player can aim immediately
    this.holeDone = false;
    this.wallBodies = [];
  }

  create() {
    // Load course data
    const holeNum = this.holeIndex + 1;
    this.courseData = this.cache.json.get(`hole${holeNum}`) as CourseData;
    this.maxStrokes = this.courseData.par * STROKE_LIMIT_FACTOR + STROKE_LIMIT_BONUS;

    // Graphics layer
    this.graphics = this.add.graphics();
    this.powerMeterBg = this.add.graphics();
    this.powerMeterFill = this.add.graphics();

    // Build course from JSON
    this.buildCourse();

    // Ball
    this.ball = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, 4, {
      restitution: 0.6,
      friction: 0.05,
      frictionAir: 0.01,
      density: 0.002,
      label: 'ball',
    });

    // Hole sensor (static, invisible)
    this.holeBody = this.matter.add.circle(
      this.courseData.hole.x,
      this.courseData.hole.y,
      this.courseData.hole.triggerRadius,
      { isStatic: true, isSensor: true, label: 'hole' }
    );

    // Collision: ball enters hole
    this.matter.world.on('collisionstart', (_event: any, bodyA: MatterJS.BodyType, bodyB: MatterJS.BodyType) => {
      const ballBody = bodyA.label === 'ball' ? bodyA : bodyB.label === 'ball' ? bodyA : null;
      const holeBody = bodyA.label === 'hole' ? bodyA : bodyB.label === 'hole' ? bodyA : null;
      if (ballBody && holeBody && !this.holeDone) {
        // Only count if ball is nearly stopped
        const vel = Math.sqrt(ballBody.velocity.x ** 2 + ballBody.velocity.y ** 2);
        if (vel < 0.5 && isBallInHole(ballBody.position.x, ballBody.position.y, this.courseData.hole.x, this.courseData.hole.y)) {
          this.onHoleComplete();
        }
      }
    });

    // Disable gravity
    this.matter.world.setGravity(0, 0);

    // HUD
    const style = { fontFamily: '"Courier New", monospace', fontSize: '12px', color: '#e0e0e0' };
    this.holeText = this.add.text(10, 8, `HOLE ${holeNum}/3  Par ${this.courseData.par}`, {
      ...style, fontSize: '10px', color: '#888888',
    });
    this.turnText = this.add.text(320, 8, 'YOUR TURN', {
      fontFamily: '"Press Start 2P", "Courier New", monospace', fontSize: '10px', color: '#4ecdc4',
    }).setOrigin(0.5, 0);
    this.strokeText = this.add.text(630, 8, `Stroke 0`, { ...style, fontSize: '10px', color: '#888888' }).setOrigin(1, 0);

    // Draw initial state
    this.drawCourse();
  }

  private buildCourse() {
    // Walls
    for (const w of this.courseData.walls) {
      const body = this.matter.add.rectangle(w.x, w.y, w.width, w.height, {
        isStatic: true,
        angle: w.rotation ?? 0,
        label: 'wall',
      });
      this.wallBodies.push(body);
    }

    // Outer boundary (invisible walls just offscreen)
    this.matter.add.rectangle(320, -10, 680, 20, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(320, 370, 680, 20, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(-10, 180, 20, 400, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(650, 180, 20, 400, { isStatic: true, label: 'wall' });
  }

  private drawCourse() {
    const g = this.graphics;
    g.clear();

    // Background
    g.fillStyle(0x16213e);
    g.fillRect(0, 0, 640, 360);

    // Fairway
    const verts = this.courseData.fairway.vertices;
    if (verts.length > 2) {
      g.fillStyle(0x2d8a4e);
      g.beginPath();
      g.moveTo(verts[0].x, verts[0].y);
      for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x, verts[i].y);
      g.closePath();
      g.fillPath();
    }

    // Walls
    g.fillStyle(0x5a5a6e);
    g.lineStyle(1, 0x7a7a8e);
    for (const w of this.courseData.walls) {
      g.fillRect(w.x - w.width / 2, w.y - w.height / 2, w.width, w.height);
      g.strokeRect(w.x - w.width / 2, w.y - w.height / 2, w.width, w.height);
    }

    // Tee
    g.fillStyle(0xc4a45a);
    g.fillRect(this.courseData.tee.x - 5, this.courseData.tee.y - 5, 10, 10);

    // Hole
    g.fillStyle(0x0a0a0a);
    g.fillCircle(this.courseData.hole.x, this.courseData.hole.y, this.courseData.hole.visualRadius);
    // Flag
    g.lineStyle(1, 0xcccccc);
    g.beginPath();
    g.moveTo(this.courseData.hole.x, this.courseData.hole.y);
    g.lineTo(this.courseData.hole.x, this.courseData.hole.y - 16);
    g.strokePath();
    g.fillStyle(0xcc4444);
    g.fillTriangle(
      this.courseData.hole.x, this.courseData.hole.y - 16,
      this.courseData.hole.x + 6, this.courseData.hole.y - 13,
      this.courseData.hole.x, this.courseData.hole.y - 10
    );

    // Ball
    this.drawBall();
  }

  private drawBall() {
    const g = this.graphics;
    if (!this.ball) return;
    g.fillStyle(0xf0f0f0);
    g.lineStyle(1, 0x888888);
    g.fillCircle(this.ball.position.x, this.ball.position.y, 4);
    g.strokeCircle(this.ball.position.x, this.ball.position.y, 4);
  }

  update(_time: number, delta: number) {
    if (this.holeDone) return;

    // Fixed timestep: always step 16.667ms
    this.matter.world.step(1000 / 60);

    // Redraw
    this.drawCourse();

    // Ball stopped detection
    if (this.ball) {
      const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
      if (vel < 0.01) {
        this.stillFrames++;
      } else {
        this.stillFrames = 0;
      }
    }

    // Aim input
    if (!this.isAiming && this.stillFrames >= 60 && this.strokeCount > 0) {
      // Ball stopped after a shot — player can aim again
    }

    this.handleAimInput();
  }

  private handleAimInput() {
    const pointer = this.input.activePointer;

    if (pointer.isDown && !this.isAiming && this.stillFrames >= 60 && !this.holeDone) {
      // Start aiming
      this.isAiming = true;
      this.aimStart.set(pointer.x, pointer.y);
    }

    if (pointer.isDown && this.isAiming) {
      this.aimCurrent.set(pointer.x, pointer.y);

      // Draw aim line (dotted, --accent #4ecdc4)
      const g = this.graphics;
      if (this.ball) {
        const dx = this.ball.position.x - this.aimCurrent.x;
        const dy = this.ball.position.y - this.aimCurrent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Power = distance / maxDrag (clamped 0-1)
        const maxDrag = 200;
        const power = Math.min(dist / maxDrag, 1);

        const angle = Math.atan2(dy, dx);

        // Dotted aim line from ball
        const lineLen = dist;
        g.lineStyle(2, 0x4ecdc4, 0.6);
        const steps = Math.floor(lineLen / 4);
        for (let i = 0; i < steps; i += 2) {
          const t = (i / steps);
          const px = this.ball.position.x - dx * t;
          const py = this.ball.position.y - dy * t;
          g.fillStyle(0x4ecdc4, 0.6);
          g.fillRect(px - 1, py - 1, 2, 2);
        }

        // Power meter
        this.drawPowerMeter(power);
      }
    }

    if (!pointer.isDown && this.isAiming) {
      // Release = shoot
      this.isAiming = false;
      this.powerMeterBg.clear();
      this.powerMeterFill.clear();

      if (this.ball) {
        const dx = this.ball.position.x - this.aimCurrent.x;
        const dy = this.ball.position.y - this.aimCurrent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDrag = 200;
        const power = Math.min(dist / maxDrag, 1);
        const angle = Math.atan2(dy, dx);

        if (dist > 5) { // Minimum drag to shoot
          this.shoot(angle, power);
        }
      }
    }
  }

  private drawPowerMeter(power: number) {
    const px = 270;
    const py = 330;
    const segW = 14;
    const segH = 14;
    const gap = 2;
    const totalSegs = 8;

    this.powerMeterBg.clear();
    this.powerMeterFill.clear();

    for (let i = 0; i < totalSegs; i++) {
      const x = px + i * (segW + gap);
      // Empty
      this.powerMeterBg.fillStyle(0x2a2a3e);
      this.powerMeterBg.fillRect(x, py, segW, segH);
    }

    const filled = Math.floor(power * totalSegs);
    for (let i = 0; i < filled; i++) {
      const x = px + i * (segW + gap);
      this.powerMeterFill.fillStyle(0xf2994a);
      this.powerMeterFill.fillRect(x, py, segW, segH);
    }
  }

  private shoot(angle: number, power: number) {
    this.strokeCount++;
    this.stillFrames = 0;
    this.strokeText.setText(`Stroke ${this.strokeCount}`);

    const impulse = powerToImpulse(power);
    this.ball.velocity.x = Math.cos(angle) * impulse;
    this.ball.velocity.y = Math.sin(angle) * impulse;

    // Check stroke limit
    if (this.strokeCount >= this.maxStrokes) {
      this.time.delayedCall(3000, () => this.onHoleComplete());
    }
  }

  private onHoleComplete() {
    if (this.holeDone) return;
    this.holeDone = true;
    this.turnText.setText('HOLE DONE!');

    // Fade ball out
    if (this.ball) {
      this.tweens.add({
        targets: this.ball,
        alpha: 0,
        duration: 300,
      });
    }

    // Emit to server
    this.time.delayedCall(500, () => {
      socket.emit('message', {
        type: 'hole_completed',
        playerId: 'local', // TODO: real playerId from network
        strokes: Math.min(this.strokeCount, this.maxStrokes),
        par: this.courseData.par,
      });
    });
  }
}
