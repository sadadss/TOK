'use strict';

const DEFAULT_ROOM_COUNT = 8;
const DEFAULT_MAX_LISTENERS = 300;

function normalizedPositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function buildPresentationRooms(count = DEFAULT_ROOM_COUNT) {
  const roomCount = normalizedPositiveInteger(count, DEFAULT_ROOM_COUNT, 24);
  return Array.from({ length: roomCount }, (_, index) => ({
    id: `sala-${index + 1}`,
    label: `Sala ${index + 1}`,
  }));
}

function presentationConfig(env = process.env) {
  return {
    rooms: buildPresentationRooms(env.PRESENTATION_ROOM_COUNT),
    maxListeners: normalizedPositiveInteger(
      env.PRESENTATION_MAX_LISTENERS,
      DEFAULT_MAX_LISTENERS,
      10000
    ),
    sourceLanguage: 'es',
    targetLanguage: 'en',
    voice: 'clear',
  };
}

module.exports = {
  DEFAULT_MAX_LISTENERS,
  DEFAULT_ROOM_COUNT,
  buildPresentationRooms,
  normalizedPositiveInteger,
  presentationConfig,
};
