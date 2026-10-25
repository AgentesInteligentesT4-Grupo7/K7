# Downloads do YouTube para o módulo "midia" (spec midia): yt-dlp + ffmpeg (converter) + deno (o YouTube exige um
# runtime de JavaScript desde o fim de 2025). O yt-dlp precisa estar recente: quando o YouTube mudar e os downloads
# falharem, suba a versão abaixo e reconstrua (docker compose ... build).
FROM denoland/deno:bin-2.9.7 AS deno

FROM python:3.12-slim
COPY --from=deno /deno /usr/local/bin/deno
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "yt-dlp[default]==2026.10.21" "fastapi>=0.115,<1" "uvicorn>=0.32,<1"

WORKDIR /app
COPY server.py .
EXPOSE 8899
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8899"]
