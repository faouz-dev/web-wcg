const $ = (selector) => document.querySelector(selector);
let currentRoom, pendingAction, toastTimer, reconnectCode;
let playerToken;
let wordPending = false;
const gameClock = new GameClock();
let soundStorage;
try {
  soundStorage = localStorage;
} catch {}
const gameSounds = new GameSounds({ storage: soundStorage, visible: () => !document.hidden });
const soundEvents = new GameSoundEvents((name) => gameSounds.play(name));
let recentRooms = [];
try {
  playerToken = localStorage.getItem('wordchain-token');
  recentRooms = JSON.parse(localStorage.getItem('wordchain-rooms') || '[]');
} catch {}
if (!Array.isArray(recentRooms)) recentRooms = [];
if (!playerToken || !/^[a-zA-Z0-9_-]{20,128}$/.test(playerToken)) {
  playerToken =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
  try {
    localStorage.setItem('wordchain-token', playerToken);
  } catch {}
}
let savedName = '';
try {
  savedName = (localStorage.getItem('wordchain-name') || '').trim().slice(0, 20);
} catch {}
const socket = io({ auth: { token: playerToken } });
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 4500);
}
function resetHome() {
  renderRecent();
  pendingAction = null;
  $('#choice').hidden = false;
  $('#setup').hidden = true;
  ['nickname', 'create', 'join'].forEach((action) => ($(`#${action}-form`).hidden = true));
}
function showStep(step) {
  $('#choice').hidden = true;
  $('#setup').hidden = false;
  ['nickname', 'create', 'join'].forEach(
    (action) => ($(`#${action}-form`).hidden = action !== step),
  );
  $('#setup-title').textContent = {
    nickname: 'Comment on t’appelle ?',
    create: 'Créer une room',
    join: 'Rejoindre une room',
  }[step];
  $('#setup-icon').textContent = { nickname: '☺', create: '＋', join: '↳' }[step];
  $('#identity').hidden = step === 'nickname';
  $('#saved-name').textContent = savedName;
  $(`#${step}-form`).querySelector('input, select').focus();
}
function choose(action) {
  pendingAction = action;
  showStep(savedName ? action : 'nickname');
}
$('#choose-create').onclick = () => choose('create');
$('#choose-join').onclick = () => choose('join');
$('#setup-back').onclick = () => {
  resetHome();
  $('#choose-create').focus();
};
$('#edit-name').onclick = () => {
  $('#nickname').value = savedName;
  showStep('nickname');
};
$('#nickname-form').onsubmit = (event) => {
  event.preventDefault();
  const name = $('#nickname').value.trim();
  if (!name) {
    $('#nickname').setCustomValidity('Entre un pseudo.');
    $('#nickname').reportValidity();
    return;
  }
  savedName = name.slice(0, 20);
  try {
    localStorage.setItem('wordchain-name', savedName);
  } catch {
    toast('Ton pseudo sera conservé pour cette visite uniquement.');
  }
  showStep(pendingAction);
};
$('#nickname').oninput = () => $('#nickname').setCustomValidity('');
function send(event, data, form) {
  if (!socket.connected) return toast('Connexion au serveur en cours. Réessaie dans un instant.');
  if (event === 'game:word') wordPending = true;
  const button = form?.querySelector('button[type=submit]');
  if (button) button.disabled = true;
  socket.timeout(8000).emit(event, data, (err, result) => {
    if (button) button.disabled = false;
    if (event === 'game:word') {
      wordPending = false;
      updateTurnClock();
    }
    if (err) return toast('Le serveur ne répond pas. Réessaie.');
    if (result?.error) {
      if (event === 'game:word' && data.turnId === currentRoom?.turnId) gameSounds.play('rejected');
      return toast(result.error);
    }
    if (event === 'game:word') {
      $('#word').value = '';
      updateTurnClock();
    }
  });
}
['create', 'join'].forEach((action) => {
  $(`#${action}-form`).onsubmit = (event) => {
    event.preventDefault();
    if (!savedName) return choose(action);
    const data = Object.fromEntries(new FormData(event.target));
    if (action === 'join') data.code = data.code.trim().toUpperCase();
    send(`room:${action}`, { ...data, name: savedName, token: playerToken }, event.target);
  };
});
$('#join-form input[name=code]').oninput = (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
};
$('#leave').onclick = () => {
  socket.emit('room:leave');
  soundEvents.reset();
  gameSounds.stop();
  reconnectCode = null;
  history.replaceState(null, '', '/');
  currentRoom = null;
  resetHome();
  $('#home').hidden = false;
  $('#room').hidden = true;
};
$('#copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(currentRoom.code);
    toast('Code copié !');
  } catch {
    toast(`Code de la room : ${currentRoom.code}`);
  }
};
$('#start').onclick = () => {
  if (!socket.connected) return toast('Connexion interrompue.');
  $('#start').disabled = true;
  socket.timeout(8000).emit('game:start', (err, result) => {
    $('#start').disabled = false;
    if (err) toast('Le serveur ne répond pas.');
    else if (result?.error) toast(result.error);
  });
};
$('#word-form').onsubmit = (event) => {
  event.preventDefault();
  send('game:word', { word: $('#word').value, turnId: currentRoom?.turnId }, event.target);
};
socket.on('room:state', (room) => {
  soundEvents.onState(room, socket.id);
  const justEnded = currentRoom?.started && !room.started;
  if (justEnded) selectTab('stats');
  const turnChanged = currentRoom?.turnId !== room.turnId;
  if (turnChanged) $('#word').value = '';
  if (currentRoom?.code !== room.code) selectTab('play');
  gameClock.observe(room.serverTime);
  currentRoom = room;
  reconnectCode = room.code;
  history.replaceState(null, '', '/room/' + room.code);
  recentRooms = [
    { code: room.code, lang: room.lang, expiresAt: room.expiresAt },
    ...recentRooms.filter((item) => item.code !== room.code),
  ].slice(0, 8);
  try {
    localStorage.setItem('wordchain-rooms', JSON.stringify(recentRooms));
  } catch {}
  renderStats(room);

  $('#end-game').hidden = !room.started || room.host !== socket.id;
  $('#home').hidden = true;
  $('#room').hidden = false;
  $('#copy-code').textContent = room.code;
  $('#room-language').textContent =
    room.lang === 'fr' ? 'Dictionnaire français' : 'English dictionary';
  $('#player-count').textContent = `(${room.players.length}/8)`;
  renderSidebar(room);
  $('#waiting-title').textContent = room.games.length
    ? 'Prêts pour la prochaine ?'
    : 'Ta room est prête.';
  $('#start').textContent = room.games.length ? 'Nouvelle partie →' : 'C’est parti ! →';
  $('#waiting').hidden = room.started;
  $('#game').hidden = !room.started;
  $('#start').hidden = room.host !== socket.id;
  $('#start').disabled = false;
  $('#host-note').textContent =
    room.host === socket.id
      ? 'Commence en solo ou invite tes amis.'
      : 'En attente du lancement par l’hôte.';
  const myTurn = room.turn === socket.id;
  $('#turn-label').textContent = myTurn
    ? 'À TOI DE JOUER !'
    : `AU TOUR DE ${room.players.find((player) => player.id === room.turn)?.name || '…'}`;
  $('#turn-label').classList.toggle('your-turn', myTurn);
  const nextPlayer = room.players.find((player) => player.id === room.nextTurn);
  $('#next-turn-label').textContent = nextPlayer
    ? `À suivre : ${nextPlayer.id === socket.id ? 'toi' : nextPlayer.name}`
    : '';
  $('#next-turn-label').hidden = !room.started || !nextPlayer;
  $('#letter').textContent = room.letter;
  $('#round-label').textContent = `Tour ${room.round} · ${room.minLength} lettres minimum`;
  $('#word-prompt').textContent =
    `${myTurn ? 'Trouve un mot' : 'Le mot attendu'} qui commence par ${room.letter.toUpperCase()} et contient au moins ${room.minLength} lettres.`;
  $('#turn-event').textContent =
    room.lastEvent?.type === 'timeout'
      ? `Temps écoulé pour ${room.lastEvent.name}. Joueur éliminé.`
      : '';
  $('#word').disabled = !myTurn;
  updateTurnClock();
  $('#history').replaceChildren();
  room.history.slice(-30).forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'history-item';
    chip.textContent = item.word;
    const name = document.createElement('small');
    name.textContent = item.name;
    chip.append(name);
    $('#history').append(chip);
  });
  if (room.started && myTurn && turnChanged && !$('#word-form').hidden && !$('#panel-play').hidden)
    $('#word').focus();
});
socket.on('disconnect', () => {
  soundEvents.reset();
  gameSounds.stop();
  if (currentRoom) {
    updateTurnClock();
    $('#word').disabled = true;
    $('#word-form button').disabled = true;
    $('#start').disabled = true;
    $('#end-game').disabled = true;
    toast('Connexion perdue. Reconnexion à la room en cours…');
  }
});
socket.on('connect', () => {
  synchronizeClock();
  $('#end-game').disabled = false;
  if (!reconnectCode) return;
  socket
    .timeout(8000)
    .emit(
      'room:join',
      { code: reconnectCode, name: savedName, token: playerToken },
      (err, result) => {
        if (err || result?.error) {
          currentRoom = null;
          resetHome();
          $('#home').hidden = false;
          $('#room').hidden = true;
          toast(result?.error || 'Reconnexion impossible. Réessaie avec le code de la room.');
        }
      },
    );
});
socket.on('connect_error', () =>
  toast('Connexion impossible. Vérifie que le serveur est démarré.'),
);

