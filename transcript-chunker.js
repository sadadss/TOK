'use strict';

function normalizeWords(transcript) {
  return String(transcript || '').trim().split(/\s+/).filter(Boolean);
}

function createTranscriptChunker({
  minWords = 3,
  maxWords = 9,
  intervalMs = 1600,
} = {}) {
  let processedWords = 0;
  let lastChunkAt = 0;

  function reset() {
    processedWords = 0;
    lastChunkAt = 0;
  }

  function next({ transcript, isFinal = false, now = Date.now() }) {
    const words = normalizeWords(transcript);

    if (isFinal) {
      const remaining = words.slice(processedWords).join(' ');
      reset();
      return remaining;
    }

    const pendingWords = words.length - processedWords;
    if (pendingWords <= 0) return '';

    const intervalElapsed = lastChunkAt === 0 || now - lastChunkAt >= intervalMs;
    const mustFlush = pendingWords >= maxWords + 1;
    if (!intervalElapsed && !mustFlush) return '';

    // Se conserva la última palabra provisional para reducir correcciones y repeticiones.
    const safeWords = Math.max(0, pendingWords - 1);
    if (safeWords < minWords && !mustFlush) return '';

    const wordsToTake = Math.min(maxWords, Math.max(minWords, safeWords));
    const chunk = words.slice(processedWords, processedWords + wordsToTake).join(' ');

    processedWords += wordsToTake;
    lastChunkAt = now;
    return chunk;
  }

  return { next, reset };
}

module.exports = { createTranscriptChunker, normalizeWords };
