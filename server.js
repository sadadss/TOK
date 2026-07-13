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

// Configuración de idiomas soportados para la traducción
const TARGET_LANGUAGES = ['en', 'fr', 'pt'];

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

                        // Traducir y sintetizar a los idiomas objetivo
                        for (const lang of TARGET_LANGUAGES) {
                            try {
                                // 1. Traducir
                                const [translation] = await translateClient.translate(transcript, lang);
                                
                                // 2. Text-to-Speech
                                const ttsRequest = {
                                    input: { text: translation },
                                    voice: { languageCode: lang, name: `${lang}-Standard-A` },
                                    audioConfig: { audioEncoding: 'MP3' },
                                };
                                const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
                                const audioBuffer = ttsResponse.audioContent;

                                // 3. Emitir al frontend (subtítulo + audio)
                                io.to('listener').emit('translation', {
                                    lang: lang,
                                    text: translation,
                                    audio: audioBuffer // Buffer que se reproducirá en el cliente
                                });
                            } catch (err) {
                                console.error(`Error procesando idioma ${lang}:`, err);
                            }
                        }
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
