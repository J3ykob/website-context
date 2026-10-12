# The project agent's sandbox: opencode + python for calculations, CSV and spreadsheets.
# The donor image ships the shim @cloudflare/sandbox runs in the container; keep its tag equal to
# the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates ripgrep jq bc python3 python3-openpyxl procps \
  && rm -rf /var/lib/apt/lists/*
# The platform binary directly: the opencode-ai postinstall would pick a CPU variant from the build
# host (an emulator here); baseline runs on every x64 host. Pinned: flags and the event format change
# between releases (benchmarked on 1.19.0, 2026-10-12).
RUN npm install --global --ignore-scripts opencode-linux-x64-baseline@1.19.0 \
  && ln -s /usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace/project /workspace/task
WORKDIR /workspace/project
CMD ["sleep", "infinity"]
