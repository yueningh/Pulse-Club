import { randomInt, randomUUID } from "node:crypto";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BEATS_PER_ROUND = 12;
const START_COUNTDOWN_MS = 2280;
const BETWEEN_ROUNDS_MS = 1200;
const RESULT_GRACE_MS = 550;
const FINAL_BEAT_GRACE_MS = 650;
const ROOM_LIFETIME_MS = 8 * 60 * 60 * 1000;

export class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return code;
}

function safeName(input) {
  return String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16) || "Player";
}

function isDefaultName(name) {
  return /^Player(?:\s+\d+)?$/i.test(name.trim());
}

function assignedName(input, players, joining) {
  const name = safeName(input);
  const used = new Set(players.map((player) => player.name.trim().toLowerCase()));
  if (!isDefaultName(name)) {
    if (joining && used.has(name.toLowerCase())) {
      throw new GameError(409, "That name is already in this room. Choose a different name.");
    }
    return name;
  }
  if (name.toLowerCase() === "player" && !used.has("player")) return "Player";
  let number = 1;
  while (used.has("player " + number)) number += 1;
  return "Player " + number;
}

function randomIntBetween(min, max) {
  return min + randomInt(max - min + 1);
}

function shuffledPositions() {
  const values = Array.from({ length: BEATS_PER_ROUND }, (_, index) => index);
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function generatePattern(round) {
  const doubles = round === 1
    ? randomIntBetween(0, 1)
    : round === 2
      ? randomIntBetween(1, 2)
      : round === 3
        ? randomIntBetween(2, 3)
        : round === 4
          ? randomIntBetween(3, 4)
          : randomIntBetween(4, 5);
  const rests = round < 3
    ? 0
    : round === 3
      ? randomIntBetween(1, 2)
      : round === 4
        ? randomIntBetween(2, 3)
        : randomIntBetween(3, 4);
  const result = Array(BEATS_PER_ROUND).fill("tap");
  const positions = shuffledPositions();
  for (let i = 0; i < rests; i += 1) result[positions[i]] = "rest";
  for (let i = rests; i < rests + doubles; i += 1) result[positions[i]] = "double";
  return result;
}

export function generatePatterns(roundLimit = 5, patternFactory = generatePattern) {
  const patterns = [];
  const previous = [];
  for (let round = 1; round <= roundLimit; round += 1) {
    let pattern = patternFactory(round);
    let attempts = 0;
    while (previous.includes(pattern.join(",")) && attempts < 30) {
      pattern = patternFactory(round);
      attempts += 1;
    }
    previous.push(pattern.join(","));
    patterns.push(pattern);
  }
  return patterns;
}

function award(player, result) {
  if (result === "miss") {
    player.score -= 10;
    player.streak = 0;
    return;
  }
  if (result === "rest") return;
  player.score += result === "perfect" ? 100 : 60;
  player.streak += 1;
  player.best = Math.max(player.best, player.streak);
  if (player.streak % 5 === 0) player.score += 25;
}

function recordResult(room, player, beat, result) {
  const roundResults = player.history[room.round - 1] || Array(BEATS_PER_ROUND).fill(null);
  roundResults[beat] = result;
  player.history[room.round - 1] = roundResults;
  award(player, result);
}

function resolveBeat(room, beat, beatAt) {
  const kind = room.patterns[room.round - 1][beat];
  for (const player of room.players) {
    const taps = room.hits
      .filter((hit) => hit.playerId === player.id && hit.at >= beatAt - 320 && hit.at <= beatAt + 320)
      .sort((a, b) => a.at - b.at);
    let result;
    if (kind === "rest") {
      result = taps.length ? "miss" : "rest";
    } else if (kind === "double") {
      if (taps.length < 2) {
        result = "miss";
      } else {
        const spread = Math.max(Math.abs(taps[0].at - beatAt), Math.abs(taps[1].at - beatAt));
        result = spread <= 150 ? "perfect" : "good";
      }
    } else if (taps.length === 0) {
      result = "miss";
    } else {
      const distance = Math.min(...taps.map((tap) => Math.abs(tap.at - beatAt)));
      result = distance <= 150 ? "perfect" : distance <= 320 ? "good" : "miss";
    }
    recordResult(room, player, beat, result);
  }
  room.hits = room.hits.filter((hit) => hit.at > beatAt + 320);
}

function finishRoom(room) {
  room.phase = "finished";
  const ordered = [...room.players].sort((a, b) => b.score - a.score);
  room.draw = ordered.length > 1 && ordered[0].score === ordered[1].score;
  room.winner = room.draw ? null : ordered[0]?.id ?? null;
  room.finishedAt = room.beatAt + FINAL_BEAT_GRACE_MS;
}

export function advanceRoom(room, now, roundLimit = 5) {
  let changed = false;
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    if (room.phase === "countdown" && now >= room.phaseEndsAt) {
      room.phase = "playing";
      room.beatIndex = 0;
      room.beatAt = room.phaseEndsAt + RESULT_GRACE_MS;
      room.interval = Math.max(570, 900 - (room.round - 1) * 65);
      changed = true;
      continue;
    }
    if (room.phase === "playing" && room.beatIndex >= 0) {
      const currentBeat = room.beatIndex;
      const currentBeatAt = room.beatAt;
      if (now < currentBeatAt + RESULT_GRACE_MS) break;
      resolveBeat(room, currentBeat, currentBeatAt);
      changed = true;
      if (currentBeat < BEATS_PER_ROUND - 1) {
        room.beatIndex = currentBeat + 1;
        room.beatAt = currentBeatAt + room.interval;
        continue;
      }
      if (room.round >= roundLimit) {
        finishRoom(room);
        break;
      }
      room.round += 1;
      room.phase = "intermission";
      room.phaseEndsAt = currentBeatAt + FINAL_BEAT_GRACE_MS + BETWEEN_ROUNDS_MS;
      room.beatIndex = -1;
      continue;
    }
    if (room.phase === "intermission" && now >= room.phaseEndsAt) {
      room.phase = "countdown";
      room.phaseEndsAt += START_COUNTDOWN_MS;
      changed = true;
      continue;
    }
    break;
  }
  return changed;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    owner: player.owner,
    score: player.score,
    streak: player.streak,
    best: player.best,
    ready: player.ready
  };
}

