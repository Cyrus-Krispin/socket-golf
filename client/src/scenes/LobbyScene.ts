import Phaser from 'phaser';
import { connectSocket, socket, playerId, roomCode, players } from '../network';

export class LobbyScene extends Phaser.Scene {
  constructor() {
    super({ key: 'LobbyScene' });
  }

  create() {
    connectSocket();

    // Title
    this.add.text(320, 60, 'SOCKET GOLF', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '16px',
      color: '#e0e0e0',
    }).setOrigin(0.5);

    this.add.text(320, 90, 'no login. no accounts. just golf.', {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: '#888888',
    }).setOrigin(0.5);

    // Name input (using DOM for real input — placeholder for now)
    this.add.text(320, 140, 'TODO: name input + join/create UI', {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: '#4ecdc4',
    }).setOrigin(0.5);

    this.add.text(320, 170, `Server: ${socket.connected ? 'connected' : 'connecting...'}`, {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: socket.connected ? '#6fcf97' : '#eb5757',
    }).setOrigin(0.5);
  }
}
