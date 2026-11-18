# The agent-runner image: the delegated execution host of OQ-03 sections 3 to 5, deployed to the Fly app of
# infra/fly/openquant-staging-agent-runner.toml. Build it from the repository root:
#
#   docker build --file apps/agent-runner/Dockerfile --tag openquant-agent-runner .
#
# The build fetches only npm packages: pnpm at the packageManager version, the dependencies locked in pnpm-lock.yaml
# (no install script runs), and Claude Code at the pinned executor version. The base image is pinned by digest; its
# tag names the Node version of .node-version. scripts/infrastructure.ts checks the pins, the executor version (equal
# to AGENT_EXECUTOR_VERSION of apps/api/wrangler.jsonc) and the non-root user.
#
# No credential is in the image. The model credential (ANTHROPIC_API_KEY) and the runner's own secrets are Fly app
# secrets, set outside this file (infra/environments/staging.json); the runner passes only the model credential to
# the child (apps/agent-runner/README.md, Isolation of the executor).

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /src
RUN npm install --global --ignore-scripts pnpm@11.25.0
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
# The runner and its two workspace dependencies, in dependency order: dist/agent-runner.mjs and dist/bundle.
RUN pnpm --filter "@openquant/agent-runner..." run build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
# The pinned executor. Its one install script (install.cjs) links the platform binary from its optional dependency
# and downloads nothing; it is the only script allowed. The version check runs the binary with --version only, never
# with a prompt.
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.325 \
 && npm cache clean --force \
 && DISABLE_AUTOUPDATER=1 claude --version | grep -q '^2\.1\.325 '
WORKDIR /opt/openquant/agent-runner
COPY --from=build /src/apps/agent-runner/dist ./
ENV NODE_ENV=production \
    AGENT_RUNNER_EXECUTOR_PATH=/usr/local/bin/claude \
    AGENT_RUNNER_EXECUTOR_VERSION=2.1.325
USER node
CMD ["node", "agent-runner.mjs"]
