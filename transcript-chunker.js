'use strict';

function normalizeWords(transcript) {
  return String(transcript || '').trim().split(/\s+/).filter(Boolean);
}

function endsSemanticUnit(words) {
  return /[.!?;:]["'”’)]?$/.test(words.at(-1) || '');
}

/**
 * Agrupa resultados finales y prefijos provisionales estables en unidades con
 * contexto suficiente para traducir y sintetizar con una prosodia natural.
 *
 * `flush()` permite al servidor vaciar una unidad corta después de una pausa.
 */
function createTranscriptChunker({
  minWords = 10,
  preferredWords = 18,
  maxWords = 42,
  minSegmentMs = 2400,
  targetMs = 4200,
  maxMs = 6200,
  stabilityThreshold = 0.82,
  holdbackWords = 2,
} = {}) {
  let bufferedWords = [];
  let processedWords = 0;
  let segmentStartedAt = 0;

  function reset() {
    bufferedWords = [];
    processedWords = 0;
    segmentStartedAt = 0;
  }

  function flush() {
    const chunk = bufferedWords.join(' ').trim();
    bufferedWords = [];
    segmentStartedAt = 0;
    return chunk;
  }

  function hasPending() {
    return bufferedWords.length > 0;
  }

  function next({ transcript, isFinal = false, stability = 0, now = Date.now() }) {
    const words = normalizeWords(transcript);

    // Una revisión profunda del resultado provisional invalida el índice previo.
    if (processedWords > words.length) processedWords = 0;
    const pendingWords = words.slice(processedWords);
    if (pendingWords.length && segmentStartedAt === 0) segmentStartedAt = now;

    if (isFinal) {
      bufferedWords.push(...pendingWords);
      processedWords = 0;
    } else {
      const ageMs = segmentStartedAt ? now - segmentStartedAt : 0;
      const prefixIsStable = Number(stability) >= stabilityThreshold;
      const mayForceStablePrefix = ageMs >= maxMs;
      if (prefixIsStable || mayForceStablePrefix) {
        const safeCount = Math.max(0, pendingWords.length - holdbackWords);
        bufferedWords.push(...pendingWords.slice(0, safeCount));
        processedWords += safeCount;
      }
    }

    if (!bufferedWords.length) return '';

    const ageMs = now - segmentStartedAt;
    const semanticEnding = endsSemanticUnit(bufferedWords);
    const reachedHardLimit = bufferedWords.length >= maxWords || ageMs >= maxMs;
    const reachedNaturalLimit = semanticEnding
      && bufferedWords.length >= minWords
      && ageMs >= minSegmentMs
      && (bufferedWords.length >= preferredWords || ageMs >= targetMs);

    return reachedHardLimit || reachedNaturalLimit ? flush() : '';
  }

  return { next, flush, hasPending, reset };
}

module.exports = { createTranscriptChunker, endsSemanticUnit, normalizeWords };
