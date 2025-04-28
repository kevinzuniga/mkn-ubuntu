# ---- Base con OpenSSL 3 + legacy ----
FROM ubuntu:22.04

# Install base dependencies (excluding default nodejs/npm)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends \
    python3-pip && pip3 install pillow pyzbar \
    curl ca-certificates build-essential openssl \
    zbar-tools libzbar0 imagemagick \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends jq

# 2. Repositorio oficial Node 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get update && apt-get install -y nodejs && \
    node -v   # => para ver en el log que quedó 20.x

# Set up OpenSSL config
RUN printf '%s\n' \
    'openssl_conf = openssl_init' \
    '[openssl_init]' \
    'providers = provider_sect' \
    '[provider_sect]' \
    'default = default_sect' \
    'legacy = legacy_sect' \
    '[default_sect]' \
    'activate = 1' \
    '[legacy_sect]' \
    'activate = 1' \
    > /etc/ssl/openssl.cnf
ENV OPENSSL_CONF=/etc/ssl/openssl.cnf

WORKDIR /app

COPY assets/*.png ./
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Hacemos que sea ejecutable
RUN chmod +x scan_qr.py

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]