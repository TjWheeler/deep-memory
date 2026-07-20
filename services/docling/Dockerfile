# Document-conversion service — wraps docling-serve for the indexer.
#
# The upstream image is CPU-only and already packages docling-serve plus its
# Python deps and the layout/table models; this Dockerfile exists so this repo
# owns the version pin and any future startup customisation (env defaults,
# healthcheck binaries) without requiring users to hand-edit compose files.
#
# Pin the base tag rather than tracking `latest` so deterministic rebuilds do
# not silently change docling's schema version underneath the TypeScript client.
ARG DOCLING_SERVE_TAG=v1.26.0
FROM ghcr.io/docling-project/docling-serve-cpu:${DOCLING_SERVE_TAG}

# docling-serve defaults to uvicorn on 0.0.0.0:5001; the upstream entrypoint is
# kept verbatim. Downstream compose maps the container's 5001 to a host port
# exposed to the indexer.
EXPOSE 5001

# Health probe target for compose — docling-serve ships a `/health` endpoint as
# part of the v1 API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5001/health || exit 1
