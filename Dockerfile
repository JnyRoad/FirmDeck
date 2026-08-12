# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend-enterprise

COPY frontend-enterprise/package.json frontend-enterprise/package-lock.json ./
RUN npm ci
COPY frontend-enterprise/ ./
RUN npm run build

# Build the reviewed, lockfile-backed SRT bundle for the container's Linux
# architecture. The host checkout may contain a bundle for another platform.
COPY packaging/fetch_sandbox_runtime.py packaging/sandbox-runtime-package.json packaging/sandbox-runtime-package-lock.json /build/
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 /build/fetch_sandbox_runtime.py /build/sandbox_runtime

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ULTRARAG_DATA_DIR=/data \
    STAFFDECK_SRT_RUNTIME=/app/packaging/sandbox_runtime \
    DATABASE_URL=sqlite:////data/skill_agent_loop.db \
    TOOL_BASE_URL=http://localhost:5173 \
    CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

WORKDIR /app/backend

COPY backend/pyproject.toml backend/uv.lock ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ripgrep socat \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir .

COPY backend/ ./
COPY --from=frontend-build /build/frontend-enterprise/dist /app/frontend-enterprise/dist
COPY --from=frontend-build /build/sandbox_runtime /app/packaging/sandbox_runtime

RUN useradd --create-home --uid 10001 staffdeck \
    && mkdir -p /data \
    && chown -R staffdeck:staffdeck /app /data
USER staffdeck

EXPOSE 5173
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5173/api/health', timeout=3)"

CMD ["uvicorn", "single_port_app:app", "--host", "0.0.0.0", "--port", "5173"]
