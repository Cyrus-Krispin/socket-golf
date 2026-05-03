import { io, Socket } from 'socket.io-client';
import type { Player } from 'shared';

export let socket: Socket;
export let localPlayerId: string | null = null;
export let roomCode: string | null = null;
export let playerList: Player[] = [];
export let currentHole = 0;
export let creatorId: string | null = null;

export function connectSocket() {
  if (socket?.connected) return;
  socket = io(import.meta.env.VITE_SERVER_URL ?? '/', { transports: ['websocket'] });
}

export function setLocalPlayer(id: string, code: string) {
  localPlayerId = id;
  roomCode = code;
}

export function updatePlayers(players: Player[], cId?: string) {
  playerList = players;
  if (cId) creatorId = cId;
}

export function isCreator(): boolean {
  return localPlayerId !== null && localPlayerId === creatorId;
}
