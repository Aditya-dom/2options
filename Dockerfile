# One container for 2Options: the trade desk (static app), the agent API and the keeper.
# Built for a dstack confidential VM (Phala Cloud, NEAR AI Cloud): see deploy/phala/README.md.
# Base images are pinned by digest so the measured image does not change under the same tag.
#
#   docker build -t 2options .
#   docker run --env-file agent/.env -p 8787:8787 2options

# -- the app -------------------------------------------------------------------------------------
FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS app
WORKDIR /src/app
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile
COPY app/ ./
# Baked in at build time. The agent serves the app, so the app calls the agent at its own origin.
ARG VITE_NEAR_NETWORK=testnet
ARG VITE_CONTRACT_ID=contract.twooptions.testnet
ARG VITE_USDC_ID=usdc.twooptions.testnet
ARG VITE_AGENT_URL=same-origin
ENV VITE_NEAR_NETWORK=$VITE_NEAR_NETWORK VITE_CONTRACT_ID=$VITE_CONTRACT_ID \
    VITE_USDC_ID=$VITE_USDC_ID VITE_AGENT_URL=$VITE_AGENT_URL
# Bundle only: the type-check (`bun run build`) also covers tests that read parity fixtures from
# outside app/, and CI runs it on every push.
RUN bunx vite build

# -- the agent -----------------------------------------------------------------------------------
FROM python:3.11-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# The agent's only dependency, at the version in agent/uv.lock.
RUN pip install --no-cache-dir cryptography==50.0.2
RUN useradd --create-home --uid 10001 agent
WORKDIR /srv
COPY agent/twooptions_agent ./twooptions_agent
COPY --from=app /src/app/dist ./static
RUN mkdir -p /data && chown agent /data
USER agent
ENV HOST=0.0.0.0 PORT=8787 \
    TWOOPTIONS_STATIC_DIR=/srv/static TWOOPTIONS_DATA_DIR=/data \
    NEAR_NETWORK=testnet TWOOPTIONS_CONTRACT_ID=contract.twooptions.testnet \
    NEAR_RPC_URL=https://near-testnet.drpc.org,https://test.rpc.fastnear.com \
    TWOOPTIONS_MAX_TRADE_SIZE=0.1 TWOOPTIONS_MAX_POSITION=0.1 TWOOPTIONS_MAX_OPEN_INTEREST=0.25 \
    HEDGE_MAX_POSITION_USD=500 HEDGE_MAX_ORDER_USD=250
EXPOSE 8787
VOLUME ["/data"]
# Secrets (AGENT_PRIVATE_KEY, KEEPER_ACCOUNT_ID, KEEPER_PRIVATE_KEY) come from the environment.
CMD ["python", "-m", "twooptions_agent.server", "--env-file", "/dev/null"]
