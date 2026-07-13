'use strict';

const assert = require('node:assert/strict');
const { createTranscriptChunker, endsSemanticUnit } = require('../transcript-chunker');

assert.equal(endsSemanticUnit(['una', 'idea.']), true);
assert.equal(endsSemanticUnit(['una', 'idea']), false);

const chunker = createTranscriptChunker({
  minWords: 4,
  preferredWords: 7,
  maxWords: 12,
  minSegmentMs: 1000,
  targetMs: 2000,
  maxMs: 4000,
  stabilityThreshold: 0.8,
  holdbackWords: 1,
});

// Un resultado provisional inestable no debe convertirse en audio.
assert.equal(chunker.next({ transcript: 'uno dos tres cuatro cinco', stability: 0.45, now: 1000 }), '');
// Al estabilizarse se conserva una palabra provisional y todavía se espera contexto.
assert.equal(chunker.next({ transcript: 'uno dos tres cuatro cinco', stability: 0.9, now: 1500 }), '');
// Un final corto se acumula en vez de sintetizarse como una frase aislada.
assert.equal(chunker.next({ transcript: 'uno dos tres cuatro cinco.', isFinal: true, now: 1800 }), '');
// La siguiente frase completa forma una unidad semántica más natural.
assert.equal(
  chunker.next({ transcript: 'seis siete ocho nueve.', isFinal: true, now: 3100 }),
  'uno dos tres cuatro cinco. seis siete ocho nueve.'
);

// Si el orador se detiene, el servidor puede vaciar una frase corta tras la pausa.
assert.equal(chunker.next({ transcript: 'frase final corta.', isFinal: true, now: 5000 }), '');
assert.equal(chunker.hasPending(), true);
assert.equal(chunker.flush(), 'frase final corta.');
assert.equal(chunker.hasPending(), false);

// Un discurso sin pausas se corta obligatoriamente al alcanzar la latencia máxima.
assert.equal(chunker.next({ transcript: 'a b c d e f', stability: 0.9, now: 7000 }), '');
assert.equal(
  chunker.next({ transcript: 'a b c d e f g h i j', stability: 0.9, now: 11100 }),
  'a b c d e f g h i'
);

chunker.reset();
assert.equal(chunker.hasPending(), false);

console.log('transcript-chunker: ok');