function selectTab(tab) {
  for (const name of ['play', 'stats']) {
    $('#panel-' + name).hidden = name !== tab;
    $('#tab-' + name).setAttribute('aria-selected', String(name === tab));
    $('#tab-' + name).tabIndex = name === tab ? 0 : -1;
  }
}
for (const tab of ['play', 'stats']) {
  $('#tab-' + tab).onclick = () => selectTab(tab);
  $('#tab-' + tab).onkeydown = (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = ['play', 'stats'];
      const next =
        event.key === 'Home'
          ? 'play'
          : event.key === 'End'
            ? 'stats'
            : tabs[
                (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
                  tabs.length
              ];
      selectTab(next);
      $('#tab-' + next).focus();
    }
  };
}
$('#end-game').onclick = () => {
  if (!socket.connected) return toast('Connexion interrompue.');
  $('#end-game').disabled = true;
  socket.timeout(8000).emit('game:end', (err, result) => {
    $('#end-game').disabled = false;
    if (err || result?.error) return toast(result?.error || 'Le serveur ne répond pas.');
    selectTab('stats');
    toast('Partie terminée. Les scores sont enregistrés !');
  });
};
$('#copy-link').onclick = async () => {
  const link = new URL('/room/' + currentRoom.code, location.origin);
  try {
    await navigator.clipboard.writeText(link.href);
    toast('Lien de la room copié !');
  } catch {
    toast(link.href);
  }
};
function renderRecent() {
  $('#recent-list').replaceChildren();
  const valid = recentRooms.filter(
    (item) => /^[A-Z0-9]{6}$/.test(item.code) && item.expiresAt > Date.now(),
  );
  $('#recent-rooms').hidden = !valid.length;
  valid.forEach((item) => {
    const button = document.createElement('button');
    button.className = 'recent-room';
    button.textContent = item.code + ' ↗';
    button.onclick = () => {
      $('#join-form input[name=code]').value = item.code;
      choose('join');
    };
    $('#recent-list').append(button);
  });
}
function renderStats(room) {
  $('#games-total').textContent =
    room.games.length +
    ' partie' +
    (room.games.length === 1 ? '' : 's') +
    ' terminée' +
    (room.games.length === 1 ? '' : 's');
  $('#rankings').replaceChildren();
  room.rankings.forEach((player, index) => {
    const row = document.createElement('tr');
    [
      String(index + 1) + '. ' + player.name,
      player.points,
      player.games,
      player.wins,
      player.best,
    ].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    });
    $('#rankings').append(row);
  });
  $('#past-games').replaceChildren();
  if (!room.games.length) {
    const p = document.createElement('p');
    p.className = 'stats-note';
    p.textContent = 'La première partie reste à écrire.';
    $('#past-games').append(p);
  }
  room.games.forEach((game, index) => {
    const details = document.createElement('details');
    details.className = 'past-game';
    const summary = document.createElement('summary');
    const duration = Math.max(1, Math.round((game.endedAt - game.startedAt) / 60000));
    summary.textContent =
      'Partie ' +
      (room.games.length - index) +
      ' · ' +
      new Date(game.endedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) +
      ' · ' +
      duration +
      ' min';
    details.append(summary);
    const scores = document.createElement('div');
    scores.className = 'past-results';
    game.results
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach((result) => {
        const p = document.createElement('p');
        p.textContent =
          (result.winner ? '★ ' : '') + result.name + ' · ' + result.score + ' points';
        scores.append(p);
      });
    const words = document.createElement('p');
    words.className = 'past-words';
    words.textContent = game.history.map((item) => item.word).join(' → ') || 'Aucun mot joué.';
    details.append(scores, words);
    $('#past-games').append(details);
  });
}
renderRecent();
const invitedCode =
  /^\/room\/([a-z0-9]{6})\/?$/i.exec(location.pathname)?.[1] ||
  new URLSearchParams(location.search).get('room');
