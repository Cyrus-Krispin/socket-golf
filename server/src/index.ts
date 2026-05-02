import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientMessage, Player, ScoreEntry, RoomState } from 'shared';
import {
  shotMessageSchema,
  holeCompletedSchema,
  createRoomSchema,
  joinRoomSchema,
} from 'shared';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*' }, // MVP — tighten for production
});

// ---- In-memory state ----
interface Room {
  code: string;
  players: Map<string, Player>;
  maxPlayers: number;
  scores: Map<string, number[]>; // playerId → [hole1Strokes, hole2Strokes, ...]
  currentHole: number;
  turnOrder: string[];       // playerId array
  activeTurnIndex: number;
  socketMap: Map<string, string>; // socketId → playerId
}

const rooms = new Map<string, Room>();

// ---- Utilities ----
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,O,0,1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function buildRoomState(room: Room): RoomState {
  const scores: ScoreEntry[] = [];
  const totalHoles = 3;
  for (const [playerId, strokes] of room.scores) {
    const player = room.players.get(playerId);
    if (!player) continue;
    const total = strokes.reduce((a, b) => a + b, 0);
    // par is 3 per hole for simplicity — real courses define this per hole
    const totalPar = totalHoles * 3;
    scores.push({
      playerId,
      name: player.name,
      strokes: strokes[strokes.length - 1] ?? 0,
      relativeToPar: total - totalPar,
    });
  }
  return {
    roomCode: room.code,
    players: Array.from(room.players.values()),
    currentHole: room.currentHole,
    activePlayerIndex: room.activeTurnIndex,
    scores,
    maxPlayers: room.maxPlayers,
  };
}

function broadcast(room: Room, msg: object, excludeSocketId?: string) {
  room.socketMap.forEach((_pid, socketId) => {
    if (socketId !== excludeSocketId) {
      io.to(socketId).emit('message', msg);
    }
  });
}

function broadcastToAll(room: Room, msg: object) {
  broadcast(room, msg);
}

// ---- Socket.io ----
io.on('connection', (socket) => {
  let currentRoom: Room | null = null;
  let currentPlayerId: string | null = null;

  socket.on('message', (raw: ClientMessage) => {
    try {
      switch (raw.type) {
        case 'create_room': {
          const { playerName, maxPlayers = 4 } = createRoomSchema.parse(raw);
          const code = generateCode();
          const playerId = crypto.randomUUID();
          const room: Room = {
            code,
            players: new Map([[playerId, { id: playerId, name: playerName, connected: true }]]),
            maxPlayers,
            scores: new Map([[playerId, []]]),
            currentHole: 0,
            turnOrder: [playerId],
            activeTurnIndex: 0,
            socketMap: new Map([[socket.id, playerId]]),
          };
          rooms.set(code, room);
          currentRoom = room;
          currentPlayerId = playerId;

          socket.emit('message', { type: 'room_created', roomCode: code, playerId });
          break;
        }

        case 'join_room': {
          const { roomCode, playerName } = joinRoomSchema.parse(raw);
          const room = rooms.get(roomCode.toUpperCase());
          if (!room) {
            socket.emit('message', { type: 'error', message: 'Room not found' });
            break;
          }
          if (room.players.size >= room.maxPlayers) {
            socket.emit('message', { type: 'error', message: `Room is full (${room.maxPlayers}/${room.maxPlayers})` });
            break;
          }
          const playerId = crypto.randomUUID();
          room.players.set(playerId, { id: playerId, name: playerName, connected: true });
          room.scores.set(playerId, []);
          room.turnOrder.push(playerId);
          room.socketMap.set(socket.id, playerId);
          currentRoom = room;
          currentPlayerId = playerId;

          socket.emit('message', {
            type: 'room_joined',
            roomCode,
            playerId,
            players: Array.from(room.players.values()),
          });
          broadcast(room, { type: 'player_joined', playerId, playerName }, socket.id);
          break;
        }

        case 'shot_taken': {
          if (!currentRoom || !currentPlayerId) break;
          shotMessageSchema.parse(raw.shot);
          broadcastToAll(currentRoom, { type: 'shot_taken', shot: raw.shot });
          break;
        }

        case 'hole_completed': {
          if (!currentRoom || !currentPlayerId) break;
          holeCompletedSchema.parse(raw);
          const { playerId, strokes, par } = raw;
          const existingScores = currentRoom.scores.get(playerId) ?? [];
          existingScores[currentRoom.currentHole] = strokes;
          currentRoom.scores.set(playerId, existingScores);

          broadcastToAll(currentRoom, { type: 'hole_completed', playerId, strokes, par });

          // Advance turn
          currentRoom.activeTurnIndex++;
          if (currentRoom.activeTurnIndex >= currentRoom.turnOrder.length) {
            // All players done with this hole
            currentRoom.activeTurnIndex = 0;
            currentRoom.currentHole++;

            const state = buildRoomState(currentRoom);
            broadcastToAll(currentRoom, { type: 'score_update', scores: state.scores });

            if (currentRoom.currentHole >= 3) {
              // Game over
              const finalScores = state.scores.map(s => ({
                playerId: s.playerId,
                name: s.name,
                total: currentRoom!.scores.get(s.playerId)!.reduce((a, b) => a + b, 0),
                relativeToPar: s.relativeToPar,
              }));
              broadcastToAll(currentRoom, { type: 'game_ended', finalScores });
            } else {
              // Start next hole
              const nextPlayerId = currentRoom.turnOrder[0];
              const nextPlayer = currentRoom.players.get(nextPlayerId)!;
              broadcastToAll(currentRoom, {
                type: 'turn_started',
                playerId: nextPlayerId,
                playerName: nextPlayer.name,
                holeNumber: currentRoom.currentHole + 1,
              });
            }
          } else {
            // Next player's turn on same hole
            const nextPlayerId = currentRoom.turnOrder[currentRoom.activeTurnIndex];
            const nextPlayer = currentRoom.players.get(nextPlayerId)!;
            broadcastToAll(currentRoom, {
              type: 'turn_started',
              playerId: nextPlayerId,
              playerName: nextPlayer.name,
              holeNumber: currentRoom.currentHole + 1,
            });
          }
          break;
        }

        case 'ball_reset': {
          if (!currentRoom) break;
          broadcastToAll(currentRoom, { type: 'ball_reset', playerId: raw.playerId });
          break;
        }
      }
    } catch (err) {
      socket.emit('message', { type: 'error', message: 'Invalid message' });
      console.warn('Invalid message:', err);
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !currentPlayerId) return;
    const player = currentRoom.players.get(currentPlayerId);
    if (player) player.connected = false;

    // 60s grace period before removing
    setTimeout(() => {
      const p = currentRoom!.players.get(currentPlayerId!);
      if (p && !p.connected) {
        currentRoom!.players.delete(currentPlayerId!);
        currentRoom!.socketMap.delete(socket.id);
        currentRoom!.turnOrder = currentRoom!.turnOrder.filter(id => id !== currentPlayerId);
        broadcastToAll(currentRoom!, { type: 'player_left', playerId: currentPlayerId! });

        if (currentRoom!.players.size === 0) {
          rooms.delete(currentRoom!.code);
        }
      }
    }, 60_000);
  });
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
httpServer.listen(PORT, () => {
  console.log(`socket-golf server running on port ${PORT}`);
});
