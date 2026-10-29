const GAME_ENDPOINT = "/.netlify/functions/game";
const $ = (id) => document.getElementById(id);
const screens = ["home", "lobby", "game", "end"];
const colors = ["#D94A36", "#ff6bb5", "#73dbff", "#ffb35c", "#b99aff", "#68edbd", "#ff8076", "#85a6ff"];
let players = new Map();
let busy = false;
let roomCode = "";
let me = null;
let host = false;
let offset = 0;
let pollTimer = null;
let pollBusy = false;
let phase = "";
let activeRound = 0;
let currentPattern = [];
let beatResults = [];
let roundKinds = [];
let roundHistory = [];
let visibleBeat = -1;
let scheduledRound = 0;
let roundCueTimers = [];
let roundActive = false;
let seenResults = new Set();
let audioCtx = null;
let masterGain = null;
const audioPrefs = loadAudioPrefs();

function loadAudioPrefs() {
  try {
    return { beats: true, effects: true, muted: false, ...JSON.parse(localStorage.getItem("pulseClubAudioPrefs") || "{}") };
  } catch {
    return { beats: true, effects: true, muted: false };
  }
}
function saveAudioPrefs() {
  try { localStorage.setItem("pulseClubAudioPrefs", JSON.stringify(audioPrefs)); } catch {}
}
function initAudio() {
  if (audioCtx) return audioCtx;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) {
      $("audioStatus").textContent = "Audio unavailable here; the visual beat cue still works.";
      return null;
    }
    audioCtx = new Audio();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = audioPrefs.muted ? 0 : 0.75;
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  } catch {
    $("audioStatus").textContent = "Audio unavailable here; the visual beat cue still works.";
    audioCtx = null;
    masterGain = null;
    return null;
  }
}
function unlockAudio() {
  if (!audioPrefs.beats && !audioPrefs.effects) return;
  const context = initAudio();
  if (context && context.state === "suspended") context.resume().catch(() => {});
}
function applyAudioPrefs() {
  $("beatSoundToggle").checked = audioPrefs.beats;
  $("effectSoundToggle").checked = audioPrefs.effects;
  $("audioMute").setAttribute("aria-pressed", String(audioPrefs.muted));
  $("audioMute").textContent = audioPrefs.muted ? "Unmute all" : "Mute all";
  if (masterGain && audioCtx) {
    const now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(audioPrefs.muted ? 0 : 0.75, now, 0.015);
  }
  if (audioPrefs.beats || audioPrefs.effects) unlockAudio();
  saveAudioPrefs();
}
function toneAt(when, frequency, duration, wave, volume) {
  if (!audioCtx || !masterGain || audioPrefs.muted) return;
  try {
    const oscillator = audioCtx.createOscillator();
    const envelope = audioCtx.createGain();
    oscillator.type = wave || "sine";
    oscillator.frequency.setValueAtTime(frequency, when);
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(volume || 0.045, when + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(envelope);
    envelope.connect(masterGain);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    oscillator.start(when);
    oscillator.stop(when + duration + 0.015);
  } catch {}
}
function beatSound(at) {
  if (!roundActive || !audioPrefs.beats || !audioCtx) return;
  const delay = Math.max(0, at - (Date.now() + offset)) / 1000;
  toneAt(audioCtx.currentTime + delay, 740, 0.045, "triangle", 0.025);
}
function resultSound(kind) {
  if (!audioPrefs.effects || !audioCtx) return;
  const now = audioCtx.currentTime;
  if (kind === "perfect") toneAt(now, 880, 0.085, "sine", 0.055);
  else if (kind === "good") toneAt(now, 560, 0.075, "triangle", 0.045);
  else if (kind === "miss") toneAt(now, 190, 0.095, "sine", 0.05);
}
function celebrateSound(delay) {
  if (!audioPrefs.effects || !audioCtx) return;
  const time = audioCtx.currentTime + (delay || 0);
  toneAt(time, 587, 0.075, "sine", 0.045);
  toneAt(time + 0.085, 784, 0.09, "triangle", 0.045);
  toneAt(time + 0.18, 988, 0.12, "sine", 0.045);
}
function streakSound(delay) {
  if (!audioPrefs.effects || !audioCtx) return;
  const time = audioCtx.currentTime + (delay || 0);
  toneAt(time, 698, 0.045, "sine", 0.04);
  toneAt(time + 0.055, 932, 0.06, "triangle", 0.04);
}
function setupAudioControls() {
  $("beatSoundToggle").checked = audioPrefs.beats;
  $("effectSoundToggle").checked = audioPrefs.effects;
  $("audioMute").setAttribute("aria-pressed", String(audioPrefs.muted));
  $("audioMute").textContent = audioPrefs.muted ? "Unmute all" : "Mute all";
  $("beatSoundToggle").onchange = (event) => { audioPrefs.beats = event.target.checked; applyAudioPrefs(); };
  $("effectSoundToggle").onchange = (event) => { audioPrefs.effects = event.target.checked; applyAudioPrefs(); };
  $("audioMute").onclick = () => { audioPrefs.muted = !audioPrefs.muted; applyAudioPrefs(); };
}

function view(id) {
  screens.forEach((screen) => $(screen).classList.toggle("active", screen === id));
}
function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
function audioGesture() { unlockAudio(); }
function displayName(value) {
  return (value || "Player").trim().slice(0, 16) || "Player";
}
async function api(payload) {
  const response = await fetch(GAME_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The room service could not complete that action.");
  return body;
}
function setPlayers(list) {
  players = new Map(list.map((player) => [player.id, { ...player }]));
}
function renderLobby() {
  const list = Array.from(players.values());
  const roster = $("lobbyRoster");
  roster.innerHTML = "";
  list.forEach((player) => {
    const item = document.createElement("div");
    item.className = "player";
    item.innerHTML = '<span class="avatar" style="color:' + colors[player.color % colors.length] + '">' +
      esc(player.name.slice(0, 1).toUpperCase()) + "</span> " + esc(player.name) + " " +
      (player.owner ? "<small>HOST</small>" : player.ready ? '<b class="ready-mark">✓ READY</b>' : "<small>NOT READY</small>");
    roster.append(item);
  });
  for (let i = list.length; i < 8; i += 1) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "OPEN SPOT";
    roster.append(empty);
  }
  $("playerCount").textContent = list.length + "/8";
  $("startBtn").disabled = host && list.length < 2;
  $("startBtn").textContent = host ? "Start match →" : (players.get(me.id).ready ? "Ready ✓" : "Ready");
  $("lobbyHint").textContent = host
    ? "Ready " + list.filter((player) => player.ready && !player.owner).length + "/" + Math.max(0, list.length - 1) + " · You can start anytime."
    : "Tap Ready when set. The host can start anytime.";
}
function renderScores() {
  const rows = $("scoreRows");
  rows.innerHTML = "";
  Array.from(players.values()).sort((a, b) => b.score - a.score).forEach((player) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = "<span>" + esc(player.name) + " 🔥" + (player.streak || 0) + "</span><span>" + (player.score || 0) + "</span>";
    rows.append(row);
  });
}
function clearRoundCues() {
  roundCueTimers.forEach(clearTimeout);
  roundCueTimers = [];
  scheduledRound = 0;
  visibleBeat = -1;
}
function initializeRoundDisplay(round) {
  activeRound = round;
  currentPattern = [];
  beatResults = [];
  roundKinds = [];
  visibleBeat = -1;
  $("roundNum").textContent = String(round);
  $("beatCount").textContent = "— / 12";
  $("roundTime").textContent = "GET READY";
  $("beatTrack").innerHTML = Array.from({ length: 12 }, () => "<i></i>").join("");
}
function renderDots() {
  const dots = Array.from($("beatTrack").children);
  const results = roundHistory[activeRound - 1] || [];
  dots.forEach((dot, index) => {
    const result = results[index] || beatResults[index] || "";
    dot.className = result || (currentPattern[index] === "rest" ? "rest" : "");
    dot.dataset.mark = ({ perfect: "✓", good: "•", miss: "✕", rest: "—" })[result] || "";
    if (index === visibleBeat) dot.classList.add("now");
  });
}
function cue(message) {
  if (message.round !== activeRound || !roundActive) return;
  visibleBeat = message.index;
  roundKinds[message.index] = message.kind;
  if (message.kind === "rest") {
    const restDot = $("beatTrack").children[message.index];
    restDot.className = "rest";
    restDot.dataset.mark = "—";
  }
  const cueElement = $("cue");
  cueElement.classList.remove("hit", "miss", "next", "onbeat", "approach");
  cueElement.classList.add("next");
  setTimeout(() => cueElement.classList.remove("next"), 180);
  $("beatCount").textContent = (message.index + 1) + "/" + message.count;
  $("roundTime").textContent = "BEAT " + (message.index + 1) + " OF " + message.count;
  $("gameStatus").textContent = "FOLLOW THE FLASH";
  $("cueSymbol").textContent = message.kind === "rest" ? "–" : message.kind === "double" ? "Ⅱ" : "♪";
  renderDots();
  $("tapBtn").disabled = false;
  $("tapBtn").textContent = message.kind === "rest" ? "REST — DON’T TAP" : message.kind === "double" ? "DOUBLE TAP" : "TAP";
  const delay = Math.max(0, message.at - (Date.now() + offset));
  const ring = $("cueRing");
  ring.style.animation = "none";
  void ring.offsetWidth;
  ring.style.removeProperty("animation");
  ring.style.setProperty("--ring-ms", Math.max(40, Math.min(250, delay)) + "ms");
  cueElement.classList.add("approach");
  setTimeout(() => {
    cueElement.classList.add("onbeat");
    setTimeout(() => cueElement.classList.remove("onbeat"), 150);
  }, delay);
  beatSound(message.at);
}
function scheduleRound(state) {
  if (scheduledRound === state.round || !state.pattern || state.pattern.length !== 12) return;
  clearRoundCues();
  scheduledRound = state.round;
  activeRound = state.round;
  currentPattern = state.pattern.slice();
  const firstBeatAt = state.beatAt - Math.max(0, state.beatIndex) * state.interval;
  for (let index = 0; index < 12; index += 1) {
    const at = firstBeatAt + index * state.interval;
    const delay = Math.max(0, at - 250 - (Date.now() + offset));
    roundCueTimers.push(setTimeout(() => cue({
      round: state.round,
      index,
      at,
      kind: state.pattern[index],
      count: 12
    }), delay));
  }
}
function updateCountdown(state) {
  view("game");
  roundActive = false;
  if (activeRound !== state.round) {
    clearRoundCues();
    initializeRoundDisplay(state.round);
  }
  $("countdown").classList.add("show");
  const remaining = Math.max(0, state.phaseEndsAt - state.serverNow);
  $("countNum").childNodes[0].textContent = String(Math.max(1, Math.min(3, Math.ceil(remaining / 760))));
  $("countCaption").textContent = "ROUND " + state.round + " · GET READY";
  $("tapBtn").disabled = true;
  $("tapBtn").textContent = "GET READY";
  $("feedback").textContent = "Tap when the outline meets the center beat.";
}
function processNewResults(state) {
  const player = players.get(me.id);
  let firstNew = null;
  (state.ownHistory || []).forEach((round, roundIndex) => {
    (round || []).forEach((result, beatIndex) => {
      if (!result) return;
      const key = roundIndex + ":" + beatIndex;
      if (!seenResults.has(key)) {
        seenResults.add(key);
        if (roundIndex === state.round - 1 && !firstNew) firstNew = { result, beatIndex };
      }
    });
  });
  if (firstNew && roundActive) {
    resultSound(firstNew.result);
    if (player && player.best >= 5 && player.best % 5 === 0 && firstNew.result !== "miss") {
      streakSound(0.1);
    }
    const labels = { perfect: "PERFECT", good: "GOOD", miss: "MISS" };
    $("feedback").textContent = labels[firstNew.result] || "REST";
    $("feedback").style.color = firstNew.result === "perfect" ? "#68edbd" : firstNew.result === "good" ? "#73dbff" : "#ff5368";
    $("cue").classList.remove("hit", "miss");
    $("cue").classList.add(firstNew.result === "miss" ? "miss" : "hit");
  }
  roundHistory = state.ownHistory || [];
  renderDots();
}
function updateGameState(state) {
  setPlayers(state.players);
  renderScores();
  if (state.phase === "closed") {
    stopPolling();
    showHome();
    return;
  }
  if (state.phase === "lobby") {
    roundActive = false;
    clearRoundCues();
    phase = state.phase;
    view("lobby");
    $("roomCode").textContent = roomCode;
    renderLobby();
    return;
  }
  if (state.phase === "countdown") {
    phase = state.phase;
    updateCountdown(state);
    roundHistory = state.ownHistory || [];
    renderScores();
    return;
  }
  if (state.phase === "intermission") {
    phase = state.phase;
    roundActive = false;
    $("countdown").classList.remove("show");
    view("game");
    if (activeRound !== state.round) {
      clearRoundCues();
      initializeRoundDisplay(state.round);
    }
    $("feedback").textContent = "Patterns get trickier. Stay sharp.";
    $("tapBtn").disabled = true;
    $("tapBtn").textContent = "ROUND COMPLETE";
    roundHistory = state.ownHistory || [];
    renderDots();
    return;
  }
  if (state.phase === "playing") {
    view("game");
    $("countdown").classList.remove("show");
    if (activeRound !== state.round) initializeRoundDisplay(state.round);
    roundActive = true;
    phase = state.phase;
    if (scheduledRound !== state.round) scheduleRound(state);
    roundHistory = state.ownHistory || [];
    processNewResults(state);
    return;
  }
  if (state.phase === "finished") {
    roundActive = false;
    phase = state.phase;
    roundHistory = state.ownHistory || [];
    if ($("end").classList.contains("active")) return;
    finish(state);
  }
}
function updateOffset(serverNow, requestStart, requestEnd) {
  const sample = serverNow - (requestStart + requestEnd) / 2;
  offset = offset ? offset * 0.75 + sample * 0.25 : sample;
}
async function poll() {
  if (!roomCode || !me || pollBusy) return;
  pollBusy = true;
  const startedAt = Date.now();
  try {
    const state = await api({ action: "state", roomCode, playerId: me.id });
    updateOffset(state.serverNow, startedAt, Date.now());
    updateGameState(state);
    if (roomCode && phase !== "finished") {
      pollTimer = setTimeout(poll, phase === "lobby" ? 500 : 120);
    }
  } catch (error) {
    if (error.message.includes("closed") || error.message.includes("no longer in the room")) {
      stopPolling();
      showHome();
    } else {
      $("lobbyHint").textContent = error.message;
      pollTimer = setTimeout(poll, 500);
    }
  } finally {
    pollBusy = false;
  }
}
function startPolling() {
  stopPolling();
  pollBusy = false;
  poll();
}
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
function showHome() {
  stopPolling();
  clearRoundCues();
  roundActive = false;
  roomCode = "";
  me = null;
  host = false;
  players = new Map();
  roundHistory = [];
  seenResults.clear();
  view("home");
}
async function goHome() {
  const currentRoom = roomCode;
  const currentPlayer = me;
  showHome();
  if (currentRoom && currentPlayer) {
    try { await api({ action: "leave", roomCode: currentRoom, playerId: currentPlayer.id }); } catch {}
  }
}
async function createRoom() {
  if (busy) return;
  busy = true;
  $("hostError").textContent = "";
  try {
    audioGesture();
    const result = await api({ action: "create", name: displayName($("hostName").value) });
    roomCode = result.roomCode;
    me = { id: result.playerId };
    host = true;
    setPlayers(result.state.players);
    $("roomCode").textContent = roomCode;
    updateGameState(result.state);
    startPolling();
  } catch (error) {
    $("hostError").textContent = error.message || "Could not create room.";
  } finally {
    busy = false;
  }
}
async function joinRoom() {
  if (busy) return;
  const code = $("joinCode").value.trim().toUpperCase();
  if (code.length !== 6) {
    $("joinError").textContent = "Enter the six-character room code.";
    return;
  }
  busy = true;
  $("joinError").textContent = "";
  try {
    audioGesture();
    const result = await api({ action: "join", roomCode: code, name: displayName($("joinName").value) });
    roomCode = result.roomCode;
    me = { id: result.playerId };
    host = false;
    setPlayers(result.state.players);
    $("roomCode").textContent = roomCode;
    updateGameState(result.state);
    startPolling();
  } catch (error) {
    $("joinError").textContent = error.message || "Could not join room.";
  } finally {
    busy = false;
  }
}
async function startMatch() {
  audioGesture();
  if (host) {
    try {
      const state = await api({ action: "start", roomCode, playerId: me.id });
      updateGameState(state);
    } catch (error) { $("lobbyHint").textContent = error.message; }
  } else {
    const player = players.get(me.id);
    try {
      const state = await api({ action: "ready", roomCode, playerId: me.id, ready: !player.ready });
      updateGameState(state);
    } catch (error) { $("lobbyHint").textContent = error.message; }
  }
}
function tap() {
  if (!roundActive || $("tapBtn").disabled || !me || !roomCode) return;
  audioGesture();
  api({
    action: "tap",
    roomCode,
    playerId: me.id,
    tapAt: Date.now() + offset,
    tapId: crypto.randomUUID()
  }).catch((error) => { $("feedback").textContent = error.message; });
}
function ordinal(number) {
  const mod = number % 100;
  if (mod >= 11 && mod <= 13) return number + "th";
  return number + (number % 10 === 1 ? "st" : number % 10 === 2 ? "nd" : number % 10 === 3 ? "rd" : "th");
}
function shareText() {
  const player = players.get(me.id) || { name: "Player", score: 0 };
  const sorted = Array.from(players.values()).sort((a, b) => b.score - a.score);
  const rank = sorted.findIndex((item) => item.score === player.score) + 1;
  const icons = { perfect: "✓🟢", good: "•🔵", miss: "✕🔴", rest: "—⚪" };
  const rounds = roundHistory.slice().map((round, index) =>
    "ROUND " + (index + 1) + " · " + (round || []).map((result) => icons[result] || icons.rest).join("  ")
  );
  const total = { perfect: 0, good: 0, miss: 0, rest: 0 };
  roundHistory.forEach((round) => (round || []).forEach((result) => { if (Object.hasOwn(total, result)) total[result] += 1; }));
  const scored = total.perfect + total.good + total.miss;
  return [
    "PULSE CLUB · RHYTHM SHOWDOWN",
    player.name + " · " + ordinal(rank) + (sorted.filter((item) => item.score === player.score).length > 1 ? " (tie)" : "") +
      " place of " + sorted.length + " · " + player.score.toLocaleString() + " points",
    "",
    "ROUND RESULTS · BEATS IN ORDER",
    ...rounds,
    "",
    total.perfect + " perfect · " + total.good + " good · " + total.miss + " missed",
    scored + " beats scored · " + total.rest + " rests",
    "Rest beats don’t count toward your score.",
    "",
    "BRING PULSE CLUB TO YOUR NEXT HANGOUT",
    "Host a room, share the code, and challenge up to 7 friends!"
  ].join("\n");
}
function renderSummary() {
  const box = $("sharePreview");
  box.value = shareText();
  box.style.height = "auto";
  requestAnimationFrame(resizeSummary);
}
function resizeSummary() {
  const box = $("sharePreview");
  if (!$("end").classList.contains("active")) return;
  box.style.height = "auto";
  box.style.height = box.scrollHeight + "px";
}

