# syntax=docker/dockerfile:1

# ---- Stage 1: build the enterprise frontend (Vite) ----
FROM node:20-slim AS frontend-build
WORKDIR /src/frontend-enterprise
COPY frontend-enterprise/package.json frontend-enterprise/package-lock.json ./
RUN npm ci
COPY frontend-enterprise/ ./
RUN npm run build

# ---- Stage 2: backend runtime ----
FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/ ./backend/
RUN pip install --no-cache-dir -e ./backend

COPY --from=frontend-build /src/frontend-enterprise/dist ./frontend-enterprise/dist

# Drop root before serving: create a dedicated unprivileged user and give it
# ownership of /data (where the SQLite DB and other runtime state live).
RUN groupadd --system --gid 10001 staffdeck \
    && useradd --system --uid 10001 --gid staffdeck --home-dir /app --shell /usr/sbin/nologin staffdeck \
    && mkdir -p /data \
    && chown -R staffdeck:staffdeck /app /data

WORKDIR /app/backend

# Headless server: bind 0.0.0.0 inside the container, expose 5173.
ENV STAFFDECK_HEADLESS=true \
    ULTRARAG_HOST=0.0.0.0 \
    ULTRARAG_PORT=5173 \
    ULTRARAG_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 5173
USER staffdeck

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD curl -fsS http://127.0.0.1:5173/api/health || exit 1

# --mode lan forces a 0.0.0.0 bind; the plain "local" default (with no
# persisted network.json) silently overrides ULTRARAG_HOST back to 127.0.0.1.
CMD ["python", "desktop_launcher.py", "--mode", "lan", "--host", "0.0.0.0", "--port", "5173"]
