'use strict';

const assert = require('node:assert/strict');
const { createTranscriptChunker } = require('../transcript-chunker');

const chunker = createTranscriptChunker({ minWords: 3, maxWords: 6, intervalMs: 1000 });

assert.equal(chunker.next({ transcript: 'uno dos tres', now: 1000 }), '');
assert.equal(chunker.next({ transcript: 'uno dos tres cuatro', now: 1100 }), 'uno dos tres');
assert.equal(chunker.next({ transcript: 'uno dos tres cuatro', now: 1200 }), '');
assert.equal(chunker.next({ transcript: 'uno dos tres cuatro cinco seis siete', now: 1500 }), '');
assert.equal(
  chunker.next({ transcript: 'uno dos tres cuatro cinco seis siete ocho', now: 2200 }),
  'cuatro cinco seis siete'
);
assert.equal(
  chunker.next({ transcript: 'uno dos tres cuatro cinco seis siete ocho nueve', isFinal: true, now: 2400 }),
  'ocho nueve'
);

assert.equal(chunker.next({ transcript: 'nueva frase final', isFinal: true, now: 3000 }), 'nueva frase final');

console.log('transcript-chunker: ok');
