"""Agent configuration from the environment (and an optional `.env` file).

Secrets are only ever read from the environment. Nothing here logs or returns a private key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import hyperliquid, near, pricing, rpc
from .hedger import HedgeConfig
from .quoter import QuoterConfig
from .wire import Underlying


class ConfigError(RuntimeError):
    pass


def load_dotenv(path: Path) -> None:
    """KEY=VALUE lines; `#` comments; existing environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        os.environ.setdefault(k.strip(), v)


def _need(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise ConfigError(f"{name} is not set (see agent/.env.example)")
    return v


def _key(name: str) -> Ed25519PrivateKey:
    try:
        return near.parse_secret_key(_need(name))
    except ValueError as e:
        raise ConfigError(f"{name}: {e}") from e


def _float(name: str, default: float) -> float:
    v = os.environ.get(name, "").strip()
    try:
        return float(v) if v else default
    except ValueError as e:
        raise ConfigError(f"{name} must be a number") from e


@dataclass(frozen=True)
class Network:
    network: str
    rpc_url: str
    contract_id: str


def network() -> Network:
    net = os.environ.get("NEAR_NETWORK", "testnet").strip() or "testnet"
    if net not in rpc.DEFAULT_RPC:
        raise ConfigError(f"NEAR_NETWORK must be one of {sorted(rpc.DEFAULT_RPC)}")
    return Network(
        net,
        os.environ.get("NEAR_RPC_URL", "").strip() or rpc.DEFAULT_RPC[net],
        _need("TWOOPTIONS_CONTRACT_ID"),
    )


def agent_key() -> Ed25519PrivateKey:
    return _key("AGENT_PRIVATE_KEY")


def keeper_account(net: Network) -> near.Account | None:
    """The account that pays gas for post_spot, settle_funding and liquidate, if configured."""
    if not os.environ.get("KEEPER_ACCOUNT_ID", "").strip():
        return None
    # Tight timeouts: while one transaction hangs, the keeper posts no spot, and the contract
    # refuses trades once the spot is 30 s old.
    return near.Account(
        net.rpc_url,
        _need("KEEPER_ACCOUNT_ID"),
        _key("KEEPER_PRIVATE_KEY"),
        timeout=10.0,
        recovery_s=6.0,
    )


def quoter_config() -> QuoterConfig:
    vols = dict(pricing.DEFAULT_ATM_VOL)
    for u in Underlying:
        vols[u] = _float(f"TWOOPTIONS_VOL_{u.name}", vols[u])
        if not 0.05 <= vols[u] <= 3.0:
            raise ConfigError(f"TWOOPTIONS_VOL_{u.name} must be between 0.05 and 3.0")
    fraction = _float("TWOOPTIONS_FUNDING_FRACTION", pricing.DEFAULT_FUNDING_FRACTION)
    if not 0 < fraction < 1:
        raise ConfigError("TWOOPTIONS_FUNDING_FRACTION must be between 0 and 1")
    return QuoterConfig(
        funding_fraction=fraction,
        quote_ttl_s=_float("TWOOPTIONS_QUOTE_TTL_S", 30.0),
        atm_vol=vols,
    )


def hedge_venue(net: Network) -> hyperliquid.Hyperliquid | None:
    """The perp venue the hedger trades on, or None when no key is configured (no hedging)."""
    key = os.environ.get("HYPERLIQUID_PRIVATE_KEY", "").strip()
    if not key:
        return None
    hl_net = os.environ.get("HYPERLIQUID_NETWORK", "").strip() or "testnet"
    if hl_net not in hyperliquid.API_URL:
        raise ConfigError(f"HYPERLIQUID_NETWORK must be one of {sorted(hyperliquid.API_URL)}")
    if hl_net != net.network:
        # A testnet book hedged with real money, or a real book "hedged" with test money.
        raise ConfigError(
            f"HYPERLIQUID_NETWORK={hl_net} does not match NEAR_NETWORK={net.network}; "
            "the hedge must be on the same kind of network as the contract"
        )
    try:
        signer = hyperliquid.Signer(key)
    except ValueError as e:
        raise ConfigError(f"HYPERLIQUID_PRIVATE_KEY: {e}") from e
    account = os.environ.get("HYPERLIQUID_ACCOUNT_ADDRESS", "").strip() or None
    try:
        return hyperliquid.Hyperliquid(
            signer,
            hl_net,
            account,
            base_url=os.environ.get("HYPERLIQUID_API_URL", "").strip() or None,
        )
    except ValueError as e:
        raise ConfigError(f"HYPERLIQUID_ACCOUNT_ADDRESS: {e}") from e


def hedge_config() -> HedgeConfig:
    d = HedgeConfig()
    cfg = HedgeConfig(
        interval_s=_float("HEDGE_INTERVAL_S", d.interval_s),
        deadband_usd=_float("HEDGE_DEADBAND_USD", d.deadband_usd),
        rehedge_move_bps=_float("HEDGE_REHEDGE_MOVE_BPS", d.rehedge_move_bps),
        max_order_usd=_float("HEDGE_MAX_ORDER_USD", d.max_order_usd),
        max_position_usd=_float("HEDGE_MAX_POSITION_USD", d.max_position_usd),
        slippage_bps=_float("HEDGE_SLIPPAGE_BPS", d.slippage_bps),
        max_basis_bps=_float("HEDGE_MAX_BASIS_BPS", d.max_basis_bps),
    )
    if cfg.interval_s < 1:
        raise ConfigError("HEDGE_INTERVAL_S must be at least 1")
    if cfg.deadband_usd < 0:
        raise ConfigError("HEDGE_DEADBAND_USD must not be negative")
    if not 0 <= cfg.rehedge_move_bps <= 1_000:
        raise ConfigError("HEDGE_REHEDGE_MOVE_BPS must be between 0 and 1000")
    if cfg.max_order_usd < cfg.min_order_usd:
        raise ConfigError(f"HEDGE_MAX_ORDER_USD must be at least {cfg.min_order_usd:.0f}")
    if cfg.max_position_usd <= 0:
        raise ConfigError("HEDGE_MAX_POSITION_USD must be positive")
    if not 0 < cfg.slippage_bps <= 1_000:
        raise ConfigError("HEDGE_SLIPPAGE_BPS must be between 0 and 1000")
    if not 0 < cfg.max_basis_bps <= 5_000:
        raise ConfigError("HEDGE_MAX_BASIS_BPS must be between 0 and 5000")
    return cfg


def cors_origins() -> list[str]:
    raw = os.environ.get("TWOOPTIONS_CORS_ORIGINS", "http://localhost:3001")
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]


def data_dir() -> Path:
    return Path(os.environ.get("TWOOPTIONS_DATA_DIR", "").strip() or "data")
