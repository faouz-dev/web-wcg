const { randomBytes } = require('node:crypto');
const TURN_MS = 15000;
const turnToken = () => randomBytes(12).toString('hex');
function upgradeGame(game) {
  game.round ??= 1;
  game.minLength ??= 3;
  game.roundRemaining ??= game.turnMemberId
    ? [
        game.turnMemberId,
        ...Object.keys(game.participants).filter((id) => id !== game.turnMemberId),
      ]
    : [];
  game.remainingMs ??= TURN_MS;
  game.deadlineAt ??= null;
  game.turnId ??= turnToken();
  game.events ??= [];
}
function beginTurn(game, time, duration = TURN_MS, preservePrompt = false) {
  game.turnMemberId = game.roundRemaining[0] || null;
  game.remainingMs = duration;
  game.deadlineAt = game.turnMemberId ? time + duration : null;
  if (!preservePrompt) game.turnId = turnToken();
}
function nextRound(game, ids) {
  game.round += 1;
  game.minLength = Math.min(10, 3 + game.round - 1);
  game.roundRemaining = [...ids];
}
function advanceTurn(game, ids, time, reason) {
  upgradeGame(game);
  game.lastEvent =
    reason === 'timeout'
      ? {
          type: 'timeout',
          memberId: game.turnMemberId,
          name: game.participants[game.turnMemberId]?.name || '',
          round: game.round,
          at: time,
        }
      : null;
  if (game.lastEvent) game.events.push(game.lastEvent);
  if (reason === 'timeout') game.participants[game.turnMemberId].eliminatedAt = time;
  ids = ids.filter((id) => game.participants[id]?.eliminatedAt == null);
  game.roundRemaining = game.roundRemaining.filter(
    (id) => id !== game.turnMemberId && ids.includes(id),
  );
  if (!game.roundRemaining.length && ids.length) nextRound(game, ids);
  beginTurn(game, time);
}
function reconcilePresence(game, ids, time) {
  upgradeGame(game);
  if (!ids.length) {
    if (game.deadlineAt !== null)
      game.remainingMs = Math.max(0, Math.min(TURN_MS, game.deadlineAt - time));
    game.deadlineAt = null;
    return;
  }
  if (!ids.includes(game.turnMemberId)) {
    game.roundRemaining = game.roundRemaining.filter((id) => ids.includes(id));
    if (!game.roundRemaining.length) nextRound(game, ids);
    beginTurn(game, time);
  } else if (game.deadlineAt === null) {
    game.roundRemaining = game.roundRemaining.filter((id) => ids.includes(id));
    beginTurn(game, time, game.remainingMs, true);
  }
}
function expireTurn(game, ids, time) {
  if (game.deadlineAt === null || time < game.deadlineAt || !ids.length) return false;
  advanceTurn(game, ids, time, 'timeout');
  return true;
}
module.exports = { TURN_MS, upgradeGame, beginTurn, advanceTurn, reconcilePresence, expireTurn };
