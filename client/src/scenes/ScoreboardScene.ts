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

  constructor() {
    super({ key: 'ScoreboardScene' });
  }

  init(data: { scores: ScoreEntry[]; isFinal: boolean }) {
    this.scoreData = data.scores || [];
    this.isFinal = data.isFinal || false;
  }

  create() {
    this.cameras.main.setBackgroundColor('#1a1a2e');

    const title = this.isFinal ? 'FINAL SCORES' : 'HOLE COMPLETE';
    this.add.text(320, 60, title, {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '14px',
      color: '#6fcf97',
    }).setOrigin(0.5);

    // Score table
    let y = 110;
    const mono = { fontFamily: '"Courier New", monospace', fontSize: '14px', color: '#e0e0e0' };
    const muted = { ...mono, color: '#888888' };

    // Sort by strokes (ascending)
    const sorted = [...this.scoreData].sort((a, b) => a.strokes - b.strokes);

    sorted.forEach((entry, i) => {
      const isMe = entry.playerId === localPlayerId;
      const prefix = this.isFinal ? `${i + 1}. ` : '';
      const parStr = entry.relativeToPar === 0 ? 'E' :
        entry.relativeToPar > 0 ? `+${entry.relativeToPar}` : `${entry.relativeToPar}`;
      const parColor = entry.relativeToPar === 0 ? '#6fcf97' :
        entry.relativeToPar > 0 ? '#eb5757' : '#6fcf97';

      this.add.text(320, y, `${prefix}${entry.name}`, {
        ...(isMe ? mono : muted),
        fontFamily: '"Courier New", monospace',
        fontSize: '14px',
      }).setOrigin(0.5);

      this.add.text(420, y, `${entry.strokes}`, {
        ...mono, fontSize: '14px',
      }).setOrigin(0.5);

      this.add.text(480, y, `(${parStr})`, {
        ...mono, fontSize: '12px', color: parColor,
      }).setOrigin(0.5);

      y += 28;
    });

    // Action button
    const btnText = this.isFinal ? 'BACK TO LOBBY' : 'NEXT HOLE';
    const btnY = y + 30;
    const btn = this.add.text(320, btnY, btnText, {
      fontFamily: '"Courier New", monospace',
      fontSize: '11px',
      color: '#4ecdc4',
      backgroundColor: '#2a2a3e',
      padding: { x: 20, y: 10 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    btn.on('pointerover', () => btn.setStyle({ color: '#e0e0e0' }));
    btn.on('pointerout', () => btn.setStyle({ color: '#4ecdc4' }));
    btn.on('pointerdown', () => {
      if (this.isFinal) {
        this.scene.start('LobbyScene');
      } else {
        // Wait for turn_started to advance
        this.scene.start('GameScene', { holeIndex: -1 }); // will be updated by turn_started
      }
    });

    // Keyboard: Enter to continue
    this.input.keyboard!.on('keydown-ENTER', () => {
      if (this.isFinal) {
        this.scene.start('LobbyScene');
      }
    });

    // Also listen for turn_started to auto-advance
    socket.on('message', (msg: any) => {
      if (msg.type === 'turn_started') {
        this.scene.start('GameScene', { holeIndex: (msg.holeNumber || 1) - 1 });
      }
    });
  }
}
