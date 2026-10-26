const { randomInt } = require('node:crypto');
// La fréquence est calculée sur les initiales des mots admissibles, pas sur les lettres dans le texte.
function createLetterPicker(dictionary, randomIndex = randomInt) {
  const counts = new Map();
  return (room, game) => {
    const key = `${room.lang}/${game.minLength}`;
    if (!counts.has(key)) {
      counts.set(key, [...'abcdefghijklmnopqrstuvwxyz'].map(letter => ({ letter, count: [...dictionary(room.lang, letter)].filter(word => /^[a-z]{2,40}$/.test(word) && word.startsWith(letter) && word.length >= game.minLength).length })).filter(item => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 12));
    }
    const used = new Set(game.history.map(item => item.word));
    let candidates = counts.get(key).filter(({ letter }) => [...dictionary(room.lang, letter)].some(word => /^[a-z]{2,40}$/.test(word) && word.startsWith(letter) && word.length >= game.minLength && !used.has(word)));
    if (!candidates.length) throw new Error('Aucun mot disponible pour cette consigne.');
    const alternatives = candidates.filter(item => item.letter !== game.letter);
    if (alternatives.length) candidates = alternatives;
    return candidates[randomIndex(candidates.length)].letter;
  };
}
module.exports = { createLetterPicker };
