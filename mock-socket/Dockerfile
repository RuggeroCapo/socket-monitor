FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    MOCK_SOCKET_HOST=0.0.0.0 \
    MOCK_SOCKET_PORT=3101 \
    MOCK_SOCKET_SCENARIO_FILE=/app/scenarios/default.json

COPY server.js ./
COPY scenarios ./scenarios

EXPOSE 3101

CMD ["node", "server.js"]
