# ---- Base con OpenSSL 3 + legacy ----
FROM ubuntu:22.04

# Install base dependencies (excluding default nodejs/npm)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends \
    curl ca-certificates build-essential openssl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 using NodeSource repository
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

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

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]