if (invitedCode && /^[A-Z0-9]{6}$/i.test(invitedCode)) {
  $('#join-form input[name=code]').value = invitedCode.toUpperCase();
  choose('join');
}

function synchronizeClock() {
  if (!socket.connected) return;
  const sentAt = performance.now();
  socket.timeout(4000).emit('clock:sync', {}, (err, result) => {
    if (!err && result) {
      gameClock.sync(result.serverTime, sentAt);
      updateTurnClock();
    }
  });
}
function updateTurnClock() {
  if (!currentRoom?.started) return;
  const remaining = gameClock.remaining(currentRoom.deadlineAt);
  const seconds = Math.ceil(remaining / 1000);
  soundEvents.tick(currentRoom, socket.id, remaining, socket.connected);
  $('#seconds-left').textContent = seconds;
  $('#turn-timer').style.setProperty(
    '--time-left',
    String(Math.min(1, remaining / currentRoom.turnDuration)),
  );
  $('#turn-timer').classList.toggle('urgent', seconds <= 5);
  $('#turn-timer').setAttribute('aria-label', seconds + ' secondes restantes');
  const self = currentRoom.players.find((player) => player.id === socket.id);
  const watching = self?.spectator === true;
  const canPlay = socket.connected && !watching && currentRoom.turn === socket.id && remaining > 0;
  $('#word-form').hidden = !canPlay;
  $('#spectator-note').hidden = canPlay;
  const currentPlayer = currentRoom.players.find((player) => player.id === currentRoom.turn);
  const nextIsMe = currentRoom.nextTurn === socket.id;
  $('#spectator-note').textContent = !socket.connected
    ? 'Reconnexion en cours…'
    : self?.eliminated
      ? 'Tu es éliminé de cette partie. Regarde la suite : tu rejoueras à la prochaine.'
      : currentRoom.paused
        ? 'Partie en pause : aucun participant connecté.'
        : watching
          ? 'Tu assistes à cette partie. Tu joueras automatiquement à la prochaine.'
          : remaining <= 0
            ? 'Temps écoulé. Le tour suivant arrive…'
            : `Regarde ${currentPlayer?.name || 'le joueur'} jouer.${nextIsMe ? ' Tu joues juste après !' : ' Ton tour arrive.'}`;
  $('#word').disabled = !canPlay;
  $('#word-form button').disabled = !canPlay || wordPending;
}
setInterval(updateTurnClock, 100);
setInterval(synchronizeClock, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) gameSounds.stop();
  else synchronizeClock();
});

