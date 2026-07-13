require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const speech = require('@google-cloud/speech');
const { Translate } = require('@google-cloud/translate').v2;
const textToSpeech = require('@google-cloud/text-to-speech');
const cors = require('cors');

const app = express();
app.use(cors());
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

// Configuración de idiomas y voces válidas de Google Cloud Text-to-Speech.
const TARGET_LANGUAGES = [
  { code: 'en', languageCode: 'en-US', voiceName: 'en-US-Standard-A' },
  { code: 'fr', languageCode: 'fr-FR', voiceName: 'fr-FR-Standard-F' },
  { code: 'pt', languageCode: 'pt-BR', voiceName: 'pt-BR-Standard-A' },
];

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);
  let recognizeStream = null;

  socket.on('join_role', (role) => {
    socket.role = role;
    socket.join(role);
    console.log(`Socket ${socket.id} unido como ${role}`);
  });

  socket.on('start_speaker_stream', () => {
    if (socket.role !== 'speaker') return;
    console.log("Iniciando stream del orador...");

    // Configuración para el streaming de audio
    const request = {
      config: {
        encoding: 'WEBM_OPUS', // Ajusta según el formato capturado en el frontend (MediaRecorder suele usar webm)
        sampleRateHertz: 48000,
        languageCode: 'es-ES',
      },
      interimResults: false, // Solo queremos resultados finales para no saturar con traducciones a medias
    };

    if(speechClient) {
        recognizeStream = speechClient
            .streamingRecognize(request)
            .on('error', (err) => {
                console.error("Error en Speech-to-Text:", err);
            })
            .on('data', async (data) => {
                if (data.results[0] && data.results[0].alternatives[0]) {
                    const isFinal = data.results[0].isFinal;
                    if (isFinal) {
                        const transcript = data.results[0].alternatives[0].transcript;
                        console.log(`Orador (ES): ${transcript}`);
                        
                        // Enviar el subtítulo original a quienes escuchan español
                        io.to('listener').emit('translation', {
                            lang: 'es',
                            text: transcript,
                            audio: null // El orador ya se escucha en vivo, o se puede emitir el original si se desea
                        });

                        // Traducir y sintetizar los idiomas en paralelo para reducir la latencia.
                        await Promise.all(TARGET_LANGUAGES.map(async ({ code, languageCode, voiceName }) => {
                            try {
                                // 1. Traducir
                                const [translation] = await translateClient.translate(transcript, code);

                                // 2. Text-to-Speech. Si falla, el subtítulo igual se envía.
                                let audioBuffer = null;
                                try {
                                    const ttsRequest = {
                                        input: { text: translation },
                                        voice: { languageCode, name: voiceName },
                                        audioConfig: { audioEncoding: 'MP3' },
                                    };
                                    const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
                                    audioBuffer = ttsResponse.audioContent;
                                } catch (ttsError) {
                                    console.error(`Error generando audio para ${code}:`, ttsError);
                                }

                                // 3. Emitir al frontend (subtítulo + audio)
                                io.to('listener').emit('translation', {
                                    lang: code,
                                    text: translation,
                                    audio: audioBuffer // Buffer que se reproducirá en el cliente
                                });
                            } catch (err) {
                                console.error(`Error traduciendo idioma ${code}:`, err);
                            }
                        }));
                    }
                }
            });
    }
  });

  socket.on('audio_data', (audioChunk) => {
    if (socket.role === 'speaker' && recognizeStream) {
      recognizeStream.write(audioChunk);
    }
  });

  socket.on('stop_speaker_stream', () => {
    if (socket.role === 'speaker' && recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      console.log("Stream del orador detenido.");
    }
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    if (recognizeStream) {
      recognizeStream.end();
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor de Traducción IA ejecutándose en el puerto ${PORT}`);
});
