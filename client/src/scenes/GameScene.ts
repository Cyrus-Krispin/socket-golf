import Phaser from 'phaser';
import { powerToImpulse, isBallStopped, applyVelocity } from '../physics';
import { socket, localPlayerId, playerList } from '../network';

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
  private pmBg!: Phaser.GameObjects.Graphics;
  private pmFill!: Phaser.GameObjects.Graphics;
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
  private isPanning = false;
  private panStart = new Phaser.Math.Vector2();
  private camZoom = 1;
  private playersDone = new Set<string>();
  private ownBallCategory = 0x0001;
  private ghostCategory = 0x0002;
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
  }

  create() {
    this.cameras.main.setBackgroundColor('#1a4020');

    this.holeNumber = this.holeIndex + 1;
    this.courseData = this.cache.json.get(`hole${this.holeNumber}`) as CourseData;
    this.maxStrokes = this.courseData.par * 2 + 3;

    // Camera setup
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.courseData.worldWidth, this.courseData.worldHeight);
    cam.centerOn(this.courseData.tee.x, this.courseData.tee.y);
    this.camZoom = 1;
    cam.setZoom(this.camZoom);

    this.graphics = this.add.graphics();
    this.pmBg = this.add.graphics();
    this.pmFill = this.add.graphics();

    this.buildCourse();

    // Own ball — category 0x0001
    this.ball = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, 4, {
      restitution: 0.85,
      friction: 0.05,
      frictionAir: 0.01,
      density: 0.003,
      label: 'ball',
      collisionFilter: {
        category: this.ownBallCategory,
        mask: 0x0001, // only collide with walls, NOT ghost balls
        group: 0,
      },
    });

    this.holeSensor = this.matter.add.circle(
      this.courseData.hole.x, this.courseData.hole.y,
      this.courseData.hole.triggerRadius,
      { isStatic: true, isSensor: true, label: 'hole' }
    );

    this.matter.world.setGravity(0, 0);

    // Hole detection
    this.matter.world.on('collisionstart', (_e: any, a: MatterJS.BodyType, b: MatterJS.BodyType) => {
      if (this.holeDone || !this.ball) return;
      const hasBall = a.label === 'ball' || b.label === 'ball';
      const hasHole = a.label === 'hole' || b.label === 'hole';
      if (hasBall && hasHole) {
        const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
        if (vel < 0.5) this.onHoleComplete();
      }
    });

    // HUD — all with scrollFactor(0) so they stay fixed on screen
    const mono = { fontFamily: '"Courier New", monospace', fontSize: '12px', color: '#e0e0e0' };
    this.holeText = this.add.text(10, 8, `HOLE ${this.holeNumber}/3  Par ${this.courseData.par}`, {
      ...mono, fontSize: '10px', color: '#888',
    }).setScrollFactor(0);

    this.strokeText = this.add.text(630, 8, 'Stroke 0', {
      ...mono, fontSize: '10px', color: '#888',
    }).setOrigin(1, 0).setScrollFactor(0);

    // Waiting overlay
    this.waitingOverlay = this.add.text(320, 320, '', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '12px', color: '#e0e0e0', backgroundColor: '#000000aa',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setDepth(100).setScrollFactor(0).setAlpha(0);

    // Disconnect overlay
    this.disconnectOverlay = this.add.text(320, 360, '', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '12px', color: '#eb5757', backgroundColor: '#000000cc',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setDepth(100).setScrollFactor(0).setAlpha(0);

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
    const gb = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, 4, {
      restitution: 0.85,
      friction: 0.05,
      frictionAir: 0.01,
      density: 0.003,
      label: 'ghost',
      collisionFilter: {
        category: this.ghostCategory,
        mask: 0x0001, // only collide with walls (category 0x0001), NOT own ball
        group: 0,
      },
    });

    const nametag = this.add.text(0, 0, playerName, {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: '#f0c060',
      backgroundColor: '#00000088',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(90);

    this.ghostBalls.set(playerId, { body: gb, nametag, target: null });
  }

  private buildCourse() {
    const ww = this.courseData.worldWidth;
    const wh = this.courseData.worldHeight;
    for (const w of this.courseData.walls) {
      this.matter.add.rectangle(w.x, w.y, w.width, w.height, {
        isStatic: true, angle: w.rotation ?? 0, label: 'wall',
      });
    }
    // World bounds
    this.matter.add.rectangle(ww / 2, -10, ww + 40, 20, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(ww / 2, wh + 10, ww + 40, 20, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(-10, wh / 2, 20, wh + 40, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(ww + 10, wh / 2, 20, wh + 40, { isStatic: true, label: 'wall' });
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

  private updateTurnUI() { /* no-op — removed turn-based UI */ }

  private drawCourse() {
    const g = this.graphics;
    g.clear();

    // Rough — dark green background
    g.fillStyle(0x1a4020);
    g.fillRect(0, 0, 640, 640);

    const verts = this.courseData.fairway.vertices;
    if (verts.length > 2) {
      g.fillStyle(0x1e5a28);
      g.beginPath();
      g.moveTo(verts[0].x + 3, verts[0].y + 3);
      for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x + 3, verts[i].y + 3);
      g.closePath();
      g.fillPath();

      g.fillStyle(0x3aaa5e);
      g.lineStyle(1, 0x2a8040);
      g.beginPath();
      g.moveTo(verts[0].x, verts[0].y);
      for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x, verts[i].y);
      g.closePath();
      g.fillPath();
      g.strokePath();
    }

    for (const w of this.courseData.walls) {
      const wx = w.x - w.width / 2;
      const wy = w.y - w.height / 2;
      g.fillStyle(0x5a3015);
      g.fillRect(wx, wy, w.width, w.height);
      g.lineStyle(2, 0x7a5035);
      g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + w.width, wy); g.strokePath();
      g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx, wy + w.height); g.strokePath();
    }

    g.fillStyle(0xd4b45a);
    g.lineStyle(1, 0xa08040);
    g.fillCircle(this.courseData.tee.x, this.courseData.tee.y, 5);
    g.strokeCircle(this.courseData.tee.x, this.courseData.tee.y, 5);

    const hx = this.courseData.hole.x;
    const hy = this.courseData.hole.y;
    const hr = this.courseData.hole.visualRadius;
    g.fillStyle(0x0a1208);
    g.fillCircle(hx, hy, hr);
    g.lineStyle(8, 0x222222);
    g.strokeCircle(hx, hy, hr + 1);
    g.lineStyle(1, 0xcccccc);
    g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx, hy - 16); g.strokePath();
    g.fillStyle(0xcc4444);
    g.fillTriangle(hx, hy - 16, hx + 7, hy - 13, hx, hy - 10);

    // Own ball
    if (this.ball) {
      const bx = this.ball.position.x;
      const by = this.ball.position.y;
      g.fillStyle(0x000000, 0.25);
      g.fillCircle(bx + 2, by + 2, 4);
      g.fillStyle(0xf0f0f0);
      g.lineStyle(1, 0xaaaaaa);
      g.fillCircle(bx, by, 4);
      g.strokeCircle(bx, by, 4);
    }

    // Ghost balls
    this.ghostBalls.forEach((gb) => {
      if (!gb.body) return;
      const bx = gb.body.position.x;
      const by = gb.body.position.y;
      g.fillStyle(0x000000, 0.25);
      g.fillCircle(bx + 2, by + 2, 4);
      g.fillStyle(0xf0d060, 0.9);
      g.lineStyle(1, 0xc0a040);
      g.fillCircle(bx, by, 4);
      g.strokeCircle(bx, by, 4);

      // Nametag follows ghost ball in world space
      gb.nametag.setPosition(bx, by - 14);
    });
  }

  update(_t: number, _delta: number) {
    if (this.holeDone && this.ball) {
      this.matter.world.remove(this.ball);
      (this.ball as any) = null;
    }

    // Fixed timestep
    this.matter.world.step(1000 / 60);

    // Apply queued remote shots
    for (const shot of this.remoteShotQueue) {
      this.applyRemoteShot(shot.playerId, shot.angle, shot.power);
    }
    this.remoteShotQueue = [];

    // Lerp ghost balls toward received positions
    this.ghostBalls.forEach((gb) => {
      if (!gb.target || !gb.body) return;
      const dx = gb.target.x - gb.body.position.x;
      const dy = gb.target.y - gb.body.position.y;
      if (Math.sqrt(dx * dx + dy * dy) > 1) {
        applyVelocity(
          gb.body,
          gb.body.velocity.x + dx * 0.3,
          gb.body.velocity.y + dy * 0.3,
        );
      }
      gb.target = null; // consume each frame
    });

    // Ball stopped detection (own ball)
    if (this.ball) {
      const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
      if (vel < 0.01) {
        this.stillFrames++;
      } else {
        this.stillFrames = 0;
      }
    }

    // Handle input
    if (!this.holeDone) {
      this.handleInput();
    }

    // Periodically send ball state
    if (this.ball) {
      this.ballStateTimer += _delta;
      if (this.ballStateTimer > 100) {
        this.ballStateTimer = 0;
        const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
        if (vel > 0.01) {
          this.emitBallState();
        }
      }
    }

    this.drawCourse();
  }

  private handleInput() {
    const ptr = this.input.activePointer;
    if (!this.ball) return;

    // Convert screen coords to world coords
    const worldPtr = this.cameras.main.getWorldPoint(ptr.x, ptr.y);

    // Distance from pointer (world) to own ball
    const ballDist = Math.sqrt(
      (worldPtr.x - this.ball.position.x) ** 2 + (worldPtr.y - this.ball.position.y) ** 2
    );

    if (ptr.isDown && !this.isAiming && !this.isPanning) {
      if (ballDist < 20 && this.stillFrames >= 60) {
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
      const maxDrag = 200 / this.camZoom;
      const power = Math.min(dragDist / maxDrag, 1);

      const g = this.graphics;
      const steps = Math.floor(dragDist / 4);
      g.fillStyle(0x4ecdc4, 0.6);
      for (let i = 0; i < steps; i += 2) {
        const t = (i / steps);
        g.fillRect(this.ball.position.x - dx * t - 1, this.ball.position.y - dy * t - 1, 2, 2);
      }

      this.drawPowerMeter(power);
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
      this.pmBg.clear(); this.pmFill.clear();
      if (!this.ball) return;

      const dx = this.ball.position.x - this.aimCurrent.x;
      const dy = this.ball.position.y - this.aimCurrent.y;
      const dragDist = Math.sqrt(dx * dx + dy * dy);
      if (dragDist < 5) return;

      const maxDrag = 200 / this.camZoom;
      const power = Math.min(dragDist / maxDrag, 1);
      const angle = Math.atan2(dy, dx);

      this.shoot(angle, power);
    }

    if (!ptr.isDown && this.isPanning) {
      this.isPanning = false;
    }
  }

  private drawPowerMeter(power: number) {
    const px = 252, py = 592, sw = 14, sh = 14, gap = 2, total = 8;
    this.pmBg.clear(); this.pmFill.clear();
    for (let i = 0; i < total; i++) {
      this.pmBg.fillStyle(0x2a2a3e);
      this.pmBg.fillRect(px + i * (sw + gap), py, sw, sh);
    }
    const filled = Math.floor(power * total);
    for (let i = 0; i < filled; i++) {
      this.pmFill.fillStyle(0xf2994a);
      this.pmFill.fillRect(px + i * (sw + gap), py, sw, sh);
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
      this.time.delayedCall(4000, () => this.onHoleComplete());
    }
  }

  private emitBallState() {
    if (!this.ball) return;
    socket.emit('message', {
      type: 'ball_state',
      playerId: localPlayerId,
      x: this.ball.position.x,
      y: this.ball.position.y,
      vx: this.ball.velocity.x,
      vy: this.ball.velocity.y,
    });
  }

  private onHoleComplete() {
    if (this.holeDone) return;
    this.holeDone = true;
    if (this.ball) this.matter.world.remove(this.ball);
    (this.ball as any) = null;

    socket.emit('message', {
      type: 'hole_completed',
      playerId: localPlayerId,
      strokes: Math.min(this.strokeCount, this.maxStrokes),
      par: this.courseData.par,
    });

    this.updateWaitingOverlay();
  }
}
