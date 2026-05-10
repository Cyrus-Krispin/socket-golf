import Phaser from 'phaser';
import { powerToImpulse, isBallStopped, applyVelocity } from '../physics';
import { socket, localPlayerId, playerList } from '../network';

type Point = { x: number; y: number };

interface CourseData {
  name: string;
  par: number;
  worldWidth: number;
  worldHeight: number;
  tee: { x: number; y: number };
  hole: { x: number; y: number; visualRadius: number; triggerRadius: number };
  walls: { x: number; y: number; width: number; height: number; rotation?: number }[];
  fairway: { vertices: { x: number; y: number }[] };
}

interface GhostBall {
  body: MatterJS.BodyType;
  nametag: Phaser.GameObjects.Text;
  target: { x: number; y: number; vx: number; vy: number } | null;
}

interface SinkingBall {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  shadowAlpha: number;
}

const PHYSICS_STEP_MS = 1000 / 60;
const MAX_PHYSICS_STEPS = 4;
const BALL_RADIUS = 5;
const WALL_CATEGORY = 0x0001;
const OWN_BALL_CATEGORY = 0x0002;
const GHOST_CATEGORY = 0x0004;
const COURSE_EDGE_THICKNESS = 22;
const COURSE_EDGE_VISUAL_OFFSET = 8;
const HOLE_CAPTURE_SPEED = 0.68;
const HOLE_CAPTURE_FRAMES = 8;

export class GameScene extends Phaser.Scene {
  private holeIndex = 0;
  private courseData!: CourseData;
  private ball!: MatterJS.BodyType;
  private holeSensor!: MatterJS.BodyType;
  private strokeCount = 0;
  private stillFrames = 0;
  private isAiming = false;
  private aimStart = new Phaser.Math.Vector2();
  private aimCurrent = new Phaser.Math.Vector2();
  private graphics!: Phaser.GameObjects.Graphics;
  private aimLineGfx!: Phaser.GameObjects.Graphics;
  private holeText!: Phaser.GameObjects.Text;
  private strokeText!: Phaser.GameObjects.Text;
  private holeDone = false;
  private maxStrokes = 0;
  private remoteShotQueue: { playerId: string; angle: number; power: number }[] = [];
  private disconnectOverlay!: Phaser.GameObjects.Text;
  private waitingOverlay!: Phaser.GameObjects.Text;
  private reconnected = false;
  private ghostBalls = new Map<string, GhostBall>();
  private ballStateTimer = 0;
  private physicsAccumulator = 0;
  private holeCaptureFrames = 0;
  private holeCompletionSent = false;
  private sinkingBall: SinkingBall | null = null;
  private isPanning = false;
  private panStart = new Phaser.Math.Vector2();
  private camZoom = 1;
  private playersDone = new Set<string>();
  private holeNumber = 0;

  constructor() {
    super({ key: 'GameScene' });
  }

  preload() {
    this.load.json('hole1', '/courses/hole1.json');
    this.load.json('hole2', '/courses/hole2.json');
    this.load.json('hole3', '/courses/hole3.json');
  }

  init(data: { holeIndex: number }) {
    this.holeIndex = data.holeIndex ?? 0;
    this.strokeCount = 0;
    this.stillFrames = 60;
    this.holeDone = false;
    this.isAiming = false;
    this.remoteShotQueue = [];
    this.ghostBalls.clear();
    this.playersDone.clear();
    this.physicsAccumulator = 0;
    this.holeCaptureFrames = 0;
    this.holeCompletionSent = false;
    this.sinkingBall = null;
  }

