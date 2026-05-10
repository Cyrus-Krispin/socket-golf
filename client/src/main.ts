import Phaser from 'phaser';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { ScoreboardScene } from './scenes/ScoreboardScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.CANVAS,
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#1a1a2e',
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: 0 },
      debug: false,
      autoUpdate: false,
      positionIterations: 12,
      velocityIterations: 8,
      constraintIterations: 4,
    },
  },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [LobbyScene, GameScene, ScoreboardScene],
  parent: 'game-container',
};

new Phaser.Game(config);