function renderSidebar(room) {
  $('#sidebar-title').textContent = room.started ? 'Scores de la partie' : 'La bande';
  $('#players').replaceChildren();
  $('#spectators').replaceChildren();
  const rows = room.started
    ? room.currentScores
    : room.players.map((player) => ({ ...player, connected: true }));
  rows.forEach((player, index) => {
    const onlinePlayer = room.players.find((item) => item.memberId === player.memberId);
    const current = room.started && player.current && player.connected;
    const next = room.started && player.next && player.connected && !current;
    const row = document.createElement('div');
    row.className =
      'player' + (player.eliminated ? ' eliminated' : current ? ' active' : next ? ' up-next' : '');
    const avatar = document.createElement('span');
    avatar.className = 'player-avatar';
    avatar.textContent = ['☺', '✿', '☻', '✳', '☀', '❋', '✦', '☘'][index % 8];
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.name;
    const detail = document.createElement('small');
    detail.textContent = [
      onlinePlayer?.id === socket.id ? 'Toi' : '',
      onlinePlayer?.id === room.host ? 'Hôte' : '',
      player.eliminated
        ? 'Éliminé'
        : !player.connected
          ? 'Absent'
          : current
            ? 'Joue maintenant'
            : next
              ? 'À suivre'
              : 'En attente',
    ]
      .filter(Boolean)
      .join(' · ');
    name.append(detail);
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = player.score + ' pt';
    row.append(avatar, name, score);
    $('#players').append(row);
  });
  const spectators = room.players.filter((player) => player.spectator && !player.eliminated);
  $('#spectators-section').hidden = !spectators.length;
  spectators.forEach((player) => {
    const row = document.createElement('div');
    row.className = 'spectator-player';
    row.textContent =
      player.name +
      (player.id === socket.id ? ' · Toi' : '') +
      (player.id === room.host ? ' · Hôte' : '');
    $('#spectators').append(row);
  });
}

