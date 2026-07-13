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

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true, service: 'live-translation' }));
app.get(['/overlay', '/overlay.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'overlay.html'));
});
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // En producción, limita esto al dominio de tu WordPress
    methods: ["GET", "POST"]
  }
});

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

function languageRoom(language) {
  return `listener:${language}`;
}

function voiceRoom(language, voice) {
  return `${languageRoom(language)}:${voice}`;
}

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);
  let recognizeStream = null;
  let speakerStreaming = false;
  let speechRenewalTimer = null;
  let speechRenewalFallbackTimer = null;
  let renewalRequested = false;
  let latestTranscript = '';
  let speechRecoveryAttempts = 0;
  let segmentSequence = 0;
  let translationQueue = Promise.resolve();
  const transcriptChunker = createTranscriptChunker();

  async function translateAndBroadcast(text, isFinal) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return;

    const segmentId = `${socket.id}-${++segmentSequence}`;
    console.log(`Orador (ES${isFinal ? ', final' : ', parcial'}): ${normalizedText}`);

    io.to(languageRoom('es')).emit('translation', {
      segmentId,
      lang: 'es',
      text: normalizedText,
      audio: null,
      isFinal,
    });

    await Promise.all(TARGET_LANGUAGES.map(async ({ code, languageCode }) => {
      try {
        const [translation] = await translateClient.translate(normalizedText, code);
        io.to(languageRoom(code)).emit('translation', {
          segmentId,
          lang: code,
          text: translation,
          audio: null,
          isFinal,
        });

        const activeVoices = VOICE_KEYS.filter((voice) => io.sockets.adapter.rooms.get(voiceRoom(code, voice))?.size);
        await Promise.all(activeVoices.map(async (voice) => {
          try {
            const [ttsResponse] = await ttsClient.synthesizeSpeech({
              input: { text: translation },
              voice: { languageCode, name: googleVoiceName(languageCode, voice) },
              audioConfig: { audioEncoding: 'MP3' },
            });
            io.to(voiceRoom(code, voice)).emit('translation_audio', {
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
      } catch (translationError) {
        console.error(`Error traduciendo idioma ${code}:`, translationError);
      }
    }));
  }

  function enqueueTranslation(text, isFinal) {
    if (!text) return;
    translationQueue = translationQueue
      .then(() => translateAndBroadcast(text, isFinal))
      .catch((error) => console.error('Error en la cola de traducción:', error));
  }

  socket.on('join_role', (role) => {
    socket.role = role;
    socket.join(role);
    console.log(`Socket ${socket.id} unido como ${role}`);
  });

  function setListenerPreferences(language, voice, audioEnabled = true) {
    if (socket.role !== 'listener' || !LISTENER_LANGUAGES.has(language)) return;
    const selectedVoice = normalizeVoice(voice);

    for (const supportedLanguage of LISTENER_LANGUAGES) {
      socket.leave(languageRoom(supportedLanguage));
      for (const voiceKey of VOICE_KEYS) socket.leave(voiceRoom(supportedLanguage, voiceKey));
    }
    socket.join(languageRoom(language));
    if (language !== 'es' && audioEnabled) socket.join(voiceRoom(language, selectedVoice));
    socket.listenerLanguage = language;
    socket.listenerVoice = selectedVoice;
    socket.listenerAudioEnabled = audioEnabled;
    console.log(`Oyente ${socket.id} cambió a ${language}/${selectedVoice}`);
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

  function flushPendingTranscript() {
    if (!latestTranscript) return;
    const remaining = transcriptChunker.next({ transcript: latestTranscript, isFinal: true });
    latestTranscript = '';
    enqueueTranslation(remaining, true);
  }

  function finishRecognitionStream({ flush = true } = {}) {
    clearSpeechTimers();
    if (flush) flushPendingTranscript();
    else {
      latestTranscript = '';
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
        latestTranscript = alternative.transcript;
        const isFinal = Boolean(result.isFinal);
        const chunk = transcriptChunker.next({ transcript: latestTranscript, isFinal });
        if (isFinal) latestTranscript = '';
        enqueueTranslation(chunk, isFinal);
      });
    scheduleSpeechRenewal();
    console.log('Stream de reconocimiento activo.');
  }

  function rotateRecognitionStream(reason) {
    if (!speakerStreaming) return;
    console.log(`Renovando stream de reconocimiento: ${reason}`);
    finishRecognitionStream({ flush: true });
    transcriptChunker.reset();
    startRecognitionStream();
  }

  socket.on('start_speaker_stream', () => {
    if (socket.role !== 'speaker') return;
    console.log('Iniciando stream del orador...');
    speakerStreaming = true;
    speechRecoveryAttempts = 0;
    finishRecognitionStream({ flush: false });
    transcriptChunker.reset();
    if (speechClient) startRecognitionStream();
    else socket.emit('speaker_error', { message: 'El servicio de reconocimiento no está disponible.' });
  });

  socket.on('restart_speaker_stream', () => {
    if (socket.role !== 'speaker' || !speakerStreaming) return;
    rotateRecognitionStream('nuevo contenedor de audio del navegador');
  });

  socket.on('audio_data', (audioChunk) => {
    if (socket.role === 'speaker' && recognizeStream) {
      try { recognizeStream.write(audioChunk); }
      catch (error) {
        console.error('Error enviando audio al reconocimiento:', error);
        requestCaptureRenewal('fallo al enviar audio');
      }
    }
  });

  socket.on('stop_speaker_stream', () => {
    if (socket.role !== 'speaker') return;
    speakerStreaming = false;
    renewalRequested = false;
    finishRecognitionStream({ flush: true });
    transcriptChunker.reset();
    console.log('Stream del orador detenido.');
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    speakerStreaming = false;
    renewalRequested = false;
    finishRecognitionStream({ flush: false });
    transcriptChunker.reset();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor de Traducción IA ejecutándose en el puerto ${PORT}`);
});
