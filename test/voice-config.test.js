'use strict';

const assert = require('node:assert/strict');
const { DEFAULT_VOICE, googleVoiceName, normalizeVoice } = require('../voice-config');

assert.equal(normalizeVoice('deep'), 'deep');
assert.equal(normalizeVoice('not-a-voice'), DEFAULT_VOICE);
assert.equal(googleVoiceName('en-US', 'clear'), 'en-US-Chirp3-HD-Kore');
assert.equal(googleVoiceName('fr-FR', 'deep'), 'fr-FR-Chirp3-HD-Charon');
assert.equal(googleVoiceName('pt-BR', 'soft'), 'pt-BR-Chirp3-HD-Aoede');

console.log('voice-config: ok');
