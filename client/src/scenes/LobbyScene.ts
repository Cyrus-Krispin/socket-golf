import Phaser from 'phaser';
import { connectSocket, socket, setLocalPlayer, updatePlayers, playerList } from '../network';

export class LobbyScene extends Phaser.Scene {
  private domContainer!: HTMLDivElement;
  private readyToStart = false;
  private playerNames: string[] = [];

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create() {
    this.cameras.main.setBackgroundColor('#1a1a2e');

    this.add.text(320, 60, 'SOCKET GOLF', {
      fontFamily: '"Press Start 2P", "Courier New", monospace',
      fontSize: '16px',
      color: '#4ecdc4',
    }).setOrigin(0.5);

    this.add.text(320, 90, 'no login. no accounts. just golf.', {
      fontFamily: '"Courier New", monospace',
      fontSize: '10px',
      color: '#888888',
    }).setOrigin(0.5);

    connectSocket();
    this.setupSocketListeners();

    this.domContainer = document.createElement('div');
    this.domContainer.id = 'lobby-ui';
    this.domContainer.innerHTML = this.getHTML();
    document.getElementById('game-container')!.appendChild(this.domContainer);

    this.bindDOM();

    document.getElementById('name-input')!.focus();
  }

  private getHTML() {
    return `<style>
      #lobby-ui{position:absolute;top:0;left:0;width:100%;height:100%;
        display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:10px;
        font-family:"Courier New",monospace;color:#e0e0e0;pointer-events:none}
      #lobby-ui>*{pointer-events:auto}
      #lobby-ui input{background:#16213e;border:1px solid #555;color:#e0e0e0;
        font-family:"Courier New",monospace;font-size:14px;padding:8px 12px;
        text-align:center;outline:none}
      #lobby-ui input:focus{border-color:#4ecdc4}
      #lobby-ui button{background:#2a2a3e;border:1px solid #555;color:#e0e0e0;
        font-family:"Courier New",monospace;font-size:11px;padding:10px 24px;
        cursor:pointer;letter-spacing:2px;text-transform:uppercase}
      #lobby-ui button:hover{border-color:#4ecdc4}
      #lobby-ui button:disabled,.btn-disabled{opacity:0.4;cursor:default;border-color:#444!important}
      #lobby-ui button:focus{outline:2px solid #4ecdc4}
      .ls{border:1px solid #333;background:#222244;padding:16px;
        display:flex;flex-direction:column;align-items:center;gap:8px}
      .ll{font-size:11px;color:#888}
      .ld{color:#555;font-size:10px}
      #room-code-display{font-size:18px;color:#6fcf97;letter-spacing:4px;display:none}
      #error-msg{color:#eb5757;font-size:11px;display:none;min-height:16px}
      #player-list{font-size:11px;color:#888;display:none;text-align:center}
      #name-input{width:170px;letter-spacing:1px}
      #code-input{width:100px;letter-spacing:4px}
      .start-btn{font-size:14px!important;padding:12px 32px!important;color:#6fcf97!important}
    </style>
    <div class="ls">
      <input id="name-input" type="text" maxlength="12" placeholder="Your name" aria-label="Your name" autocomplete="off">
      <div style="display:flex;align-items:center;gap:8px">
        <input id="code-input" type="text" maxlength="6" placeholder="------" aria-label="Room code" autocomplete="off">
        <button id="btn-join" aria-label="Join room">JOIN</button>
      </div>
      <div class="ld">or</div>
      <button id="btn-create">CREATE ROOM</button>
      <div id="room-code-display">ROOM: <span id="code-text"></span></div>
      <div id="player-list"></div>
      <div id="error-msg"></div>
    </div>`;
  }

  private bindDOM() {
    document.getElementById('btn-create')!.addEventListener('click', () => this.createRoom());
    document.getElementById('btn-join')!.addEventListener('click', () => this.joinRoom());
    document.getElementById('code-input')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.joinRoom();
    });
    document.getElementById('name-input')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') document.getElementById('code-input')!.focus();
    });
  }

  private setupSocketListeners() {
    socket.on('message', (msg: any) => {
      switch (msg.type) {
        case 'room_created':
          setLocalPlayer(msg.playerId, msg.roomCode);
          this.onRoomCreated(msg.roomCode);
          break;
        case 'room_joined':
          setLocalPlayer(msg.playerId, msg.roomCode);
          updatePlayers(msg.players);
          this.onRoomCreated(msg.roomCode);
          this.renderPlayers(msg.players);
          this.checkAutoStart(msg.players.length);
          break;
        case 'player_joined':
          this.playerNames.push(msg.playerName);
          this.renderPlayers(this.playerNames.map((n, i) => ({ id: String(i), name: n })));
          this.checkAutoStart(this.playerNames.length + 1);
          break;
        case 'error':
          this.showError(msg.message);
          break;
        case 'turn_started':
          this.launchGame(msg.holeNumber);
          break;
      }
    });
  }

  private showError(msg: string) {
    const el = document.getElementById('error-msg')!;
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  private disableButtons() {
    const b = (id: string) => (document.getElementById(id) as HTMLButtonElement).disabled = true;
    b('btn-create'); b('btn-join');
  }

  private createRoom() {
    const name = (document.getElementById('name-input') as HTMLInputElement).value.trim();
    if (!name) { this.showError('Enter a name first'); return; }
    this.playerNames = [name];
    this.disableButtons();
    socket.emit('message', { type: 'create_room', playerName: name });
  }

  private joinRoom() {
    const name = (document.getElementById('name-input') as HTMLInputElement).value.trim();
    const code = (document.getElementById('code-input') as HTMLInputElement).value.trim().toUpperCase();
    if (!name) { this.showError('Enter a name first'); return; }
    if (code.length !== 6) { this.showError('Code must be 6 characters'); return; }
    this.playerNames = [name];
    this.disableButtons();
    socket.emit('message', { type: 'join_room', roomCode: code, playerName: name });
  }

  private onRoomCreated(code: string) {
    const el = document.getElementById('room-code-display')!;
    el.style.display = 'block';
    document.getElementById('code-text')!.textContent = code;
  }

  private renderPlayers(plist: { id: string; name: string }[]) {
    const el = document.getElementById('player-list')!;
    el.style.display = 'block';
    el.innerHTML = plist.map(p => `<div>${p.name}</div>`).join('') +
      `<div style="margin-top:4px;color:#555">${plist.length}/4 players</div>`;
  }

  private checkAutoStart(count: number) {
    if (count >= 2 && !this.readyToStart) {
      this.readyToStart = true;
      this.time.delayedCall(800, () => {
        socket.emit('message', { type: 'start_game' });
      });
    }
  }

  private launchGame(holeNumber: number) {
    this.domContainer.remove();
    this.scene.start('GameScene', { holeIndex: (holeNumber || 1) - 1 });
  }
}
