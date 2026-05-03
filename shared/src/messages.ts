import { z } from 'zod';

// ---- Player ----
export interface Player {
  id: string;
  name: string;
  connected: boolean;
}

// ---- Shot ----
export interface ShotMessage {
  playerId: string;
  playerName: string;
  ballOrigin: { x: number; y: number };
  angle: number;    // radians, 0 = right, clockwise
  power: number;    // 0.0–1.0
  strokeNumber: number;
}

// ---- Ball state for sync ----
export interface BallStateMessage {
  playerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// ---- Scores ----
export interface ScoreEntry {
  playerId: string;
  name: string;
  strokes: number;
  relativeToPar: number; // e.g. -1, 0, +2
}

export interface FinalScore {
  playerId: string;
  name: string;
  total: number;
  relativeToPar: number;
}

// ---- Room state ----
export interface RoomState {
  roomCode: string;
  players: Player[];
  currentHole: number;
  scores: ScoreEntry[];
  maxPlayers: number;
  creatorId: string;
}

// ---- Server → Client messages ----
export type ServerMessage =
  | { type: 'room_created'; roomCode: string; playerId: string }
  | { type: 'room_joined'; roomCode: string; playerId: string; players: Player[]; creatorId: string }
  | { type: 'player_joined'; playerId: string; playerName: string; players: Player[]; creatorId: string }
  | { type: 'player_left'; playerId: string; players: Player[]; creatorId: string }
  | { type: 'shot_taken'; shot: ShotMessage }
  | { type: 'ball_state'; playerId: string; x: number; y: number; vx: number; vy: number }
  | { type: 'hole_completed'; playerId: string; strokes: number; par: number }
  | { type: 'score_update'; scores: ScoreEntry[] }
  | { type: 'game_started'; holeNumber: number }
  | { type: 'hole_ready'; playerId: string }
  | { type: 'all_ready'; holeNumber: number }
  | { type: 'ball_reset'; playerId: string }
  | { type: 'game_ended'; finalScores: FinalScore[] }
  | { type: 'room_state'; state: RoomState }
  | { type: 'error'; message: string };

// ---- Client → Server messages ----
export type ClientMessage =
  | { type: 'create_room'; playerName: string; maxPlayers?: number }
  | { type: 'join_room'; roomCode: string; playerName: string }
  | { type: 'start_game'; playerId: string }
  | { type: 'shot_taken'; shot: ShotMessage }
  | { type: 'ball_state'; playerId: string; x: number; y: number; vx: number; vy: number }
  | { type: 'hole_completed'; playerId: string; strokes: number; par: number }
  | { type: 'hole_ready'; playerId: string }
  | { type: 'ball_reset'; playerId: string };

// ---- Zod schemas for server-side validation ----
const vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});

export const shotMessageSchema = z.object({
  playerId: z.string().uuid(),
  playerName: z.string().min(1).max(12),
  ballOrigin: vec2Schema,
  angle: z.number().min(-Math.PI * 2).max(Math.PI * 2),
  power: z.number().min(0).max(1),
  strokeNumber: z.number().int().min(1),
});

export const holeCompletedSchema = z.object({
  playerId: z.string().uuid(),
  strokes: z.number().int().min(1),
  par: z.number().int().min(1).max(10),
});

export const createRoomSchema = z.object({
  playerName: z.string().min(1).max(12),
  maxPlayers: z.number().int().min(2).max(4).optional(),
});

export const joinRoomSchema = z.object({
  roomCode: z.string().length(6),
  playerName: z.string().min(1).max(12),
});
