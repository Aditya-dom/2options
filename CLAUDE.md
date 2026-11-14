# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

2Options on NEAR: an everlasting-options contract (`contracts/`), an off-chain agent that prices, signs quotes and runs the keeper (`agent/`), and a React app (`app/`). `README.md` describes it; each part has its own README.

```bash
make near-setup      # app (bun) and agent (uv) dependencies
make near-test       # contract + test-usdc (cargo), app (bun test + tsc), agent (pytest)
make near-fixtures   # regenerate parity fixtures after changing contract types, margin or encoders
make near-wasm       # build both contracts; near-bootstrap / near-agent / near-status need agent/.env
```

- `contracts/twooptions` only compiles for wasm or under test. If linking fails with `libSystem.tbd`, `export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.
- The contract is the source of truth. `agent/twooptions_agent/{wire,margin}.py` and `app/src/lib/{wire,margin}.ts` are ports, checked byte for byte against fixtures generated from the Rust code. Change the Rust first, regenerate, then fix the ports; CI diffs the fixtures.
- `agent/` is standard library plus `cryptography` on purpose (it is meant to run in a TEE). Do not add a web framework or a NEAR SDK; `near.py` encodes and signs transactions itself and is parity-tested against `@near-js/transactions`.
- Price and funding share one parameter (`funding_fraction` in `agent/twooptions_agent/pricing.py`). Do not change one without the other.
- `agent/` has its own `pyproject.toml` (ruff with `B` and `UP`, mypy strict on `twooptions_agent`). Run its checks from `agent/`, not the repo root.
