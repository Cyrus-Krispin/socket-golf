import Phaser from 'phaser';

export class ScoreboardScene extends Phaser.Scene {
  constructor() {
    super({ key: 'ScoreboardScene' });
  }

  create() {
    this.add.text(320, 180, 'TODO: scoreboard + next hole / final leaderboard', {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: '#4ecdc4',
    }).setOrigin(0.5);
  }
}
