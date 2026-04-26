FROM node:20-alpine

# Sharp (для QR) требует нативную компиляцию
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

COPY package.json ./

# Устанавливаем зависимости (включая нативные модули)
RUN npm install --omit=dev

COPY src/ ./src/

# Директория для хранения session credentials (монтируется как volume)
RUN mkdir -p /app/sessions
ENV SESSIONS_DIR=/app/sessions

EXPOSE 3000

CMD ["node", "src/index.js"]