  create() {
    this.cameras.main.setBackgroundColor('#102918');

    this.holeNumber = this.holeIndex + 1;
    this.courseData = this.cache.json.get(`hole${this.holeNumber}`) as CourseData;
    this.maxStrokes = this.courseData.par * 2 + 3;

    this.fitCameraToCourse(true);

    this.graphics = this.add.graphics();
    this.aimLineGfx = this.add.graphics();

    this.buildCourse();

    this.ball = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, BALL_RADIUS, {
      restitution: 0.96,
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0.012,
      density: 0.0025,
      label: 'ball',
      collisionFilter: {
        category: OWN_BALL_CATEGORY,
        mask: WALL_CATEGORY,
        group: 0,
      },
    });

    this.holeSensor = this.matter.add.circle(
      this.courseData.hole.x, this.courseData.hole.y,
      this.courseData.hole.triggerRadius,
      { isStatic: true, isSensor: true, label: 'hole' }
    );

    this.matter.world.setGravity(0, 0);

    // HUD positions are pinned to the camera view so zooming the course does not scale the UI away.
    const mono = { fontFamily: '"Courier New", monospace', fontSize: '12px', color: '#e0e0e0' };
    this.holeText = this.add.text(10, 8, `HOLE ${this.holeNumber}/3  Par ${this.courseData.par}`, {
      ...mono, fontSize: '13px', color: '#d9f2d2',
      backgroundColor: '#07140dcc',
      padding: { x: 10, y: 6 },
    }).setDepth(100);

    this.strokeText = this.add.text(0, 8, 'Stroke 0', {
      ...mono, fontSize: '13px', color: '#d9f2d2',
      backgroundColor: '#07140dcc',
      padding: { x: 10, y: 6 },
    }).setOrigin(0, 0).setDepth(100);

