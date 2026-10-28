const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createLetterPicker } = require('../lib/letter-picker');
const cache = new Map();
function dictionary(lang, letter) {
  const key = lang + letter;
  if (!cache.has(key))
    cache.set(
      key,
      new Set(
        readFileSync(
          path.join(__dirname, '..', 'wordList', lang, letter.toUpperCase() + '.txt'),
          'utf8',
        )
          .split(/\r?\n/)
          .map((word) =>
            word
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/œ/g, 'oe')
              .replace(/æ/g, 'ae')
              .trim(),
          ),
      ),
    );
  return cache.get(key);
}
for (const lang of ['fr', 'en']) {
  test(`Tirage ${lang} : 12 initiales courantes, aucun X/Y/Z, mots possibles à 3 et 10 lettres minimum`, () => {
    let position = 0;
    const pick = createLetterPicker(dictionary, (count) => position % count);
    for (const minLength of [3, 10]) {
      const selected = new Set();
      for (position = 0; position < 12; position++) {
        const game = { minLength, history: [], letter: null };
        const letter = pick({ lang }, game);
        selected.add(letter);
        assert.equal('xyz'.includes(letter), false);
        assert.ok(
          [...dictionary(lang, letter)].some(
            (word) =>
              /^[a-z]{2,40}$/.test(word) && word.startsWith(letter) && word.length >= minLength,
          ),
        );
        game.letter = letter;
        assert.notEqual(pick({ lang }, game), letter);
      }
      assert.equal(selected.size, 12);
    }
  });
}
test('Une initiale épuisée est exclue du tirage', () => {
  const lists = { a: new Set(['ami']), b: new Set(['bon']) };
  const pick = createLetterPicker(
    (lang, letter) => lists[letter] || new Set(),
    () => 0,
  );
  assert.equal(
    pick({ lang: 'fr' }, { minLength: 3, letter: null, history: [{ word: 'ami' }] }),
    'b',
  );
});
