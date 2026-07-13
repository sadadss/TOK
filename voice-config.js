'use strict';

const VOICE_PROFILES = Object.freeze({
  clear: Object.freeze({ speaker: 'Kore', label: 'Clara · femenina' }),
  deep: Object.freeze({ speaker: 'Charon', label: 'Grave · masculina' }),
  soft: Object.freeze({ speaker: 'Aoede', label: 'Suave · femenina' }),
});

const DEFAULT_VOICE = 'clear';

function normalizeVoice(voice) {
  return Object.hasOwn(VOICE_PROFILES, voice) ? voice : DEFAULT_VOICE;
}

function googleVoiceName(languageCode, voice) {
  const profile = VOICE_PROFILES[normalizeVoice(voice)];
  return `${languageCode}-Chirp3-HD-${profile.speaker}`;
}

module.exports = { DEFAULT_VOICE, VOICE_PROFILES, googleVoiceName, normalizeVoice };