function funnyLines(list) {
    let top = list[0],
        bestScore = top.score,
        leaders = list.filter((p) => p.score === bestScore).map((p) => p.name),
        best = Math.max(...list.map((p) => p.best)),
        streakLeaders = list.filter((p) => p.best === best).map((p) => p.name),
        totals = { perfect: 0, good: 0, miss: 0, rest: 0 };
    roundHistory.forEach((r) =>
        (Array.isArray(r) ? r : r?.results || []).forEach((x) => {
            if (Object.hasOwn(totals, x)) totals[x]++;
        })
    );
    let names = leaders.join(" & "),
        streakNames = streakLeaders.join(" & "),
        pick = (a) => a[Math.floor(Math.random() * a.length)],
        winnerLines = [
            `${names} landed on top with ${bestScore.toLocaleString()} points.`,
            `${bestScore.toLocaleString()} points put ${names} at the head of the room.`,
            `The scoreboard's top spot belongs to ${names} with ${bestScore.toLocaleString()}.`,
            `At ${bestScore.toLocaleString()} points, ${names} set the pace.`,
            `Top score: ${bestScore.toLocaleString()}, posted by ${names}.`,
            `The night's highest total was ${bestScore.toLocaleString()} for ${names}.`,
            `The final score leaders are ${names} at ${bestScore.toLocaleString()} points.`,
            `The lead changed hands? The final board says ${names}: ${bestScore.toLocaleString()} points.`,
            `A ${bestScore.toLocaleString()}-point finish puts ${names} in the spotlight.`,
            `The room's high-water mark was ${bestScore.toLocaleString()}, reached by ${names}.`,
            `Give the top line a look: ${names} with ${bestScore.toLocaleString()}.`,
            `The final tally puts ${names} first${leaders.length > 1 ? " together" : ""} at ${bestScore.toLocaleString()} points.`,
            `The rhythm report's headline score is ${bestScore.toLocaleString()} by ${names}.`,
            `The top of the table reads ${names} — ${bestScore.toLocaleString()} points.`,
            `The biggest point total belongs to ${names}: ${bestScore.toLocaleString()}.`,
            `The closing scoreboard gives ${names} ${bestScore.toLocaleString()} points and the lead.`,
            `The room's top result: ${names}, ${bestScore.toLocaleString()} points.`,
            `A final score of ${bestScore.toLocaleString()} leaves ${names} at the top.`,
            `The points column peaks at ${bestScore.toLocaleString()} for ${names}.`,
            `Tonight's highest score goes beside ${names}: ${bestScore.toLocaleString()}.`,
        ],
        streakLines = [
            `${streakNames} led the hit-streak chart with ${best} successful beats in a row.`,
            `Longest successful run: ${best} beats, led by ${streakNames}.`,
            `${streakNames} put together the longest run: ${best} good or perfect beats.`,
            `The streak counter topped out at ${best} for ${streakNames}.`,
            `${streakNames} kept the successful beats flowing for a best of ${best}.`,
            `Best run of good/perfect beats: ${best}, by ${streakNames}.`,
            `${streakNames} owns the longest hit streak at ${best} beats.`,
            `A ${best}-beat successful streak was the night's longest, led by ${streakNames}.`,
            `The longest chain of successful beats reached ${best} for ${streakNames}.`,
            `Streak stat: ${streakNames} reached ${best} consecutive good or perfect beats.`,
            `${streakNames} posted the top streak: ${best} successful beats without a miss.`,
            `The best hit run measured ${best} beats; ${streakNames} led the way.`,
            `${streakNames} stretched a good/perfect run to ${best} beats.`,
            `The rhythm streak record for this room is ${best}, shared by ${streakNames}.`,
            `${streakNames} set the best consecutive-hit mark at ${best}.`,
        ],
        resultLines = [
            `Your rounds counted ${totals.perfect} perfect, ${totals.good} good, ${totals.miss} missed, and ${totals.rest} rest beats.`,
            `Your beat ledger: ${totals.perfect} perfect · ${totals.good} good · ${totals.miss} missed · ${totals.rest} rest.`,
            `Across your rounds, ${totals.perfect} beats were perfect and ${totals.good} were good; ${totals.miss} were missed, with ${totals.rest} rests.`,
            `Your tally came to ${totals.perfect} perfects, ${totals.good} goods, ${totals.miss} misses, plus ${totals.rest} rests.`,
            `Beat-by-beat: ${totals.perfect} perfect, ${totals.good} good, ${totals.miss} missed, and ${totals.rest} rests for you.`,
            `The recap shows ${totals.perfect} perfects, ${totals.good} goods, ${totals.miss} misses, and ${totals.rest} rest beats.`,
            `Your scorecard has ${totals.perfect} perfect, ${totals.good} good, and ${totals.miss} missed beats; rests: ${totals.rest}.`,
            `Your rounds add up to ${totals.perfect} perfect, ${totals.good} good, ${totals.miss} missed, and ${totals.rest} rest beats.`,
            `The personal beat count: ${totals.perfect} perfect · ${totals.good} good · ${totals.miss} missed · ${totals.rest} rest.`,
            `You recorded ${totals.perfect} perfects and ${totals.good} goods, alongside ${totals.miss} misses and ${totals.rest} rests.`,
            `The stats say ${totals.perfect} perfect, ${totals.good} good, ${totals.miss} missed beats, and ${totals.rest} rests for your run.`,
            `Your night in numbers: ${totals.perfect} perfect, ${totals.good} good, ${totals.miss} missed, ${totals.rest} rest.`,
            `Your beat report lists ${totals.perfect} perfects, ${totals.good} goods, ${totals.miss} misses, and ${totals.rest} rests.`,
            `Final count for your run: ${totals.perfect} perfect · ${totals.good} good · ${totals.miss} miss · ${totals.rest} rest.`,
            `The rhythm recap tallies ${totals.perfect} perfects, ${totals.good} goods, ${totals.miss} misses, and ${totals.rest} rests.`,
        ];
    return [pick(winnerLines), pick(streakLines), pick(resultLines)];
}
function finish(state) {
  const list = state.players.slice().sort((a, b) => b.score - a.score);
  const tie = state.draw || (list.length > 1 && list[0].score === list[1].score);
  if (audioCtx && (state.winner === me.id || (tie && list[0].score === players.get(me.id).score))) celebrateSound(0.03);
  $("endTitle").textContent = tie ? "A shared crown!" : list.find((player) => player.id === state.winner).name + " takes the crown!";
  $("endSubtitle").textContent = tie
    ? list.filter((player) => player.score === list[0].score).map((player) => player.name).join(" & ") +
      " tied on " + list[0].score.toLocaleString() + " points · " + list.length + " players · " + state.roundCount + " rounds"
    : list.length + " players · " + state.roundCount + " rounds · " + list[0].score.toLocaleString() + " points";
  let rank = 0;
  let previous = null;
  $("podium").innerHTML = list.filter((player) => player.score >= list[Math.min(2, list.length - 1)].score).map((player, index) => {
    if (player.score !== previous) { rank = index + 1; previous = player.score; }
    const tier = rank === 1 ? "first" : rank === 2 ? "second" : "third";
    const medal = rank === 1 ? "👑" : rank === 2 ? "🥈" : "🥉";
    const tied = list.filter((other) => other.score === player.score).length > 1;
    return '<div class="pod ' + tier + '"><span class="rank-label">' + medal + " " +
      (rank === 1 ? "1ST" : rank === 2 ? "2ND" : "3RD") + ' PLACE</span>' +
      (tied ? '<span class="tie-label">TIED</span>' : "") + "<b>" + esc(player.name) + "</b><em>" +
      player.score.toLocaleString() + " PTS</em></div>";
  }).join("");
  $("recapLines").innerHTML = funnyLines(list).map((line) => '<div class="line">' + esc(line) + "</div>").join("");
  rank = 0;
  previous = null;
  $("finalScores").innerHTML = list.map((player, index) => {
    if (player.score !== previous) { rank = index + 1; previous = player.score; }
    const tied = list.filter((other) => other.score === player.score).length > 1;
    return '<div class="row"><span>' + rank + ". " + esc(player.name) + (tied ? " · tied" : "") +
      " · best hit streak " + player.best + '</span><span>' + player.score.toLocaleString() + " PTS</span></div>";
  }).join("");
  view("end");
  renderSummary();
}
async function playAgain() {
  try {
    const state = await api({ action: "again", roomCode, playerId: me.id });
    roundHistory = [];
    seenResults.clear();
    phase = "";
    activeRound = 0;
    clearRoundCues();
    updateGameState(state);
    startPolling();
  } catch (error) {
    $("endSubtitle").textContent = error.message;
  }
}
function setupEvents() {
  setupAudioControls();
  $("createBtn").onclick = createRoom;
  $("joinBtn").onclick = joinRoom;
  $("joinCode").oninput = (event) => { event.target.value = event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase(); };
  $("joinCode").onkeydown = (event) => { if (event.key === "Enter") { audioGesture(); joinRoom(); } };
  $("startBtn").onclick = startMatch;
  $("tapBtn").addEventListener("pointerdown", (event) => { event.preventDefault(); audioGesture(); tap(); });
  $("copyCode").onclick = async () => {
    try { await navigator.clipboard.writeText($("roomCode").textContent); } catch {}
    $("toast").textContent = $("roomCode").textContent;
    $("toast").classList.add("show");
    setTimeout(() => $("toast").classList.remove("show"), 1600);
  };
  $("playAgainBtn").onclick = playAgain;
  $("brandHome").onclick = (event) => { event.preventDefault(); goHome(); };
  $("lobbyHomeBtn").onclick = goHome;
  window.addEventListener("resize", () => {
    if ($("end").classList.contains("active")) requestAnimationFrame(resizeSummary);
  });
}
setupEvents();


