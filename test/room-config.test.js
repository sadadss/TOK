'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_LISTENERS,
  buildPresentationRooms,
  normalizedPositiveInteger,
  presentationConfig,
} = require('../room-config');

assert.deepEqual(buildPresentationRooms(3), [
  { id: 'sala-1', label: 'Sala 1' },
  { id: 'sala-2', label: 'Sala 2' },
  { id: 'sala-3', label: 'Sala 3' },
]);
assert.equal(buildPresentationRooms().length, 8);
assert.equal(buildPresentationRooms(99).length, 24);
assert.equal(normalizedPositiveInteger('0', 8, 24), 8);

const config = presentationConfig({
  PRESENTATION_ROOM_COUNT: '8',
  PRESENTATION_MAX_LISTENERS: '300',
});
assert.equal(config.rooms.length, 8);
assert.equal(config.maxListeners, DEFAULT_MAX_LISTENERS);
assert.equal(config.sourceLanguage, 'es');
assert.equal(config.targetLanguage, 'en');
assert.equal(config.voice, 'clear');

console.log('room-config: ok');