function renderSoundControls() {
  const audible = gameSounds.enabled && gameSounds.volume > 0;
  $('#sound-label').textContent = !gameSounds.available
    ? 'Son indisponible'
    : audible
      ? 'Son activé'
      : 'Son coupé';
  $('#sound-toggle').setAttribute('aria-pressed', String(audible));
  $('#sound-toggle').title = audible ? 'Couper les bruitages' : 'Activer les bruitages';
  $('#sound-toggle').disabled = !gameSounds.available;
  $('#sound-volume').disabled = !gameSounds.available;
  $('#sound-volume').value = Math.round(gameSounds.volume * 100);
  $('#sound-volume-label').textContent = Math.round(gameSounds.volume * 100) + ' %';
}
$('#sound-toggle').onclick = () => {
  const enable = !gameSounds.enabled || gameSounds.volume === 0;
  if (enable && gameSounds.volume === 0) gameSounds.setVolume(0.25);
  gameSounds.setEnabled(enable);
  renderSoundControls();
  if (enable)
    gameSounds.unlock().then((ready) => {
      if (ready) gameSounds.play('preview');
    });
};
$('#sound-volume').oninput = (event) => {
  gameSounds.setVolume(Number(event.target.value) / 100);
  if (gameSounds.volume > 0) gameSounds.setEnabled(true);
  renderSoundControls();
  gameSounds.unlock();
};
document.addEventListener(
  'pointerdown',
  () => {
    gameSounds.unlock();
  },
  { passive: true },
);
document.addEventListener('keydown', () => {
  gameSounds.unlock();
});
renderSoundControls();