    // Waiting overlay
    this.waitingOverlay = this.add.text(0, 0, '', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '16px', color: '#e0e0e0', backgroundColor: '#000000aa',
      padding: { x: 20, y: 12 },
    }).setOrigin(0.5).setDepth(100).setAlpha(0);

    // Disconnect overlay
    this.disconnectOverlay = this.add.text(0, 0, '', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '16px', color: '#eb5757', backgroundColor: '#000000cc',
      padding: { x: 20, y: 12 },
    }).setOrigin(0.5).setDepth(100).setAlpha(0);

    this.updateHUDPositions();

    // Create ghost balls for other players
    this.createGhostBalls();

    // Connection events
    socket.off('disconnect');
    socket.off('connect');
    socket.on('disconnect', () => {
      this.disconnectOverlay.setText('Connection lost...\nReconnecting...');
      this.disconnectOverlay.setAlpha(1);
    });
    socket.on('connect', () => {
      if (this.disconnectOverlay.alpha > 0) {
        this.disconnectOverlay.setText('Reconnected!');
        this.disconnectOverlay.setColor('#6fcf97');
        this.time.delayedCall(1500, () => this.disconnectOverlay.setAlpha(0));
      }
    });

    // Scroll wheel zoom
    this.input.on('wheel', (_pointer: any, _gos: any, _dx: number, dy: number) => {
      this.camZoom = Phaser.Math.Clamp(this.camZoom - dy * 0.001, 0.4, 1.5);
      this.cameras.main.setZoom(this.camZoom);
    });

    const resizeGame = () => {
      if (!this.cameras.main) return;
      this.fitCameraToCourse(false);
      this.updateHUDPositions();
    };
    this.scale.on('resize', resizeGame);
    this.events.once('shutdown', () => {
      this.scale.off('resize', resizeGame);
    });

    this.setupSocketListeners();
    this.drawCourse();
  }

  private createGhostBalls() {
    for (const p of playerList) {
      if (p.id === localPlayerId) continue;
      this.addGhostBall(p.id, p.name);
    }
  }

  private addGhostBall(playerId: string, playerName: string) {
    const gb = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, BALL_RADIUS, {
      restitution: 0.96,
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0.012,
      density: 0.0025,
      label: 'ghost',
      collisionFilter: {
        category: GHOST_CATEGORY,
        mask: WALL_CATEGORY,
        group: 0,
      },
    });

    const nametag = this.add.text(0, 0, playerName, {
      fontFamily: '"Courier New", monospace',
      fontSize: '12px',
      color: '#f0c060',
      backgroundColor: '#00000088',
      padding: { x: 6, y: 2 },
    }).setOrigin(0.5, 1).setDepth(90);

    this.ghostBalls.set(playerId, { body: gb, nametag, target: null });
  }

  private fitCameraToCourse(center: boolean) {
    const cam = this.cameras.main;
    const padding = 52;
    const fitX = cam.width / (this.courseData.worldWidth + padding * 2);
    const fitY = cam.height / (this.courseData.worldHeight + padding * 2);
    this.camZoom = Phaser.Math.Clamp(Math.min(fitX, fitY) * 0.82, 0.28, 1.55);
    cam.setZoom(this.camZoom);
    cam.setBounds(
      -padding,
      -padding,
      this.courseData.worldWidth + padding * 2,
      this.courseData.worldHeight + padding * 2
    );

    if (center) {
      cam.centerOn(this.courseData.worldWidth / 2, this.courseData.worldHeight / 2);
    }
  }

  private buildCourse() {
    const ww = this.courseData.worldWidth;
    const wh = this.courseData.worldHeight;
    this.addFairwayCurbs();

    for (const w of this.courseData.walls) {
      this.addStaticWall(w.x, w.y, w.width, w.height, w.rotation ?? 0, 'wall');
    }

    this.addStaticWall(ww / 2, -18, ww + 60, 36, 0, 'world-bound');
    this.addStaticWall(ww / 2, wh + 18, ww + 60, 36, 0, 'world-bound');
    this.addStaticWall(-18, wh / 2, 36, wh + 60, 0, 'world-bound');
    this.addStaticWall(ww + 18, wh / 2, 36, wh + 60, 0, 'world-bound');
  }

  private addFairwayCurbs() {
    const verts = this.courseData.fairway.vertices;
    if (verts.length < 3) return;

    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const length = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
      const angle = Phaser.Math.Angle.Between(a.x, a.y, b.x, b.y);
      this.addStaticWall(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        length + COURSE_EDGE_THICKNESS,
        COURSE_EDGE_THICKNESS,
        angle,
        'course-edge'
      );
    }
  }

  private addStaticWall(
    x: number,
    y: number,
    width: number,
    height: number,
    angle: number,
    label: string
  ) {
    return this.matter.add.rectangle(x, y, width, height, {
      isStatic: true,
      angle,
      label,
      restitution: 0.96,
      friction: 0,
      frictionStatic: 0,
      collisionFilter: {
        category: WALL_CATEGORY,
        mask: 0xffffffff,
      },
    });
  }

  private setupSocketListeners() {
    socket.off('message');
    socket.on('message', (msg: any) => {
      switch (msg.type) {
        case 'shot_taken':
          this.onRemoteShot(msg.shot.playerId, msg.shot.angle, msg.shot.power);
          break;
        case 'ball_state':
          this.onBallState(msg.playerId, msg.x, msg.y, msg.vx, msg.vy);
          break;
        case 'hole_completed':
          this.playersDone.add(msg.playerId);
          this.updateWaitingOverlay();
          break;
        case 'score_update':
          this.scene.start('ScoreboardScene', { scores: msg.scores, isFinal: false });
          break;
        case 'game_ended':
          this.scene.start('ScoreboardScene', { scores: msg.finalScores, isFinal: true });
          break;
      }
    });
  }

  private onRemoteShot(playerId: string, angle: number, power: number) {
    const gb = this.ghostBalls.get(playerId);
    if (!gb) return;
    this.remoteShotQueue.push({ playerId, angle, power });
  }

  private applyRemoteShot(playerId: string, angle: number, power: number) {
    const gb = this.ghostBalls.get(playerId);
    if (!gb || !gb.body) return;
    const impulse = powerToImpulse(power);
    applyVelocity(gb.body, Math.cos(angle) * impulse, Math.sin(angle) * impulse);
  }

  private onBallState(playerId: string, x: number, y: number, vx: number, vy: number) {
    const gb = this.ghostBalls.get(playerId);
    if (!gb) return;
    gb.target = { x, y, vx, vy };
  }

  private updateWaitingOverlay() {
    const doneCount = this.playersDone.size;
    const total = 1 + this.ghostBalls.size; // me + others
    if (this.holeDone) {
      this.waitingOverlay.setText(`Hole finished!\nWaiting for others (${doneCount}/${total})`);
      this.waitingOverlay.setAlpha(1);
    }
  }

  private updateHUDPositions() {
    const cam = this.cameras.main;
    const view = cam.worldView;
    const invZoom = 1 / cam.zoom;
    this.holeText.setScale(invZoom).setPosition(view.x + 14 * invZoom, view.y + 12 * invZoom);
    this.strokeText.setScale(invZoom).setPosition(view.x + 14 * invZoom, view.y + 42 * invZoom);
    this.waitingOverlay.setScale(invZoom).setPosition(view.centerX, view.centerY);
    this.disconnectOverlay.setScale(invZoom).setPosition(view.centerX, view.centerY + 44 * invZoom);
  }

  private updateTurnUI() { /* no-op — removed turn-based UI */ }

  private drawCourse() {
    const g = this.graphics;
    g.clear();

    this.drawRoughTexture(g);
    this.drawFairway(g);

    for (const w of this.courseData.walls) {
      this.drawWall(g, w);
    }

    this.drawTee(g);
    this.drawHole(g);

    if (this.ball) {
      this.drawBall(g, this.ball.position.x, this.ball.position.y, BALL_RADIUS, 0xf7f4df, 0xd5d0b8);
    }

    if (this.sinkingBall) {
      this.drawBall(
        g,
        this.sinkingBall.x,
        this.sinkingBall.y,
        this.sinkingBall.radius,
        0xf7f4df,
        0xd5d0b8,
        this.sinkingBall.alpha,
        this.sinkingBall.shadowAlpha
      );
    }

    this.ghostBalls.forEach((gb) => {
      if (!gb.body) return;
      const bx = gb.body.position.x;
      const by = gb.body.position.y;
      this.drawBall(g, bx, by, BALL_RADIUS, 0xf5d66f, 0xb8902f, 0.92, 0.2);
      gb.nametag.setPosition(bx, by - 16);
    });
  }

  private drawFairway(g: Phaser.GameObjects.Graphics) {
    const verts = this.courseData.fairway.vertices;
    if (verts.length < 3) return;

    this.drawFilledPolygon(g, verts, 0x07170c, 0.55, 0, 18);
    this.drawStrokedPolygon(g, verts, COURSE_EDGE_THICKNESS + 8, 0x08180d, 0.65, 0, 16);
    this.drawStrokedPolygon(g, verts, COURSE_EDGE_THICKNESS + 2, 0x5c472b, 1, 0, COURSE_EDGE_VISUAL_OFFSET);
    this.drawStrokedPolygon(g, verts, COURSE_EDGE_THICKNESS - 8, 0x263b21, 1, 0, 2);
    this.drawFilledPolygon(g, verts, 0x42ad5d);
    this.drawFairwayTexture(g);
    this.drawStrokedPolygon(g, verts, 3, 0x94df85, 0.55);
  }

  private drawTee(g: Phaser.GameObjects.Graphics) {
    g.fillStyle(0xd4b45a);
    g.fillEllipse(this.courseData.tee.x + 2, this.courseData.tee.y + 5, 38, 18);
    g.fillStyle(0xe3c871);
    g.lineStyle(2, 0x9d7b35, 0.9);
    g.fillEllipse(this.courseData.tee.x, this.courseData.tee.y, 38, 18);
    g.strokeEllipse(this.courseData.tee.x, this.courseData.tee.y, 38, 18);
  }

  private drawHole(g: Phaser.GameObjects.Graphics) {
    const hx = this.courseData.hole.x;
    const hy = this.courseData.hole.y;
    const hr = this.courseData.hole.visualRadius;
    g.fillStyle(0x000000, 0.24);
    g.fillEllipse(hx + 2, hy + 7, hr * 3.2, hr * 1.35);
    g.fillStyle(0x22331e);
    g.fillCircle(hx, hy, hr + 6);
    g.fillStyle(0x050705);
    g.fillCircle(hx, hy, hr + 1);
    g.lineStyle(2, 0xb7d8a5, 0.42);
    g.strokeCircle(hx - 1, hy - 1, hr + 3);

    if (this.sinkingBall) {
      const pulse = 1 - this.sinkingBall.alpha;
      g.lineStyle(2, 0xd7f1cf, 0.42 * this.sinkingBall.alpha);
      g.strokeCircle(hx, hy, hr + 7 + pulse * 5);
    }

    g.lineStyle(2, 0xf4f1de, 0.9);
    g.beginPath();
    g.moveTo(hx + 2, hy - 2);
    g.lineTo(hx + 2, hy - 34);
    g.strokePath();
    g.fillStyle(0xd34f39);
    g.fillTriangle(hx + 3, hy - 34, hx + 22, hy - 28, hx + 3, hy - 22);
    g.lineStyle(1, 0x7d221d, 0.8);
    g.strokeTriangle(hx + 3, hy - 34, hx + 22, hy - 28, hx + 3, hy - 22);
  }

  private drawWall(g: Phaser.GameObjects.Graphics, wall: CourseData['walls'][number]) {
    const angle = wall.rotation ?? 0;
    const top = this.rotatedRectPoints(wall.x, wall.y, wall.width, wall.height, angle);
    const low = this.rotatedRectPoints(wall.x, wall.y, wall.width, wall.height, angle, 0, 8);

    this.drawFilledPolygon(g, low, 0x150f0a, 0.35, 2, 3);
    this.drawFilledPolygon(g, [top[1], top[2], low[2], low[1]], 0x3e2a19);
    this.drawFilledPolygon(g, [top[2], top[3], low[3], low[2]], 0x2f2015);
    this.drawFilledPolygon(g, top, 0x725336);
    this.drawLine(g, top[0], top[1], 2, 0xa98758, 0.95);
    this.drawLine(g, top[0], top[3], 2, 0x9a764b, 0.85);
    this.drawStrokedPolygon(g, top, 1, 0x21160f, 0.7);
  }

  private drawBall(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    radius: number,
    fill: number,
    stroke: number,
    alpha = 1,
    shadowAlpha = 0.28
  ) {
    g.fillStyle(0x000000, shadowAlpha);
    g.fillEllipse(x + 3, y + 6, radius * 2.2, radius * 0.85);
    g.fillStyle(fill, alpha);
    g.fillCircle(x, y, radius);
    g.lineStyle(1, stroke, alpha);
    g.strokeCircle(x, y, radius);
    g.fillStyle(0xffffff, alpha * 0.68);
    g.fillCircle(x - radius * 0.33, y - radius * 0.35, Math.max(1, radius * 0.28));
  }

  private drawRoughTexture(g: Phaser.GameObjects.Graphics) {
    g.fillStyle(0x183f20, 0.55);
    for (let y = 18; y < this.courseData.worldHeight; y += 38) {
      for (let x = 18 + ((y / 38) % 2) * 16; x < this.courseData.worldWidth; x += 44) {
        g.fillRect(x, y, 10, 1);
      }
    }
  }

  private drawFairwayTexture(g: Phaser.GameObjects.Graphics) {
    const verts = this.courseData.fairway.vertices;
    g.fillStyle(0xb7ef9a, 0.12);
    for (let y = 44; y < this.courseData.worldHeight; y += 34) {
      for (let x = 44; x < this.courseData.worldWidth; x += 44) {
        if (!this.pointInPolygon(x, y, verts)) continue;
        g.fillRect(x - 8, y, 16, 1);
        g.fillRect(x + 2, y + 8, 12, 1);
      }
    }
  }

  private drawFilledPolygon(
    g: Phaser.GameObjects.Graphics,
    points: Point[],
    color: number,
    alpha = 1,
    dx = 0,
    dy = 0
  ) {
    if (!points.length) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(points[0].x + dx, points[0].y + dy);
    for (let i = 1; i < points.length; i++) {
      g.lineTo(points[i].x + dx, points[i].y + dy);
    }
    g.closePath();
    g.fillPath();
  }

  private drawStrokedPolygon(
    g: Phaser.GameObjects.Graphics,
    points: Point[],
    width: number,
    color: number,
    alpha = 1,
    dx = 0,
    dy = 0
  ) {
    if (!points.length) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(points[0].x + dx, points[0].y + dy);
    for (let i = 1; i < points.length; i++) {
      g.lineTo(points[i].x + dx, points[i].y + dy);
    }
    g.closePath();
    g.strokePath();
  }

  private drawLine(
    g: Phaser.GameObjects.Graphics,
    a: Point,
    b: Point,
    width: number,
    color: number,
    alpha = 1
  ) {
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.strokePath();
  }

  private rotatedRectPoints(
    x: number,
    y: number,
    width: number,
    height: number,
    angle: number,
    dx = 0,
    dy = 0
  ): Point[] {
    const hw = width / 2;
    const hh = height / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ].map((p) => ({
      x: x + dx + p.x * cos - p.y * sin,
      y: y + dy + p.x * sin + p.y * cos,
    }));
  }

  private pointInPolygon(x: number, y: number, points: Point[]) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const pi = points[i];
      const pj = points[j];
      const intersects = ((pi.y > y) !== (pj.y > y))
        && (x < (pj.x - pi.x) * (y - pi.y) / (pj.y - pi.y) + pi.x);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  update(_t: number, delta: number) {
    for (const shot of this.remoteShotQueue) {
      this.applyRemoteShot(shot.playerId, shot.angle, shot.power);
    }
    this.remoteShotQueue = [];

    this.stepPhysics(delta);
    this.updateGhostTargets();

    if (this.ball && !this.holeDone) {
      this.updateBallStoppedState();
      this.evaluateHoleCapture();
    }

    if (!this.holeDone) {
      this.handleInput();
    } else {
      this.aimLineGfx.clear();
    }

    this.emitMovingBallState(delta);
    this.updateHUDPositions();
    this.drawCourse();
  }

  private stepPhysics(delta: number) {
    this.physicsAccumulator = Math.min(
      this.physicsAccumulator + delta,
      PHYSICS_STEP_MS * MAX_PHYSICS_STEPS
    );

    while (this.physicsAccumulator >= PHYSICS_STEP_MS) {
      this.matter.world.step(PHYSICS_STEP_MS);
      this.physicsAccumulator -= PHYSICS_STEP_MS;
    }
  }

  private updateGhostTargets() {
    // Gentle position correction for ghost balls — no velocity impulse
    this.ghostBalls.forEach((gb) => {
      if (!gb.target || !gb.body) return;
      const dx = gb.target.x - gb.body.position.x;
      const dy = gb.target.y - gb.body.position.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        const lerp = 0.08;
        const nx = gb.body.position.x + dx * lerp;
        const ny = gb.body.position.y + dy * lerp;
        this.moveBody(gb.body, nx, ny, gb.body.velocity.x, gb.body.velocity.y);
      }
    });
  }

  private updateBallStoppedState() {
    if (!this.ball) return;
    const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
    if (vel < 0.01) {
      this.stillFrames++;
    } else {
      this.stillFrames = 0;
    }
  }

  private evaluateHoleCapture() {
    if (!this.ball) return;

    const hx = this.courseData.hole.x;
    const hy = this.courseData.hole.y;
    const dx = hx - this.ball.position.x;
    const dy = hy - this.ball.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const speed = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
    const captureZone = this.courseData.hole.triggerRadius * 1.2;

    if (dist < captureZone && speed < 1.1 && dist > 0.1) {
      const pull = Phaser.Math.Clamp((captureZone - dist) / captureZone, 0, 1) * 0.09;
      this.moveBody(
        this.ball,
        this.ball.position.x + dx * pull,
        this.ball.position.y + dy * pull,
        this.ball.velocity.x * 0.82,
        this.ball.velocity.y * 0.82
      );
    }

    if (dist < this.courseData.hole.visualRadius + BALL_RADIUS * 0.75 && speed < HOLE_CAPTURE_SPEED) {
      this.holeCaptureFrames++;
      if (this.holeCaptureFrames >= HOLE_CAPTURE_FRAMES) {
        this.onHoleComplete(true);
      }
    } else {
      this.holeCaptureFrames = 0;
    }
  }

  private emitMovingBallState(delta: number) {
    if (!this.ball) return;
    this.ballStateTimer += delta;
    if (this.ballStateTimer > 100) {
      this.ballStateTimer = 0;
      const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
      if (vel > 0.01) {
        this.emitBallState();
      }
    }
  }

  private moveBody(body: MatterJS.BodyType, x: number, y: number, vx: number, vy: number) {
    (body as any).position.x = x;
    (body as any).position.y = y;
    (body as any).positionPrev.x = x - vx;
    (body as any).positionPrev.y = y - vy;
    (body as any).velocity.x = vx;
    (body as any).velocity.y = vy;
    (body as any).speed = Math.sqrt(vx * vx + vy * vy);
  }

  private handleInput() {
    const ptr = this.input.activePointer;
    if (!this.ball) return;

    this.aimLineGfx.clear();

    const worldPtr = this.cameras.main.getWorldPoint(ptr.x, ptr.y);

    const ballDist = Math.sqrt(
      (worldPtr.x - this.ball.position.x) ** 2 + (worldPtr.y - this.ball.position.y) ** 2
    );

    const BALL_CLICK_RADIUS = 35;
    const MIN_SHOT_DIST = 12;
    const MIN_LINE_DIST = 8;
    const MAX_DRAG_BASE = 200;
    const velocity = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);

    if (ptr.isDown && !this.isAiming && !this.isPanning) {
      if (ballDist < BALL_CLICK_RADIUS && isBallStopped(velocity, this.stillFrames)) {
        this.isAiming = true;
        this.aimStart.set(worldPtr.x, worldPtr.y);
      } else {
        this.isPanning = true;
        this.panStart.set(ptr.x, ptr.y);
      }
    }

    if (ptr.isDown && this.isAiming) {
      const worldCurrent = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
      this.aimCurrent.set(worldCurrent.x, worldCurrent.y);
      const dx = this.ball.position.x - this.aimCurrent.x;
      const dy = this.ball.position.y - this.aimCurrent.y;
      const dragDist = Math.sqrt(dx * dx + dy * dy);
      const maxDrag = MAX_DRAG_BASE / this.camZoom;
      const power = Math.min(dragDist / maxDrag, 1);

      if (dragDist >= MIN_LINE_DIST) {
        const angle = Math.atan2(dy, dx);
        const g = this.aimLineGfx;
        const maxDots = 40;
        const dotSpacing = 5;
        const dotCount = Math.floor(power * maxDots);

        g.fillStyle(0x4ecdc4, 0.7);
        for (let i = 0; i < dotCount; i++) {
          const px = this.ball.position.x + Math.cos(angle) * i * dotSpacing;
          const py = this.ball.position.y + Math.sin(angle) * i * dotSpacing;
          g.fillRect(px - 1.5, py - 1.5, 3, 3);
        }
      }
    }

    if (ptr.isDown && this.isPanning) {
      const dx = (ptr.x - this.panStart.x) / this.camZoom;
      const dy = (ptr.y - this.panStart.y) / this.camZoom;
      this.panStart.set(ptr.x, ptr.y);
      this.cameras.main.scrollX -= dx;
      this.cameras.main.scrollY -= dy;
    }

    if (!ptr.isDown && this.isAiming) {
      this.isAiming = false;
      this.aimLineGfx.clear();
      if (!this.ball) return;

      const dx = this.ball.position.x - this.aimCurrent.x;
      const dy = this.ball.position.y - this.aimCurrent.y;
      const dragDist = Math.sqrt(dx * dx + dy * dy);
      if (dragDist < MIN_SHOT_DIST) return;

      const maxDrag = MAX_DRAG_BASE / this.camZoom;
      const power = Math.min(dragDist / maxDrag, 1);
      const angle = Math.atan2(dy, dx);

      this.shoot(angle, power);
    }

    if (!ptr.isDown && this.isPanning) {
      this.isPanning = false;
    }
  }

  private shoot(angle: number, power: number) {
    if (this.holeDone) return;
    this.strokeCount++;
    this.stillFrames = 0;
    this.strokeText.setText(`Stroke ${this.strokeCount}`);

    const impulse = powerToImpulse(power);
    applyVelocity(this.ball, Math.cos(angle) * impulse, Math.sin(angle) * impulse);

    socket.emit('message', {
      type: 'shot_taken',
      shot: {
        playerId: localPlayerId,
        playerName: playerList.find(p => p.id === localPlayerId)?.name ?? 'Player',
        ballOrigin: { x: this.ball.position.x, y: this.ball.position.y },
        angle,
        power,
        strokeNumber: this.strokeCount,
      },
    });

    if (this.strokeCount >= this.maxStrokes) {
      this.time.delayedCall(4000, () => this.onHoleComplete(false));
    }
  }

  private emitBallState() {
    if (!this.ball || !localPlayerId) return;
    socket.emit('message', {
      type: 'ball_state',
      playerId: localPlayerId,
      x: this.ball.position.x,
      y: this.ball.position.y,
      vx: this.ball.velocity.x,
      vy: this.ball.velocity.y,
    });
  }

  private onHoleComplete(animate: boolean) {
    if (this.holeDone) return;
    this.holeDone = true;
    this.isAiming = false;
    this.isPanning = false;
    this.aimLineGfx.clear();

    if (animate && this.ball) {
      this.sinkingBall = {
        x: this.ball.position.x,
        y: this.ball.position.y,
        radius: BALL_RADIUS,
        alpha: 1,
        shadowAlpha: 0.28,
      };
      this.matter.world.remove(this.ball);
      (this.ball as any) = null;
      this.tweens.add({
        targets: this.sinkingBall,
        x: this.courseData.hole.x,
        y: this.courseData.hole.y,
        radius: 0.8,
        alpha: 0.08,
        shadowAlpha: 0,
        duration: 460,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          this.sinkingBall = null;
          this.finishHole();
        },
      });
      return;
    }

    if (this.ball) this.matter.world.remove(this.ball);
    (this.ball as any) = null;
    this.finishHole();
  }

  private finishHole() {
    if (this.holeCompletionSent) return;
    if (!localPlayerId) return;
    this.holeCompletionSent = true;
    this.playersDone.add(localPlayerId);

    socket.emit('message', {
      type: 'hole_completed',
      playerId: localPlayerId,
      strokes: Math.min(this.strokeCount, this.maxStrokes),
      par: this.courseData.par,
    });

    this.updateWaitingOverlay();
  }
}
