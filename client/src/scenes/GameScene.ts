import Phaser from 'phaser';
import { powerToImpulse, isBallStopped, isBallInHole, applyVelocity } from '../physics';
import { socket, localPlayerId, activePlayerId, setTurn, currentHole, playerList } from '../network';

interface CourseData {
  name: string;
  par: number;
  tee: { x: number; y: number };
  hole: { x: number; y: number; visualRadius: number; triggerRadius: number };
  walls: { x: number; y: number; width: number; height: number; rotation?: number }[];
  fairway: { vertices: { x: number; y: number }[] };
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
  private turnText!: Phaser.GameObjects.Text;
  private strokeText!: Phaser.GameObjects.Text;
  private holeDone = false;
  private maxStrokes = 0;
  private isMyTurn = false;
  private activePlayerName = '';
  private watchingText!: Phaser.GameObjects.Text;
  private canShoot = false;
  private remoteShotQueue: { angle: number; power: number }[] = [];
  private disconnectOverlay!: Phaser.GameObjects.Text;
  private reconnected = false;

  constructor() {
    super({ key: 'GameScene' });
  }

  preload() {
    this.load.json('hole1', '/src/courses/hole1.json');
    this.load.json('hole2', '/src/courses/hole2.json');
    this.load.json('hole3', '/src/courses/hole3.json');
  }

  init(data: { holeIndex: number; activeName?: string }) {
    this.holeIndex = data.holeIndex ?? 0;
    this.strokeCount = 0;
    this.stillFrames = 60;
    this.holeDone = false;
    this.isAiming = false;
    this.canShoot = false;
    this.remoteShotQueue = [];
    if (data.activeName) this.activePlayerName = data.activeName;
  }

