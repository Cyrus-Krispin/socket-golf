import Phaser from 'phaser';
import { socket, localPlayerId } from '../network';

interface ScoreEntry {
  playerId: string;
  name: string;
  strokes: number;
  relativeToPar: number;
}

export class ScoreboardScene extends Phaser.Scene {
  private isFinal = false;
  private scoreData: ScoreEntry[] = [];
  private readyPlayers = new Set<string>();
  private myReady = false;

  constructor() {
    super({ key: 'ScoreboardScene' });
  }

  init(data: { scores: ScoreEntry[]; isFinal: boolean }) {
    this.scoreData = data.scores || [];
    this.isFinal = data.isFinal || false;
    this.readyPlayers.clear();
    this.myReady = false;
  }

  create() {
    this.cameras.main.setBackgroundColor('#1a1a2e');

    const cw = this.cameras.main.width;
    const ch = this.cameras.main.height;
    const cx = cw / 2;
    const topY = ch * 0.15;

    const title = this.isFinal ? 'FINAL SCORES' : 'HOLE COMPLETE';
    this.add.text(cx, topY, title, {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '18px',
      color: '#6fcf97',
    }).setOrigin(0.5);

    let y = topY + 56;
    const mono = { fontFamily: '"Courier New", monospace', fontSize: '16px', color: '#e0e0e0' };
    const muted = { ...mono, color: '#888888' };

    const sorted = [...this.scoreData].sort((a, b) => a.strokes - b.strokes);

    sorted.forEach((entry, i) => {
      const isMe = entry.playerId === localPlayerId;
      const prefix = this.isFinal ? `${i + 1}. ` : '';
      const parStr = entry.relativeToPar === 0 ? 'E' :
        entry.relativeToPar > 0 ? `+${entry.relativeToPar}` : `${entry.relativeToPar}`;
      const parColor = entry.relativeToPar === 0 ? '#6fcf97' :
        entry.relativeToPar > 0 ? '#eb5757' : '#6fcf97';

      this.add.text(cx - 160, y, `${prefix}${entry.name}`, {
        ...(isMe ? mono : muted),
        fontFamily: '"Courier New", monospace',
        fontSize: '16px',
      }).setOrigin(0, 0.5);

      this.add.text(cx + 100, y, `${entry.strokes}`, {
        ...mono, fontSize: '16px',
      }).setOrigin(0.5);

      this.add.text(cx + 160, y, `(${parStr})`, {
        ...mono, fontSize: '14px', color: parColor,
      }).setOrigin(0.5);

      y += 34;
    });

    const btnY = this.isFinal ? y + 30 : y + 10;

    if (this.isFinal) {
      const btn = this.add.text(cx, btnY, 'BACK TO LOBBY', {
        fontFamily: '"Courier New", monospace',
        fontSize: '14px',
        color: '#4ecdc4',
        backgroundColor: '#2a2a3e',
        padding: { x: 24, y: 12 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });

      btn.on('pointerover', () => btn.setStyle({ color: '#e0e0e0' }));
      btn.on('pointerout', () => btn.setStyle({ color: '#4ecdc4' }));
      btn.on('pointerdown', () => this.scene.start('LobbyScene'));

      this.input.keyboard!.on('keydown-ENTER', () => this.scene.start('LobbyScene'));
    } else {
      const readyBtn = this.add.text(cx, btnY, 'I\'M READY FOR NEXT HOLE', {
        fontFamily: '"Courier New", monospace',
        fontSize: '14px',
        color: '#4ecdc4',
        backgroundColor: '#2a2a3e',
        padding: { x: 24, y: 12 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });

      readyBtn.on('pointerover', () => readyBtn.setStyle({ color: '#e0e0e0' }));
      readyBtn.on('pointerout', () => readyBtn.setStyle({ color: this.myReady ? '#6fcf97' : '#4ecdc4' }));

      readyBtn.on('pointerdown', () => {
        if (this.myReady) return;
        this.myReady = true;
        readyBtn.setText('\u2713 I\'M READY');
        readyBtn.setStyle({ color: '#6fcf97' });
        readyBtn.disableInteractive();
        socket.emit('message', { type: 'hole_ready', playerId: localPlayerId });
        this.updateReadyDisplay();
      });

      this.renderReadyStatus(btnY + 40);

      socket.off('message');
      socket.on('message', (msg: any) => {
        switch (msg.type) {
          case 'hole_ready':
            this.readyPlayers.add(msg.playerId);
            this.updateReadyDisplay();
            break;
          case 'all_ready':
            this.scene.start('GameScene', { holeIndex: (msg.holeNumber || 1) - 1 });
            break;
        }
      });
    }
  }

  private renderReadyStatus(startY: number) {
    const existing = document.getElementById('ready-status');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'ready-status';
    div.style.cssText = `position:absolute;top:${startY}px;left:0;width:100%;text-align:center;font-size:11px;color:#888;pointer-events:none`;
    document.getElementById('game-container')!.appendChild(div);
    this.updateReadyDisplay();
  }

  private updateReadyDisplay() {
    const div = document.getElementById('ready-status');
    if (!div) return;
    div.innerHTML = this.scoreData.map(e => {
      const ready = this.readyPlayers.has(e.playerId);
      const check = ready ? '\u2713' : '\u25CB';
      return `${e.name}: ${check}`;
    }).join(' | ');
  }
}
