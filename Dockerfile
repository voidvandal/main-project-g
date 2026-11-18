# SeatSpot web server for Amazon Lightsail container service.
FROM node:22-alpine
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund @aws-sdk/client-s3@^3
COPY backend/src backend/src
COPY backend/package.json backend/package.json
COPY frontend frontend
COPY local local
ENV PORT=8080 DEMO=0 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "local/server.mjs"]