function snapshot(room, playerId, now, roundLimit) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) throw new GameError(403, "This player is no longer in the room.");
  return {
    roomCode: room.code,
    phase: room.phase,
    round: room.round,
    roundCount: roundLimit,
    count: BEATS_PER_ROUND,
    beatIndex: room.beatIndex,
    beatAt: room.beatAt,
    interval: room.interval,
    phaseEndsAt: room.phaseEndsAt,
    pattern: room.round > 0 ? room.patterns[room.round - 1] : [],
    players: room.players.map(publicPlayer),
    ownHistory: player.history,
    winner: room.winner,
    draw: room.draw,
    serverNow: now
  };
}

export function createGameService({
  store,
  roundLimit = 5,
  now = Date.now,
  codeFactory = makeRoomCode,
  tokenFactory = randomUUID,
  patternFactory = generatePattern
}) {
  if (!store) throw new Error("A Blobs-compatible store is required.");

  async function load(key) {
    const entry = await store.getWithMetadata(key, { consistency: "strong", type: "json" });
    if (!entry || !entry.data) throw new GameError(404, "Room not found. Check the room code.");
    return entry;
  }

  async function transact(roomCode, mutate) {
    const code = String(roomCode || "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new GameError(400, "Enter the six-character room code.");
    const key = "room-" + code;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const entry = await load(key);
      const room = entry.data;
      const time = now();
      if (room.expiresAt <= time && room.phase !== "closed") {
        room.phase = "closed";
        room.closedReason = "expired";
      }
      if (room.phase === "closed") throw new GameError(410, "This room is closed.");
      const changedByClock = advanceRoom(room, time, roundLimit);
      const result = mutate(room, time);
      if (!changedByClock && !result.changed) {
        return result.value(room, time);
      }
      const write = await store.setJSON(key, room, { onlyIfMatch: entry.etag });
      // An empty ETag is treated as a failed write; it can indicate a storage error.
      if (write.modified && write.etag) return result.value(room, time);
      if (write.modified && !write.etag) throw new GameError(503, "Room storage could not confirm the update. Please retry.");
    }
    throw new GameError(409, "The room is busy. Please retry.");
  }

  async function create(input) {
    const playerId = tokenFactory();
    const hostName = assignedName(input.name, [], false);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = String(codeFactory()).toUpperCase();
      const room = {
        code,
        phase: "lobby",
        hostId: playerId,
        players: [{
          id: playerId,
          name: hostName,
          color: 0,
          owner: true,
          score: 0,
          streak: 0,
          best: 0,
          ready: false,
          history: []
        }],
        round: 0,
        roundLimit,
        patterns: [],
        beatIndex: -1,
        beatAt: 0,
        interval: 0,
        phaseEndsAt: 0,
        hits: [],
        winner: null,
        draw: false,
        expiresAt: now() + ROOM_LIFETIME_MS
      };
      const key = "room-" + code;
      const write = await store.setJSON(key, room, { onlyIfNew: true });
      if (write.modified && write.etag) {
        return { roomCode: code, playerId, host: true, state: snapshot(room, playerId, now(), roundLimit) };
      }
      if (write.modified && !write.etag) throw new GameError(503, "Room storage could not confirm creation. Please retry.");
    }
    throw new GameError(503, "Could not create a room right now. Please try again.");
  }

  async function join(input) {
    const code = String(input.roomCode || "").toUpperCase();
    const playerId = tokenFactory();
    return transact(code, (room, time) => {
      if (room.phase !== "lobby") throw new GameError(409, "This match has already started.");
      if (room.players.length >= 8) throw new GameError(409, "This room already has 8 players.");
      const name = assignedName(input.name, room.players, true);
      const player = {
        id: playerId,
        name,
        color: room.players.length % 8,
        owner: false,
        score: 0,
        streak: 0,
        best: 0,
        ready: false,
        history: []
      };
      room.players.push(player);
      return {
        changed: true,
        value: (updated) => ({
          roomCode: code,
          playerId,
          host: false,
          state: snapshot(updated, playerId, time, roundLimit)
        })
      };
    });
  }

  async function execute(input) {
    try {
      if (!input || typeof input !== "object") throw new GameError(400, "Invalid request.");
      const action = input.action;
      if (action === "create") return { status: 200, body: await create(input) };
      if (action === "join") return { status: 200, body: await join(input) };
      const roomCode = String(input.roomCode || "").toUpperCase();
      const playerId = String(input.playerId || "");
      if (!playerId) throw new GameError(401, "Join the room before playing.");

      const body = await transact(roomCode, (room, time) => {
        const player = room.players.find((item) => item.id === playerId);
        if (!player) throw new GameError(403, "This player is no longer in the room.");
        if (action === "state") {
          return { changed: false, value: (updated, currentTime) => snapshot(updated, playerId, currentTime, roundLimit) };
        }
        if (action === "ready") {
          if (room.phase !== "lobby") throw new GameError(409, "The match has already started.");
          const ready = Boolean(input.ready);
          if (player.ready === ready) {
            return { changed: false, value: (updated, currentTime) => snapshot(updated, playerId, currentTime, roundLimit) };
          }
          player.ready = ready;
          return { changed: true, value: (updated, currentTime) => snapshot(updated, playerId, currentTime, roundLimit) };
        }
        if (action === "again") {
          if (room.phase !== "finished") throw new GameError(409, "The match is not finished yet.");
          room.players.forEach((item) => {
            item.score = 0;
            item.streak = 0;
            item.best = 0;
            item.ready = false;
            item.history = [];
          });
          room.phase = "lobby";
          room.round = 0;
          room.patterns = [];
          room.beatIndex = -1;
          room.beatAt = 0;
          room.interval = 0;
          room.phaseEndsAt = 0;
          room.hits = [];
          room.winner = null;
          room.draw = false;
          return { changed: true, value: (updated, currentTime) => snapshot(updated, playerId, currentTime, roundLimit) };
        }
        if (action === "start") {
          if (player.id !== room.hostId) throw new GameError(403, "Only the host can start the match.");
          if (room.phase !== "lobby") throw new GameError(409, "The match is already in progress.");
          if (room.players.length < 2) throw new GameError(409, "Invite at least one more player to start.");
          room.players.forEach((item) => {
            item.score = 0;
            item.streak = 0;
            item.best = 0;
            item.ready = false;
            item.history = [];
          });
          room.patterns = generatePatterns(roundLimit, patternFactory);
          room.round = 1;
          room.beatIndex = -1;
          room.beatAt = 0;
          room.interval = 0;
          room.phase = "countdown";
          room.phaseEndsAt = time + START_COUNTDOWN_MS;
          room.hits = [];
          room.winner = null;
          room.draw = false;
          return { changed: true, value: (updated, currentTime) => snapshot(updated, playerId, currentTime, roundLimit) };
        }
        if (action === "tap") {
          if (room.phase !== "playing") throw new GameError(409, "The beat is not active.");
          if (!Number.isFinite(input.tapAt) || Math.abs(Number(input.tapAt) - time) > 1200) {
            throw new GameError(400, "Tap timing was invalid. Please try again.");
          }
          const tapId = String(input.tapId || "");
          if (!tapId || tapId.length > 100) throw new GameError(400, "Tap id is required.");
          if (!room.hits.some((hit) => hit.id === tapId)) {
            room.hits.push({ id: tapId, playerId, at: Number(input.tapAt) });
          }
          return { changed: true, value: (updated, currentTime) => snapshot(updated, playerId, currentTime, roundLimit) };
        }
        if (action === "leave") {
          if (playerId === room.hostId) {
            room.phase = "closed";
            room.closedReason = "host-left";
          } else {
            room.players = room.players.filter((item) => item.id !== playerId);
            room.hits = room.hits.filter((hit) => hit.playerId !== playerId);
            if (room.players.length === 0) room.phase = "closed";
          }
          return { changed: true, value: () => ({ left: true }) };
        }
        throw new GameError(400, "Unknown game action.");
      });
      return { status: 200, body };
    } catch (error) {
      if (error instanceof GameError) return { status: error.status, body: { error: error.message } };
      return { status: 500, body: { error: "The room service had a problem. Please retry." } };
    }
  }

  return { execute };
}


export async function handleGameRequest(request, service) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (request.method !== "POST") {
    return Response.json(
      { error: "Use POST for game actions." },
      {
        status: 405,
        headers: {
          ...corsHeaders,
          Allow: "POST, OPTIONS"
        }
      }
    );
  }

  let input;

  try {
    input = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      {
        status: 400,
        headers: corsHeaders
      }
    );
  }

  try {
    const result = await service.execute(input);

    return Response.json(result.body, {
      status: result.status,
      headers: corsHeaders
    });
  } catch (error) {
    console.error("Game request failed:", error);

    return Response.json(
      { error: "The game service encountered an error." },
      {
        status: 500,
        headers: corsHeaders
      }
    );
  }
}
