'use strict';

const assert = require('node:assert/strict');
const {
  configuredOrigins,
  claimSpeaker,
  createByteRateGuard,
  isAllowedOrigin,
  normalizeEventId,
  normalizeSpeakerName,
  parseRoleRequest,
  releaseSpeaker,
  withTimeout,
} = require('../demo-guard');

assert.strictEqual(normalizeSpeakerName('  Ana   Mar\u00eda  '), 'Ana Mar\u00eda');
assert.strictEqual(normalizeSpeakerName(''), '');
assert.strictEqual(normalizeSpeakerName(`A${'b'.repeat(100)}`).length, 80);

assert.equal(normalizeEventId(' Evento RLA 2026! '), 'evento-rla-2026');
assert.equal(normalizeEventId('../'), 'demo');
assert.deepEqual(parseRoleRequest('listener'), { role: 'listener', eventId: 'demo' });
assert.deepEqual(parseRoleRequest({ role: 'speaker', eventId: 'Sala Norte' }), { role: 'speaker', eventId: 'sala-norte' });
assert.deepEqual(configuredOrigins('https://a.test, https://b.test'), ['https://a.test', 'https://b.test']);
assert.equal(isAllowedOrigin('https://web.rla-latam.com'), true);
assert.equal(isAllowedOrigin('http://localhost:3001'), true);
assert.equal(isAllowedOrigin('https://otro-sitio.test'), false);
assert.equal(isAllowedOrigin('https://otro-sitio.test', ['https://otro-sitio.test']), true);

const acceptsAudio = createByteRateGuard({ maxChunkBytes: 10, maxBytesPerSecond: 15 });
assert.equal(acceptsAudio(Buffer.alloc(8), 1000), true);
assert.equal(acceptsAudio(Buffer.alloc(8), 1100), false);
assert.equal(acceptsAudio(Buffer.alloc(8), 2100), true);
assert.equal(acceptsAudio(Buffer.alloc(11), 2200), false);

const speakers = new Map();
assert.equal(claimSpeaker(speakers, 'demo', 'speaker-a'), true);
assert.equal(claimSpeaker(speakers, 'demo', 'speaker-b', () => true), false);
assert.equal(claimSpeaker(speakers, 'otra', 'speaker-b', () => true), true);
assert.equal(releaseSpeaker(speakers, 'demo', 'speaker-b'), false);
assert.equal(releaseSpeaker(speakers, 'demo', 'speaker-a'), true);

(async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 20), 'ok');
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'prueba'), /prueba excedió 5 ms/);
  console.log('demo-guard: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
