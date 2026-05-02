import Phaser from 'phaser';
import { io, Socket } from 'socket.io-client';
import type { ServerMessage, ClientMessage, Player, ScoreEntry, FinalScore } from 'shared';

// ---- Shared socket state ----
export let socket: Socket;
export let playerId: string | null = null;
export let roomCode: string | null = null;
export let players: Player[] = [];
export let scores: ScoreEntry[] = [];
export let finalScores: FinalScore[] | null = null;

export function connectSocket() {
  socket = io('/', { transports: ['websocket'] });
}
