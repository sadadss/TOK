require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const speech = require('@google-cloud/speech');
const { Translate } = require('@google-cloud/translate').v2;
const textToSpeech = require('@google-cloud/text-to-speech');
const cors = require('cors');
const { createTranscriptChunker } = require('./transcript-chunker');
const { DEFAULT_VOICE, VOICE_PROFILES, googleVoiceName, normalizeVoice } = require('./voice-config');
const {
  DEFAULT_EVENT_ID,
  claimSpeaker,
  configuredOrigins,
  createByteRateGuard,
  isAllowedOrigin,
  normalizeSpeakerName,
  parseRoleRequest,
  releaseSpeaker,
  withTimeout,
} = require('./demo-guard');

const app = express();
const extraOrigins = configuredOrigins(process.env.ALLOWED_ORIGINS);
const corsOptions = {
  origin(origin, callback) {
    callback(isAllowedOrigin(origin, extraOrigins) ? null : new Error('Origen no permitido'), true);
  },
  methods: ['GET', 'POST'],
};
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(cors(corsOptions));
app.get('/', (_req, res) => res.json({
  service: 'RLA Traducción en vivo',
  mode: 'demo',
  showcase: '/demo?event=demo',
  speaker: '/speaker?event=demo',
  listener: '/listener?event=demo',
  overlay: '/overlay?event=demo&lang=en&voice=clear&mode=transparent&audio=1&clean=1',
  health: '/health',
}));
app.get(['/demo', '/showcase', '/showcase.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'showcase.html'));
});
app.get(['/overlay', '/overlay.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'overlay.html'));
});
app.get(['/speaker', '/speaker.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'speaker.html'));
});
app.get(['/listener', '/listener.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'listener.html'));
});
const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  allowRequest: (req, callback) => callback(null, isAllowedOrigin(req.headers.origin, extraOrigins)),
  maxHttpBufferSize: 100 * 1024,
  pingInterval: 20000,
  pingTimeout: 15000,
});

const serverStartedAt = Date.now();
const activeSpeakers = new Map();
const MAX_CONNECTIONS = Math.max(10, Number(process.env.MAX_CONNECTIONS) || 150);
const GOOGLE_CALL_TIMEOUT_MS = Math.max(5000, Number(process.env.GOOGLE_CALL_TIMEOUT_MS) || 15000);
const MAX_SYNTHESIS_BACKLOG = Math.max(2, Number(process.env.MAX_SYNTHESIS_BACKLOG) || 6);
const MAX_TRANSLATION_BACKLOG = Math.max(2, Number(process.env.MAX_TRANSLATION_BACKLOG) || 8);
const SPEAKER_TOKEN = String(process.env.SPEAKER_TOKEN || '');
const LOG_TRANSCRIPTS = process.env.LOG_TRANSCRIPTS === 'true';

app.get('/health', (_req, res) => res.json({
  ok: Boolean(speechClient && translateClient && ttsClient),
  service: 'live-translation',
  uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
  connections: io.engine.clientsCount,
  maxConnections: MAX_CONNECTIONS,
  liveEvents: activeSpeakers.size,
}));

// Clientes de Google Cloud
// Asumen que GOOGLE_APPLICATION_CREDENTIALS está en el .env
let speechClient, translateClient, ttsClient;
try {
  speechClient = new speech.SpeechClient();
  translateClient = new Translate();
  ttsClient = new textToSpeech.TextToSpeechClient();
  console.log("Clientes de Google Cloud inicializados correctamente.");
} catch (error) {
  console.error("Error al inicializar Google Cloud. Asegúrate de tener credentials.json y el .env configurado.", error);
}

// Idiomas de destino. Las voces Chirp 3 HD se construyen desde voice-config.js.
const TARGET_LANGUAGES = [
  { code: 'en', languageCode: 'en-US' },
  { code: 'fr', languageCode: 'fr-FR' },
  { code: 'pt', languageCode: 'pt-BR' },
];
const LISTENER_LANGUAGES = new Set(['es', ...TARGET_LANGUAGES.map(({ code }) => code)]);
const VOICE_KEYS = Object.keys(VOICE_PROFILES);
// Google limita cada StreamingRecognize a unos 5 minutos. Se renueva antes del límite.
const SPEECH_RENEWAL_MS = 225000;
const SPEECH_RENEWAL_FALLBACK_MS = 1800;
const MAX_SPEECH_RECOVERY_ATTEMPTS = 4;
const SEMANTIC_PAUSE_MS = 1100;
const SPEECH_REQUEST = {
  config: {
    encoding: 'WEBM_OPUS',
    sampleRateHertz: 48000,
    languageCode: 'es-ES',
    enableAutomaticPunctuation: true,
    model: 'latest_long',
  },
  interimResults: true,
};

