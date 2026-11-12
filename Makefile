# ---------------------------------------------------------------------------------------------
# NEAR build: contracts/twooptions, app/ (frontend), agent/ (off-chain helpers)
# ---------------------------------------------------------------------------------------------
.PHONY: near-setup near-test near-dev near-fixtures near-wasm near-agent near-bootstrap near-status

# install app and agent dependencies
near-setup:
	cd app && bun install
	cd agent && uv sync --python 3.11

# contract, app and agent tests
near-test:
	cd contracts/twooptions && cargo test --lib
	cd contracts/test-usdc && cargo test --lib
	cd app && bun test src && bunx tsc -p .
	cd agent && uv run --python 3.11 pytest -q

# frontend on :3001 (demo mode unless app/.env sets VITE_CONTRACT_ID)
near-dev:
	cd app && bun run dev

# regenerate the parity fixtures after changing margin.rs, math.rs or the signed message types
near-fixtures:
	cd contracts/twooptions && cargo run -q --example margin_vectors > ../../app/src/lib/fixtures/margin_vectors.json
	cd contracts/twooptions && cargo run -q --example wire_vectors 2>/dev/null > ../../agent/tests/fixtures/wire_vectors.json
	cd app && bun scripts/near_tx_vectors.ts > ../agent/tests/fixtures/near_tx_vectors.json

# build both contracts to wasm (contracts/target/wasm32-unknown-unknown/release/*.wasm).
# Uses cargo-near when installed; otherwise a plain cargo build, which contracts/.cargo/config.toml
# makes equivalent for our purposes (`--cfg near`). The plain build is what runs on testnet.
near-wasm:
	@if command -v cargo-near >/dev/null 2>&1; then \
		cd contracts/twooptions && cargo near build non-reproducible-wasm --no-abi && \
		cd ../test-usdc && cargo near build non-reproducible-wasm --no-abi; \
	else \
		cd contracts && cargo build --lib --target wasm32-unknown-unknown --release -p twooptions -p test-usdc; \
	fi

# quote server + keeper on :8787 (needs agent/.env, see agent/.env.example)
near-agent:
	cd agent && uv run --python 3.11 python -m twooptions_agent.server

# testnet: deploy test USDC + twooptions, set params, add series, seed LP liquidity (idempotent)
near-bootstrap:
	cd agent && uv run --python 3.11 python -m twooptions_agent.admin bootstrap

near-status:
	cd agent && uv run --python 3.11 python -m twooptions_agent.admin status
