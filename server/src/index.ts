import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientMessage, Player, ScoreEntry, RoomState } from 'shared';
import {
  shotMessageSchema,
  holeCompletedSchema,
  createRoomSchema,
  joinRoomSchema,
} from 'shared';

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
});
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// ---- In-memory state ----
interface Room {
  code: string;
  creatorId: string;
  players: Map<string, Player>;
  maxPlayers: number;
  scores: Map<string, number[]>; // playerId → [hole1Strokes, hole2Strokes, ...]
  currentHole: number;       // 0 = waiting, 1-3 = playing
  holeCompleted: Set<string>; // players who finished current hole
  readyForNext: Set<string>;  // players ready for next hole
  socketMap: Map<string, string>; // socketId → playerId
}

const rooms = new Map<string, Room>();

// ---- Utilities ----
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function buildPlayerList(room: Room): Player[] {
  return Array.from(room.players.values());
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

function buildRoomState(room: Room): RoomState {
  const scores: ScoreEntry[] = [];
  for (const [playerId, strokeList] of room.scores) {
    const player = room.players.get(playerId);
    if (!player) continue;
    const total = strokeList.reduce((a, b) => a + b, 0);
    const totalPar = room.currentHole * 3;
    scores.push({
      playerId,
      name: player.name,
      strokes: strokeList[room.currentHole - 1] ?? 0,
      relativeToPar: total - totalPar,
    });
  }
  return {
    roomCode: room.code,
    players: Array.from(room.players.values()),
    currentHole: room.currentHole,
    scores,
    maxPlayers: room.maxPlayers,
    creatorId: room.creatorId,
  };
}

function emitPlayerList(room: Room) {
  const players = buildPlayerList(room);
  broadcastToAll(room, { type: 'player_list', players, creatorId: room.creatorId });
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
            creatorId: playerId,
            players: new Map([[playerId, { id: playerId, name: playerName, connected: true }]]),
            maxPlayers,
            scores: new Map([[playerId, []]]),
            currentHole: 0,
            holeCompleted: new Set(),
            readyForNext: new Set(),
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
          room.socketMap.set(socket.id, playerId);
          currentRoom = room;
          currentPlayerId = playerId;

          socket.emit('message', {
            type: 'room_joined',
            roomCode,
            playerId,
            players: buildPlayerList(room),
            creatorId: room.creatorId,
          });

          emitPlayerList(room);
          break;
        }

        case 'start_game': {
          if (!currentRoom) break;
          if (currentPlayerId !== currentRoom.creatorId) {
            socket.emit('message', { type: 'error', message: 'Only the room creator can start the game' });
            break;
          }
          if (currentRoom.players.size < 2) {
            socket.emit('message', { type: 'error', message: 'Need at least 2 players' });
            break;
          }
          currentRoom.currentHole = 1;
          currentRoom.holeCompleted.clear();
          currentRoom.readyForNext.clear();
          broadcastToAll(currentRoom, { type: 'game_started', holeNumber: 1 });
          break;
        }

        case 'shot_taken': {
          if (!currentRoom || !currentPlayerId) break;
          shotMessageSchema.parse(raw.shot);
          broadcast(currentRoom, { type: 'shot_taken', shot: raw.shot }, socket.id);
          break;
        }

        case 'ball_state': {
          if (!currentRoom || !currentPlayerId) break;
          const { playerId, x, y, vx, vy } = raw;
          broadcast(currentRoom, { type: 'ball_state', playerId, x, y, vx, vy }, socket.id);
          break;
        }

        case 'hole_completed': {
          if (!currentRoom || !currentPlayerId) break;
          holeCompletedSchema.parse(raw);
          const { playerId, strokes, par } = raw;
          const existingScores = currentRoom.scores.get(playerId) ?? [];
          existingScores[currentRoom.currentHole - 1] = strokes;
          currentRoom.scores.set(playerId, existingScores);
          currentRoom.holeCompleted.add(playerId);

          broadcastToAll(currentRoom, { type: 'hole_completed', playerId, strokes, par });

          // Check if all connected players done
          const connectedHole = Array.from(currentRoom.players.values()).filter(p => p.connected).length;
          if (currentRoom.holeCompleted.size >= connectedHole) {
            currentRoom.holeCompleted.clear();

            if (currentRoom.currentHole >= 3) {
              const finalScores = Array.from(currentRoom.scores.entries()).map(([pid, scores]) => {
                const player = currentRoom!.players.get(pid);
                const total = scores.reduce((a, b) => a + b, 0);
                const totalPar = 3 * 3;
                return {
                  playerId: pid,
                  name: player?.name ?? 'Player',
                  total,
                  relativeToPar: total - totalPar,
                };
              });
              broadcastToAll(currentRoom, { type: 'game_ended', finalScores });
            } else {
              const state = buildRoomState(currentRoom);
              broadcastToAll(currentRoom, { type: 'score_update', scores: state.scores });
            }
          }
          break;
        }

        case 'hole_ready': {
          if (!currentRoom || !currentPlayerId) break;
          currentRoom.readyForNext.add(currentPlayerId);
          broadcastToAll(currentRoom, { type: 'hole_ready', playerId: currentPlayerId });

          const connectedReady = Array.from(currentRoom.players.values()).filter(p => p.connected).length;
          if (currentRoom.readyForNext.size >= connectedReady) {
            currentRoom.readyForNext.clear();
            currentRoom.holeCompleted.clear();
            currentRoom.currentHole++;
            broadcastToAll(currentRoom, {
              type: 'all_ready',
              holeNumber: currentRoom.currentHole,
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

    emitPlayerList(currentRoom);

    // If a hole is active, auto-complete for disconnected player so game isn't blocked
    if (currentRoom.currentHole > 0) {
      currentRoom.holeCompleted.add(currentPlayerId);

      // Check if all remaining active players are done
      const activePlayers = new Set(
        Array.from(currentRoom.players.entries())
          .filter(([_, p]) => p.connected)
          .map(([id]) => id)
      );
      let allDone = true;
      for (const pid of activePlayers) {
        if (!currentRoom.holeCompleted.has(pid)) {
          allDone = false;
          break;
        }
      }
      if (allDone && activePlayers.size > 0) {
        if (currentRoom.currentHole >= 3) {
          const finalScores = Array.from(currentRoom.scores.entries()).map(([pid, scores]) => {
            const p = currentRoom!.players.get(pid);
            const total = scores.reduce((a, b) => a + b, 0);
            const totalPar = 3 * 3;
            return {
              playerId: pid,
              name: p?.name ?? 'Player',
              total,
              relativeToPar: total - totalPar,
            };
          });
          broadcastToAll(currentRoom, { type: 'game_ended', finalScores });
        } else {
          const state = buildRoomState(currentRoom);
          broadcastToAll(currentRoom, { type: 'score_update', scores: state.scores });
        }
      }
    }

    // 30s rejoin window, then remove
    setTimeout(() => {
      if (!currentRoom) return;
      const p = currentRoom.players.get(currentPlayerId!);
      if (p && !p.connected) {
        currentRoom.players.delete(currentPlayerId!);
        currentRoom.socketMap.delete(socket.id);
        currentRoom.holeCompleted.delete(currentPlayerId!);
        currentRoom.readyForNext.delete(currentPlayerId!);
        emitPlayerList(currentRoom);
        if (currentRoom.players.size === 0) {
          rooms.delete(currentRoom.code);
        }
      }
    }, 30_000);
  });
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
httpServer.listen(PORT, () => {
  console.log(`socket-golf server running on port ${PORT}`);
});