  create() {
    this.cameras.main.setBackgroundColor('#1a4020');

    const holeNum = this.holeIndex + 1;
    this.courseData = this.cache.json.get(`hole${holeNum}`) as CourseData;
    this.maxStrokes = this.courseData.par * 2 + 3;

    this.graphics = this.add.graphics();
    this.pmBg = this.add.graphics();
    this.pmFill = this.add.graphics();

    this.buildCourse();

    this.ball = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, 4, {
      restitution: 0.6, friction: 0.05, frictionAir: 0.01, density: 0.002, label: 'ball',
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

    // HUD
    const mono = { fontFamily: '"Courier New", monospace', fontSize: '12px', color: '#e0e0e0' };
    this.holeText = this.add.text(10, 8, `HOLE ${holeNum}/3  Par ${this.courseData.par}`, { ...mono, fontSize: '10px', color: '#888' });
    this.turnText = this.add.text(320, 8, '', { fontFamily: '"Press Start 2P", "Courier New", monospace', fontSize: '10px', color: '#4ecdc4' }).setOrigin(0.5, 0);
    this.strokeText = this.add.text(630, 8, 'Stroke 0', { ...mono, fontSize: '10px', color: '#888' }).setOrigin(1, 0);
    this.watchingText = this.add.text(320, 180, '', { fontFamily: '"Press Start 2P", "Courier New", monospace', fontSize: '14px', color: '#e0e0e0', backgroundColor: '#00000088', padding: { x: 12, y: 8 } }).setOrigin(0.5).setAlpha(0);

    // Disconnect overlay
    this.disconnectOverlay = this.add.text(320, 220, '', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '12px', color: '#eb5757', backgroundColor: '#000000cc',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setAlpha(0).setDepth(100);

    // Connection events
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

    // Determine initial turn
    this.isMyTurn = activePlayerId === localPlayerId;

    this.setupSocketListeners();
    this.updateTurnUI();
    this.drawCourse();
  }

  private buildCourse() {
    for (const w of this.courseData.walls) {
      this.matter.add.rectangle(w.x, w.y, w.width, w.height, {
        isStatic: true, angle: w.rotation ?? 0, label: 'wall',
      });
    }
    this.matter.add.rectangle(320, -10, 680, 20, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(320, 370, 680, 20, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(-10, 180, 20, 400, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(650, 180, 20, 400, { isStatic: true, label: 'wall' });
  }

  private setupSocketListeners() {
    socket.off('message');
    socket.on('message', (msg: any) => {
      switch (msg.type) {
        case 'shot_taken':
          this.onRemoteShot(msg.shot.angle, msg.shot.power);
          break;
        case 'turn_started':
          this.onTurnStarted(msg.playerId, msg.playerName, msg.holeNumber);
          break;
        case 'hole_completed':
          // Other player completed the hole
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

  private onTurnStarted(pId: string, name: string, holeNum: number) {
    setTurn(pId);
    this.isMyTurn = pId === localPlayerId;
    this.activePlayerName = name;
    this.strokeCount = 0;
    this.stillFrames = 60;
    this.holeDone = false;
    this.canShoot = this.isMyTurn;
    this.isAiming = false;

    // Switch hole if needed
    const targetHole = (holeNum || 1) - 1;
    if (targetHole !== this.holeIndex) {
      this.holeIndex = targetHole;
      this.scene.restart({ holeIndex: targetHole });
      return;
    }

    // Reset ball to tee
    if (this.ball) {
      applyVelocity(this.ball, 0, 0);
    }
    this.matter.world.remove(this.ball);
    this.ball = this.matter.add.circle(this.courseData.tee.x, this.courseData.tee.y, 4, {
      restitution: 0.6, friction: 0.05, frictionAir: 0.01, density: 0.002, label: 'ball',
    });
    this.recreateHoleSensor();

    this.strokeText.setText('Stroke 0');
    this.updateTurnUI();
    this.drawCourse();
  }

  private onRemoteShot(angle: number, power: number) {
    // Queue for application on next fixed step
    this.remoteShotQueue.push({ angle, power });
  }

  private applyRemoteShot(angle: number, power: number) {
    if (!this.ball) return;
    const impulse = powerToImpulse(power);
    applyVelocity(this.ball, Math.cos(angle) * impulse, Math.sin(angle) * impulse);
    this.stillFrames = 0;
  }

  private recreateHoleSensor() {
    if (this.holeSensor) this.matter.world.remove(this.holeSensor);
    this.holeSensor = this.matter.add.circle(
      this.courseData.hole.x, this.courseData.hole.y,
      this.courseData.hole.triggerRadius,
      { isStatic: true, isSensor: true, label: 'hole' }
    );
  }

  private updateTurnUI() {
    if (this.isMyTurn) {
      this.turnText.setText('YOUR TURN');
      this.turnText.setColor('#4ecdc4');
      this.watchingText.setAlpha(0);
    } else {
      this.turnText.setText(`WATCHING ${this.activePlayerName || '...'}`);
      this.turnText.setColor('#888888');
      this.watchingText.setText(`Watching ${this.activePlayerName || '...'}`);
      this.watchingText.setAlpha(1);
    }
  }

  private drawCourse() {
    const g = this.graphics;
    g.clear();

    // Rough — dark green background
    g.fillStyle(0x1a4020);
    g.fillRect(0, 0, 640, 360);

    const verts = this.courseData.fairway.vertices;
    if (verts.length > 2) {
      // Fairway shadow — offset polygon 3px for depth cue
      g.fillStyle(0x1e5a28);
      g.beginPath();
      g.moveTo(verts[0].x + 3, verts[0].y + 3);
      for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x + 3, verts[i].y + 3);
      g.closePath();
      g.fillPath();

      // Fairway surface
      g.fillStyle(0x3aaa5e);
      g.lineStyle(1, 0x2a8040);
      g.beginPath();
      g.moveTo(verts[0].x, verts[0].y);
      for (let i = 1; i < verts.length; i++) g.lineTo(verts[i].x, verts[i].y);
      g.closePath();
      g.fillPath();
      g.strokePath();
    }

    // Walls — dark wood blocks with top-left highlight edge
    for (const w of this.courseData.walls) {
      const wx = w.x - w.width / 2;
      const wy = w.y - w.height / 2;
      g.fillStyle(0x5a3015);
      g.fillRect(wx, wy, w.width, w.height);
      g.lineStyle(2, 0x7a5035);
      g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + w.width, wy); g.strokePath();
      g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx, wy + w.height); g.strokePath();
    }

    // Tee — circle marker
    g.fillStyle(0xd4b45a);
    g.lineStyle(1, 0xa08040);
    g.fillCircle(this.courseData.tee.x, this.courseData.tee.y, 5);
    g.strokeCircle(this.courseData.tee.x, this.courseData.tee.y, 5);

    // Hole cup + flag
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

    // Ball with drop shadow
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
  }

  update(_t: number, _delta: number) {
    if (this.holeDone) return;

    // Fixed timestep
    this.matter.world.step(1000 / 60);

    // Apply queued remote shots
    for (const shot of this.remoteShotQueue) {
      this.applyRemoteShot(shot.angle, shot.power);
    }
    this.remoteShotQueue = [];

    // Ball stopped detection
    if (this.ball) {
      const vel = Math.sqrt(this.ball.velocity.x ** 2 + this.ball.velocity.y ** 2);
      if (vel < 0.01) {
        this.stillFrames++;
      } else {
        this.stillFrames = 0;
      }
    }

    // Aim input (only on my turn, ball stopped)
    if (this.isMyTurn && this.stillFrames >= 60 && !this.holeDone) {
      this.handleAimInput();
    }

    this.drawCourse();
  }

  private handleAimInput() {
    const ptr = this.input.activePointer;

    if (ptr.isDown && !this.isAiming) {
      this.isAiming = true;
      this.aimStart.set(ptr.x, ptr.y);
    }

    if (ptr.isDown && this.isAiming && this.ball) {
      this.aimCurrent.set(ptr.x, ptr.y);
      const dx = this.ball.position.x - this.aimCurrent.x;
      const dy = this.ball.position.y - this.aimCurrent.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDrag = 200;
      const power = Math.min(dist / maxDrag, 1);

      // Dotted aim line
      const g = this.graphics;
      const steps = Math.floor(dist / 4);
      g.fillStyle(0x4ecdc4, 0.6);
      for (let i = 0; i < steps; i += 2) {
        const t = (i / steps);
        g.fillRect(this.ball.position.x - dx * t - 1, this.ball.position.y - dy * t - 1, 2, 2);
      }

      // Power meter
      this.drawPowerMeter(power);
    }

    if (!ptr.isDown && this.isAiming) {
      this.isAiming = false;
      this.pmBg.clear(); this.pmFill.clear();
      if (!this.ball) return;

      const dx = this.ball.position.x - this.aimCurrent.x;
      const dy = this.ball.position.y - this.aimCurrent.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) return; // too short

      const maxDrag = 200;
      const power = Math.min(dist / maxDrag, 1);
      const angle = Math.atan2(dy, dx);

      this.shoot(angle, power);
    }
  }

  private drawPowerMeter(power: number) {
    const px = 252, py = 330, sw = 14, sh = 14, gap = 2, total = 8;
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
    if (!this.isMyTurn || this.holeDone) return;
    this.strokeCount++;
    this.stillFrames = 0;
    this.strokeText.setText(`Stroke ${this.strokeCount}`);

    const impulse = powerToImpulse(power);
    applyVelocity(this.ball, Math.cos(angle) * impulse, Math.sin(angle) * impulse);

    // Broadcast shot to server
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

    // Check stroke limit
    if (this.strokeCount >= this.maxStrokes) {
      this.time.delayedCall(4000, () => this.onHoleComplete());
    }
  }

  private onHoleComplete() {
    if (this.holeDone) return;
    this.holeDone = true;
    if (this.ball) this.matter.world.remove(this.ball);

    socket.emit('message', {
      type: 'hole_completed',
      playerId: localPlayerId,
      strokes: Math.min(this.strokeCount, this.maxStrokes),
      par: this.courseData.par,
    });
  }
}