function eventRoom(eventId) {
  return `event:${eventId}`;
}

function languageRoom(eventId, language) {
  return `${eventRoom(eventId)}:listener:${language}`;
}

function voiceRoom(eventId, language, voice) {
  return `${languageRoom(eventId, language)}:${voice}`;
}

function eventStatus(eventId) {
  const members = io.sockets.adapter.rooms.get(eventRoom(eventId)) || new Set();
  let listeners = 0;
  for (const socketId of members) {
    if (io.sockets.sockets.get(socketId)?.role === 'listener') listeners += 1;
  }
  const speakerSocketId = activeSpeakers.get(eventId);
  const speakerName = speakerSocketId
    ? normalizeSpeakerName(io.sockets.sockets.get(speakerSocketId)?.speakerName)
    : '';
  return {
    eventId,
    live: activeSpeakers.has(eventId),
    listeners,
    speakerName,
  };
}

function broadcastEventStatus(eventId) {
  io.to(eventRoom(eventId)).emit('event_status', eventStatus(eventId));
}

io.on('connection', (socket) => {
  if (io.engine.clientsCount > MAX_CONNECTIONS) {
    socket.emit('server_busy', { message: 'La demo alcanzó su capacidad temporal. Intenta nuevamente en unos minutos.' });
    socket.disconnect(true);
    return;
  }

  console.log(`Usuario conectado: ${socket.id}`);
  let recognizeStream = null;
  let speakerStreaming = false;
  let speechRenewalTimer = null;
  let speechRenewalFallbackTimer = null;
  let semanticFlushTimer = null;
  let renewalRequested = false;
  let latestTranscript = '';
  let speechRecoveryAttempts = 0;
  let segmentSequence = 0;
  let translationQueue = Promise.resolve();
  let translationBacklog = 0;
  let synthesisQueue = Promise.resolve();
  let synthesisBacklog = 0;
  const transcriptChunker = createTranscriptChunker();
  const acceptsAudioChunk = createByteRateGuard();

  async function synthesizeAndBroadcast(translations, segmentId, isFinal, eventId) {
    await Promise.all(translations.map(async ({ code, languageCode, translation }) => {
      const activeVoices = VOICE_KEYS.filter((voice) => (
        io.sockets.adapter.rooms.get(voiceRoom(eventId, code, voice))?.size
      ));
      await Promise.all(activeVoices.map(async (voice) => {
        try {
          const [ttsResponse] = await withTimeout(ttsClient.synthesizeSpeech({
            input: { text: translation },
            voice: { languageCode, name: googleVoiceName(languageCode, voice) },
            audioConfig: { audioEncoding: 'MP3' },
          }), GOOGLE_CALL_TIMEOUT_MS, `síntesis ${code}/${voice}`);
          io.to(voiceRoom(eventId, code, voice)).emit('translation_audio', {
            segmentId,
            lang: code,
            voice,
            audio: ttsResponse.audioContent,
            isFinal,
          });
        } catch (ttsError) {
          console.error(`Error generando audio ${code}/${voice}:`, ttsError);
        }
      }));
    }));
  }

  function enqueueSynthesis(translations, segmentId, isFinal, eventId) {
    if (!translations.length) return;
    if (synthesisBacklog >= MAX_SYNTHESIS_BACKLOG) {
      console.warn(`Audio omitido por cola saturada en ${eventId}: ${segmentId}`);
      socket.emit('speaker_warning', { message: 'La voz traducida está atrasada; se priorizaron los fragmentos más recientes.' });
      return;
    }
    synthesisBacklog += 1;
    synthesisQueue = synthesisQueue
      .then(() => synthesizeAndBroadcast(translations, segmentId, isFinal, eventId))
      .catch((error) => console.error('Error en la cola de síntesis:', error))
      .finally(() => { synthesisBacklog = Math.max(0, synthesisBacklog - 1); });
  }

  async function translateAndBroadcast(text, isFinal) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return;

    const eventId = socket.eventId || DEFAULT_EVENT_ID;
    const segmentId = `${socket.id}-${++segmentSequence}`;
    console.log(LOG_TRANSCRIPTS
      ? `Orador (ES${isFinal ? ', final' : ', parcial'}): ${normalizedText}`
      : `Segmento ${segmentId}: ${normalizedText.length} caracteres`);

    io.to(languageRoom(eventId, 'es')).emit('translation', {
      segmentId,
      lang: 'es',
      text: normalizedText,
      audio: null,
      isFinal,
    });

    const translations = await Promise.all(TARGET_LANGUAGES.map(async ({ code, languageCode }) => {
      try {
        const [translation] = await withTimeout(
          translateClient.translate(normalizedText, code),
          GOOGLE_CALL_TIMEOUT_MS,
          `traducción ${code}`
        );
        io.to(languageRoom(eventId, code)).emit('translation', {
          segmentId,
          lang: code,
          text: translation,
          audio: null,
          isFinal,
        });
        return { code, languageCode, translation };
      } catch (translationError) {
        console.error(`Error traduciendo idioma ${code}:`, translationError);
        return null;
      }
    }));
    enqueueSynthesis(translations.filter(Boolean), segmentId, isFinal, eventId);
  }

  function enqueueTranslation(text, isFinal) {
    if (!text) return;
    if (translationBacklog >= MAX_TRANSLATION_BACKLOG) {
      console.warn(`Texto omitido por cola saturada para ${socket.id}`);
      socket.emit('speaker_warning', { message: 'La traducción está saturada; se priorizarán los fragmentos siguientes.' });
      return;
    }
    translationBacklog += 1;
    translationQueue = translationQueue
      .then(() => translateAndBroadcast(text, isFinal))
      .catch((error) => console.error('Error en la cola de traducción:', error))
      .finally(() => { translationBacklog = Math.max(0, translationBacklog - 1); });
  }

  socket.on('join_role', (request, acknowledge = () => {}) => {
    const { role, eventId } = parseRoleRequest(request);
    if (!['speaker', 'listener'].includes(role)) {
      acknowledge({ ok: false, message: 'Rol no válido.' });
      return;
    }
    if (socket.role && socket.role !== role) {
      acknowledge({ ok: false, message: 'No se puede cambiar de rol durante una conexión.' });
      return;
    }
    if (socket.eventId && socket.eventId !== eventId) {
      acknowledge({ ok: false, message: 'No se puede cambiar de evento durante una conexión.' });
      return;
    }
    socket.role = role;
    socket.eventId = eventId;
    socket.join(eventRoom(eventId));
    socket.join(`${eventRoom(eventId)}:role:${role}`);
    console.log(`Socket ${socket.id} unido como ${role} en ${eventId}`);
    acknowledge({ ok: true, ...eventStatus(eventId) });
    broadcastEventStatus(eventId);
  });

  function setListenerPreferences(language, voice, audioEnabled = true) {
    if (socket.role !== 'listener' || !LISTENER_LANGUAGES.has(language)) return;
    const selectedVoice = normalizeVoice(voice);
    const eventId = socket.eventId || DEFAULT_EVENT_ID;

    for (const supportedLanguage of LISTENER_LANGUAGES) {
      socket.leave(languageRoom(eventId, supportedLanguage));
      for (const voiceKey of VOICE_KEYS) socket.leave(voiceRoom(eventId, supportedLanguage, voiceKey));
    }
    socket.join(languageRoom(eventId, language));
    if (language !== 'es' && audioEnabled) socket.join(voiceRoom(eventId, language, selectedVoice));
    socket.listenerLanguage = language;
    socket.listenerVoice = selectedVoice;
    socket.listenerAudioEnabled = audioEnabled;
    console.log(`Oyente ${socket.id} cambió a ${language}/${selectedVoice}`);
    broadcastEventStatus(eventId);
  }

  socket.on('set_listener_preferences', ({ language, voice, audio = true } = {}) => {
    setListenerPreferences(language, voice, audio !== false);
  });

  socket.on('set_listener_language', (language) => {
    setListenerPreferences(language, socket.listenerVoice || DEFAULT_VOICE, socket.listenerAudioEnabled !== false);
  });

  socket.on('set_listener_voice', (voice) => {
    setListenerPreferences(socket.listenerLanguage || 'en', voice, socket.listenerAudioEnabled !== false);
  });

  function clearSpeechTimers() {
    clearTimeout(speechRenewalTimer);
    clearTimeout(speechRenewalFallbackTimer);
    speechRenewalTimer = null;
    speechRenewalFallbackTimer = null;
  }

  function clearSemanticFlushTimer() {
    clearTimeout(semanticFlushTimer);
    semanticFlushTimer = null;
  }

  function flushSemanticBuffer() {
    clearSemanticFlushTimer();
    enqueueTranslation(transcriptChunker.flush(), true);
  }

  function scheduleSemanticFlush() {
    clearSemanticFlushTimer();
    if (!transcriptChunker.hasPending()) return;
    semanticFlushTimer = setTimeout(flushSemanticBuffer, SEMANTIC_PAUSE_MS);
  }

  function flushPendingTranscript() {
    clearSemanticFlushTimer();
    const remaining = latestTranscript
      ? transcriptChunker.next({ transcript: latestTranscript, isFinal: true })
      : '';
    latestTranscript = '';
    enqueueTranslation(remaining, true);
    enqueueTranslation(transcriptChunker.flush(), true);
  }

  function finishRecognitionStream({ flush = true } = {}) {
    clearSpeechTimers();
    if (flush) flushPendingTranscript();
    else {
      latestTranscript = '';
      clearSemanticFlushTimer();
      transcriptChunker.reset();
    }

    const previousStream = recognizeStream;
    recognizeStream = null;
    if (previousStream) {
      try { previousStream.end(); }
      catch (error) { console.warn('No se pudo cerrar el stream anterior:', error.message); }
    }
  }

  function requestCaptureRenewal(reason) {
    if (!speakerStreaming || renewalRequested) return;
    renewalRequested = true;
    console.log(`Solicitando renovación del audio del orador: ${reason}`);
    socket.emit('renew_speaker_capture');
    speechRenewalFallbackTimer = setTimeout(() => {
      if (speakerStreaming && renewalRequested) rotateRecognitionStream('fallback del servidor');
    }, SPEECH_RENEWAL_FALLBACK_MS);
  }

  function scheduleSpeechRenewal() {
    clearTimeout(speechRenewalTimer);
    speechRenewalTimer = setTimeout(
      () => requestCaptureRenewal('renovación preventiva'),
      SPEECH_RENEWAL_MS
    );
  }

  function handleRecognitionError(error, failedStream) {
    if (failedStream !== recognizeStream) return;
    console.error('Error en Speech-to-Text:', error);
    recognizeStream = null;
    clearTimeout(speechRenewalTimer);
    speechRecoveryAttempts += 1;

    if (!speakerStreaming) return;
    if (speechRecoveryAttempts <= MAX_SPEECH_RECOVERY_ATTEMPTS) {
      requestCaptureRenewal(`recuperación automática ${speechRecoveryAttempts}`);
      return;
    }

    clearSpeechTimers();
    renewalRequested = false;
    speakerStreaming = false;
    const eventId = socket.eventId || DEFAULT_EVENT_ID;
    releaseSpeaker(activeSpeakers, eventId, socket.id);
    broadcastEventStatus(eventId);
    socket.emit('speaker_error', {
      message: 'No se pudo recuperar el procesamiento de audio. Detén y vuelve a iniciar la transmisión.',
    });
  }

  function startRecognitionStream() {
    if (!speakerStreaming || !speechClient) return;
    clearSpeechTimers();
    renewalRequested = false;

    const nextStream = speechClient.streamingRecognize(SPEECH_REQUEST);
    recognizeStream = nextStream;
    nextStream
      .on('error', (error) => handleRecognitionError(error, nextStream))
      .on('data', (data) => {
        if (nextStream !== recognizeStream) return;
        const result = data.results && data.results[0];
        const alternative = result && result.alternatives && result.alternatives[0];
        if (!alternative) return;

        speechRecoveryAttempts = 0;
        clearSemanticFlushTimer();
        latestTranscript = alternative.transcript;
        const isFinal = Boolean(result.isFinal);
        const chunk = transcriptChunker.next({
          transcript: latestTranscript,
          isFinal,
          stability: Number(result.stability || 0),
        });
        if (isFinal) latestTranscript = '';
        enqueueTranslation(chunk, isFinal);
        if (isFinal && !chunk) scheduleSemanticFlush();
      });
    scheduleSpeechRenewal();
    console.log('Stream de reconocimiento activo.');
  }

  function rotateRecognitionStream(reason) {
    if (!speakerStreaming) return;
    console.log(`Renovando stream de reconocimiento: ${reason}`);
    finishRecognitionStream({ flush: true });
    transcriptChunker.reset();
    clearSemanticFlushTimer();
    startRecognitionStream();
  }

  socket.on('start_speaker_stream', (request = {}, acknowledge = () => {}) => {
    if (typeof request === 'function') {
      acknowledge = request;
      request = {};
    }
    const eventId = socket.eventId || DEFAULT_EVENT_ID;
    if (socket.role !== 'speaker') {
      acknowledge({ ok: false, message: 'Esta conexión no es un panel de orador.' });
      return;
    }
    const suppliedToken = String(request?.token || socket.handshake.auth?.speakerToken || '');
    if (SPEAKER_TOKEN && suppliedToken !== SPEAKER_TOKEN) {
      const message = 'Clave de orador incorrecta.';
      socket.emit('speaker_error', { message });
      acknowledge({ ok: false, message });
      return;
    }
    const speakerName = normalizeSpeakerName(request?.speakerName || socket.speakerName);
    if (!speakerName) {
      const message = 'Ingresa el nombre del expositor antes de comenzar.';
      socket.emit('speaker_error', { message });
      acknowledge({ ok: false, message });
      return;
    }
    if (!speechClient || !translateClient || !ttsClient) {
      const message = 'Los servicios de Google Cloud no están disponibles.';
      socket.emit('speaker_error', { message });
      acknowledge({ ok: false, message });
      return;
    }
    if (!claimSpeaker(activeSpeakers, eventId, socket.id, (socketId) => io.sockets.sockets.has(socketId))) {
      const message = 'Ya existe un orador transmitiendo en esta demo.';
      socket.emit('speaker_error', { message });
      acknowledge({ ok: false, message });
      return;
    }

    try {
      console.log('Iniciando stream del orador...');
      socket.speakerName = speakerName;
      speakerStreaming = true;
      speechRecoveryAttempts = 0;
      finishRecognitionStream({ flush: false });
      transcriptChunker.reset();
      clearSemanticFlushTimer();
      startRecognitionStream();
      acknowledge({ ok: true, eventId, speakerName });
      broadcastEventStatus(eventId);
    } catch (error) {
      speakerStreaming = false;
      releaseSpeaker(activeSpeakers, eventId, socket.id);
      const message = 'No se pudo iniciar el procesamiento de audio.';
      console.error(message, error);
      socket.emit('speaker_error', { message });
      acknowledge({ ok: false, message });
      broadcastEventStatus(eventId);
    }
  });

  socket.on('restart_speaker_stream', () => {
    if (socket.role !== 'speaker' || !speakerStreaming) return;
    rotateRecognitionStream('nuevo contenedor de audio del navegador');
  });

  socket.on('audio_data', (audioChunk) => {
    if (socket.role === 'speaker' && recognizeStream && activeSpeakers.get(socket.eventId || DEFAULT_EVENT_ID) === socket.id) {
      if (!acceptsAudioChunk(audioChunk)) {
        console.warn(`Fragmento de audio rechazado para ${socket.id}`);
        return;
      }
      try { recognizeStream.write(audioChunk); }
      catch (error) {
        console.error('Error enviando audio al reconocimiento:', error);
        requestCaptureRenewal('fallo al enviar audio');
      }
    }
  });

  socket.on('stop_speaker_stream', () => {
    if (socket.role !== 'speaker') return;
    const eventId = socket.eventId || DEFAULT_EVENT_ID;
    speakerStreaming = false;
    renewalRequested = false;
    finishRecognitionStream({ flush: true });
    transcriptChunker.reset();
    releaseSpeaker(activeSpeakers, eventId, socket.id);
    broadcastEventStatus(eventId);
    console.log('Stream del orador detenido.');
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    const eventId = socket.eventId || DEFAULT_EVENT_ID;
    speakerStreaming = false;
    renewalRequested = false;
    finishRecognitionStream({ flush: false });
    transcriptChunker.reset();
    releaseSpeaker(activeSpeakers, eventId, socket.id);
    broadcastEventStatus(eventId);
  });
});

app.use((error, _req, res, _next) => {
  if (error?.message === 'Origen no permitido') {
    res.status(403).json({ ok: false, error: 'Origen no permitido' });
    return;
  }
  console.error('Error HTTP no controlado:', error);
  res.status(500).json({ ok: false, error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor de Traducción IA ejecutándose en el puerto ${PORT}`);
});
