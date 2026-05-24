FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    EMAIL_SERVER_HOST=0.0.0.0 \
    EMAIL_SERVER_PORT=8080 \
    EMAIL_DATA_DIR=/data \
    EMAIL_DATABASE_PATH=/data/mail.sqlite \
    EMAIL_SECRET_STORE=file \
    EMAIL_SECRET_STORE_PATH=/data/secrets.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

EXPOSE 8080

CMD ["npm", "run", "server"]
