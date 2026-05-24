FROM node:24-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS=--use-openssl-ca \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
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
