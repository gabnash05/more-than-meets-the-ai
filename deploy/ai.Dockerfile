FROM ghcr.io/astral-sh/uv:0.13.7 AS uv
FROM python:3.13.18-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libgomp1 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir --disable-pip-version-check pip==26.3
ARG AI_RUNTIME=litert
ENV PYTHONPATH=/repo UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /repo
COPY apps/ai/pyproject.toml apps/ai/uv.lock ./apps/ai/
RUN case "$AI_RUNTIME" in \
      litert) uv sync --locked --no-dev --project apps/ai ;; \
      vit) uv sync --locked --no-dev --extra vit --project apps/ai ;; \
      *) echo "Invalid AI_RUNTIME" >&2; exit 2 ;; \
    esac
COPY apps/ai/ai_service ./apps/ai/ai_service
COPY models/guesser/inference ./models/guesser/inference
COPY models/referee/inference ./models/referee/inference
COPY models/guesser/data/src/__init__.py models/guesser/data/src/06-images.py models/guesser/data/src/common.py models/guesser/data/src/settings.py ./models/guesser/data/src/
USER 1000:1000
EXPOSE 8000
CMD ["/opt/venv/bin/uvicorn", "--app-dir", "/repo/apps/ai", "ai_service.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
