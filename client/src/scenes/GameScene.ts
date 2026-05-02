import Phaser from 'phaser';

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this.add.text(320, 180, 'TODO: course canvas + physics + aim/shoot', {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: '#4ecdc4',
    }).setOrigin(0.5);
  }
}
