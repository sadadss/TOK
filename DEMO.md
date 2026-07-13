# Operación de la demo

La configuración predeterminada está pensada para una demostración de baja escala en una sola instancia de Render.

## Enlaces directos

- Orador: `https://traduccion-vivo-backend.onrender.com/speaker?event=demo`
- Oyente: `https://traduccion-vivo-backend.onrender.com/listener?event=demo`
- Overlay: `https://traduccion-vivo-backend.onrender.com/overlay?event=demo&lang=en&voice=clear&mode=transparent&audio=1&clean=1`
- Estado: `https://traduccion-vivo-backend.onrender.com/health`

El parámetro `event` permite separar demostraciones. Debe usarse el mismo valor en el orador, los oyentes y el overlay.

## Variables opcionales

- `SPEAKER_TOKEN`: protege el inicio del orador. Se entrega al panel con `?token=...`.
- `ALLOWED_ORIGINS`: orígenes HTTPS adicionales, separados por coma.
- `MAX_CONNECTIONS`: máximo de conexiones simultáneas; por defecto, 150.
- `GOOGLE_CALL_TIMEOUT_MS`: tiempo máximo de espera por llamada; por defecto, 15000.
- `MAX_TRANSLATION_BACKLOG`: máximo de segmentos esperando traducción; por defecto, 8.
- `MAX_SYNTHESIS_BACKLOG`: máximo de segmentos esperando voz; por defecto, 6.
- `LOG_TRANSCRIPTS=true`: permite registrar el texto reconocido; por defecto no se guarda en los logs.

## Antes de mostrarla

1. Abrir `/health` entre 5 y 10 minutos antes para despertar la instancia gratuita.
2. Abrir el panel del orador y confirmar “Servidor conectado”.
3. Abrir un oyente por cada idioma y verificar texto y audio.
4. Confirmar que un segundo panel de orador no pueda iniciar mientras el primero transmite.
5. Mantener abierta una vista de oyente durante toda la demo para conservar actividad WebSocket.

La demo admite un solo orador por evento y rechaza fragmentos de audio excesivos, colas saturadas y conexiones por encima del límite configurado.
