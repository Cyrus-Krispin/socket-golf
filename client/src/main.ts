import Phaser from 'phaser';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { ScoreboardScene } from './scenes/ScoreboardScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.CANVAS,
  width: 640,
  height: 360,
  pixelArt: true,
  roundPixels: true,
  backgroundColor: '#1a1a2e',
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [LobbyScene, GameScene, ScoreboardScene],
  parent: 'game-container',
};

new Phaser.Game(config);
