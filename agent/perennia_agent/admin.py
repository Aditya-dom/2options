"""Owner-side setup for a testnet deployment (#18): everything HANDOFF_GAURAV.md section 1 asks for.

    uv run python -m perennia_agent.admin keygen
    uv run python -m perennia_agent.admin bootstrap --underlyings ETH     # the whole list below
    uv run python -m perennia_agent.admin status

`bootstrap` runs these in order and skips whatever is already done, so it is safe to rerun:

    deploy-usdc      create `usdc.<owner>`, deploy the test token (testnet only)
    deploy           create `perennia.<owner>`, deploy and call `new`
    set-params       apply PARAMS_PRESET (funding cap, price band, quote TTL)
    register         storage_deposit for the contract on the USDC token
    add-series       a strike grid around the live spot, calls and puts
    seed-lp          mint test USDC to the owner and deposit it as LP liquidity
    fund-keeper      give the keeper account a contract balance so it can receive liquidation rewards

`upgrade` and `upgrade-usdc` replace the code of an existing deployment and keep its state.

It reads OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY from the environment (or `.env`). The owner key
is only needed here, never by the running agent.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import config, near, rpc
from .spot import SpotFeed
from .wire import Underlying

log = logging.getLogger("perennia_admin")

SEC = 1_000_000_000
USDC = 10**6

#: Parameters the agent's pricing needs, on top of the contract's defaults. Applied by
#: `set-params`. Each line says why it differs from `Params::default()` in types.rs.
PARAMS_PRESET: dict[str, int] = {
    # Multi-leg strategies need every leg quoted and then one wallet confirmation.
    "max_quote_ttl_ns": 30 * SEC,
    # Funding is 1/24 of time value per hour, 4.17% of mark for an out-of-the-money option.
    # The default 4% cap would clip every one of them.
    "max_funding_rate": 50_000_000,
    # At-the-money time value is about 1.1% of spot at 60% vol and 2.8% at 150%. The default
    # 1.5% band would stop the agent quoting in a volatile market.
    "max_time_value_bps": 400,
    # Reserve per short contract, sized to the larger time value.
    "tv_reserve_bps": 150,
}

FAUCET_COMMANDS = frozenset({"deploy-usdc", "mint", "seed-lp", "fund-keeper"})

STRIKE_STEPS = (1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000)


def strike_grid(spot_usd: float, width: int = 2, step_frac: float = 0.025) -> list[int]:
    """Whole-dollar strikes around spot: the at-the-money strike and `width` either side.

    The step is the largest round number no bigger than `step_frac` of spot. With an average
    option life of a day, one daily standard deviation is about 3% for ETH, so strikes much
    further than 5% out are worth close to nothing.
    """
    if spot_usd <= 0:
        raise ValueError("spot must be positive")
    step = max((s for s in STRIKE_STEPS if s <= spot_usd * step_frac), default=1)
    atm = max(step, round(spot_usd / step) * step)
    return [k for k in (atm + i * step for i in range(-width, width + 1)) if k > 0]


def merged_params(current: dict[str, Any], preset: dict[str, int]) -> dict[str, Any]:
    unknown = set(preset) - set(current)
    if unknown:
        raise ValueError(f"preset names parameters the contract does not have: {sorted(unknown)}")
    return {**current, **preset}


# ---------------------------------------------------------------------------------------------


class Admin:
    def __init__(self, rpc_url: str, owner: near.Account, contract_id: str, usdc_id: str):
        self.rpc_url = rpc_url
        self.owner = owner
        self.contract_id = contract_id
        self.usdc_id = usdc_id

    def view(self, account_id: str, method: str, args: dict[str, Any] | None = None) -> Any:
        return rpc.view(self.rpc_url, account_id, method, args, finality="optimistic")

    def has_code(self, account_id: str) -> bool | None:
        """True if a contract is deployed, False if the account is empty, None if it is missing."""
        try:
            r = near._call(
                self.rpc_url,
                "query",
                {
                    "request_type": "view_account",
                    "finality": "optimistic",
                    "account_id": account_id,
                },
                15,
            )
        except rpc.RpcError as e:
            if "UNKNOWN_ACCOUNT" in str(e) or "does not exist" in str(e):
                return None
            raise
        return bool(r["code_hash"] != "1" * 32)

    def _deploy(
        self, account_id: str, wasm: Path, near_amount: float, init: near.FunctionCall
    ) -> None:
        state = self.has_code(account_id)
        if state:
            log.info("%s already has a contract; leaving it alone", account_id)
            return
        code = wasm.read_bytes()
        if code[:4] != b"\0asm":
            raise SystemExit(f"{wasm} is not a wasm file")
        actions: list[near.Action] = [near.DeployContract(code), init]
        if state is None:
            if not account_id.endswith("." + self.owner.account_id):
                raise SystemExit(
                    f"{account_id} does not exist and is not a sub-account of {self.owner.account_id}"
                )
            actions = [
                near.CreateAccount(),
                near.Transfer(int(near_amount * near.YOCTO_PER_NEAR)),
                near.AddFullAccessKey(near.public_key_bytes(self.owner.key)),
                *actions,
            ]
            res = self.owner.send(account_id, actions)
        else:
            # The account exists without code: it must sign its own deploy with the owner's key.
            res = near.Account(self.rpc_url, account_id, self.owner.key).send(account_id, actions)
        log.info("deployed %s (%d bytes) in %s", account_id, len(code), res.tx_hash)

    def upgrade(self, account_id: str, wasm: Path) -> None:
        """Replace the code of a deployed contract. State is kept, so the new code must read the
        old storage layout: fine for a rebuild or a logic change, not for a changed struct."""
        code = wasm.read_bytes()
        if code[:4] != b"\0asm":
            raise SystemExit(f"{wasm} is not a wasm file")
        if not self.has_code(account_id):
            raise SystemExit(f"{account_id} has no contract to upgrade; use deploy")
        res = near.Account(self.rpc_url, account_id, self.owner.key).send(
            account_id, [near.DeployContract(code)]
        )
        log.info("upgraded %s (%d bytes) in %s", account_id, len(code), res.tx_hash)

    def deploy_usdc(self, wasm: Path, near_amount: float) -> None:
        self._deploy(self.usdc_id, wasm, near_amount, near.FunctionCall("new", {}))

    def deploy(self, wasm: Path, near_amount: float, agent_key: str) -> None:
        init = near.FunctionCall(
            "new",
            {"owner_id": self.owner.account_id, "usdc": self.usdc_id, "agent_keys": [agent_key]},
            gas=50 * near.TGAS,
        )
        self._deploy(self.contract_id, wasm, near_amount, init)

    def set_agent_keys(self, keys: list[str]) -> None:
        if all(self.view(self.contract_id, "is_agent_key", {"key": k}) for k in keys):
            log.info("agent keys already registered")
            return
        self.owner.call(self.contract_id, "set_agent_keys", {"keys": keys})
        log.info("registered agent keys %s", keys)

    def set_params(self) -> None:
        current = self.view(self.contract_id, "get_params")
        wanted = merged_params(current, PARAMS_PRESET)
        if wanted == current:
            log.info("params already match the preset")
            return
        self.owner.call(self.contract_id, "set_params", {"params": wanted})
        log.info("params updated: %s", PARAMS_PRESET)

    def register(self, account_id: str) -> None:
        if self.view(self.usdc_id, "storage_balance_of", {"account_id": account_id}) is not None:
            log.info("%s is already registered with %s", account_id, self.usdc_id)
            return
        bounds = self.view(self.usdc_id, "storage_balance_bounds")
        self.owner.call(
            self.usdc_id,
            "storage_deposit",
            {"account_id": account_id, "registration_only": True},
            deposit=int(bounds["min"]),
        )
        log.info("registered %s with %s", account_id, self.usdc_id)

    def add_series(self, underlyings: list[Underlying], width: int) -> None:
        existing = {s["id"] for s in self.view(self.contract_id, "list_series")}
        feed = SpotFeed(underlyings)
        for d in feed.poll():
            if d.update is None:
                raise SystemExit(f"no spot for {d.underlying.name}: {d.hold}")
            for strike in strike_grid(d.update.price / 1e8, width):
                for kind, letter in (("Call", "C"), ("Put", "P")):
                    sid = f"{d.underlying.name}-{strike}-{letter}"
                    if sid in existing:
                        continue
                    self.owner.call(
                        self.contract_id,
                        "add_series",
                        {
                            "underlying": d.underlying.name,
                            "strike": str(strike * 10**8),
                            "kind": kind,
                        },
                    )
                    log.info("added %s", sid)

    def mint(self, account_id: str, usdc: float) -> None:
        self.owner.call(
            self.usdc_id, "mint", {"account_id": account_id, "amount": str(int(usdc * USDC))}
        )
        log.info("minted %s test USDC to %s", usdc, account_id)

    def _transfer_call(self, sender: near.Account, usdc: float, msg: str) -> None:
        sender.call(
            self.usdc_id,
            "ft_transfer_call",
            {"receiver_id": self.contract_id, "amount": str(int(usdc * USDC)), "msg": msg},
            gas=100 * near.TGAS,
            deposit=1,
        )

    def seed_lp(self, usdc: float) -> None:
        vault = self.view(self.contract_id, "get_vault")
        if int(vault["total_shares"]) > 0:
            log.info("vault already has liquidity (cash %s)", vault["cash"])
            return
        self.mint(self.owner.account_id, usdc)
        self._transfer_call(self.owner, usdc, "lp")
        log.info("seeded the vault with %s USDC", usdc)

    def fund_keeper(self, keeper: near.Account, usdc: float) -> None:
        if (
            self.view(self.contract_id, "get_account", {"account_id": keeper.account_id})
            is not None
        ):
            log.info("keeper %s already has a contract balance", keeper.account_id)
            return
        self.mint(keeper.account_id, usdc)
        self._transfer_call(keeper, usdc, "deposit")
        log.info("keeper %s deposited %s USDC", keeper.account_id, usdc)

    def status(self) -> dict[str, Any]:
        c = self.contract_id
        series = self.view(c, "list_series")
        underlyings = sorted({s["underlying"] for s in series})
        return {
            "contract_id": c,
            "usdc_id": self.usdc_id,
            "owner": self.view(c, "get_owner"),
            "paused": self.view(c, "is_paused"),
            "params": self.view(c, "get_params"),
            "series": [s["id"] for s in series],
            "spot": {u: self.view(c, "get_spot", {"underlying": u}) for u in underlyings},
            "vault": self.view(c, "get_vault"),
            "solvency": self.view(c, "get_solvency"),
            "contract_registered_with_usdc": self.view(
                self.usdc_id, "storage_balance_of", {"account_id": c}
            )
            is not None,
        }


def _repo_wasm(name: str) -> Path:
    """The cargo-near artifact when there is one, else the plain cargo build."""
    target = Path(__file__).resolve().parents[2] / "contracts" / "target"
    near_build = target / "near" / name / f"{name}.wasm"
    if near_build.exists():
        return near_build
    return target / "wasm32-unknown-unknown" / "release" / f"{name}.wasm"


def _keygen() -> int:
    key = Ed25519PrivateKey.generate()
    pub = near.public_key_bytes(key)
    print(
        json.dumps(
            {
                "public_key": near.public_key_str(key),
                "secret_key": near.secret_key_str(key),
                "implicit_account_id": pub.hex(),
            },
            indent=2,
        )
    )
    print(
        "Keep the secret key out of git. Put it in agent/.env, which is ignored.", file=sys.stderr
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Perennia testnet setup")
    p.add_argument("--env-file", default=".env")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("keygen", help="print a new ed25519 key pair")
    sub.add_parser("status", help="print the contract's state")
    for name in ("bootstrap", "deploy-usdc", "deploy", "set-params", "register", "add-series",
                 "seed-lp", "fund-keeper", "set-agent-keys", "mint", "upgrade", "upgrade-usdc"):  # fmt: skip
        s = sub.add_parser(name)
        s.add_argument("--wasm", type=Path, default=_repo_wasm("perennia"))
        s.add_argument("--usdc-wasm", type=Path, default=_repo_wasm("test_usdc"))
        s.add_argument("--underlyings", default="ETH")
        s.add_argument("--width", type=int, default=2, help="strikes each side of the money")
        s.add_argument("--lp-usdc", type=float, default=250_000.0)
        s.add_argument("--keeper-usdc", type=float, default=100.0)
        s.add_argument(
            "--contract-near",
            type=float,
            default=6.5,
            help="NEAR for the new contract account (storage)",
        )
        s.add_argument("--usdc-near", type=float, default=3.5)
        s.add_argument("--to", help="mint: receiving account")
        s.add_argument("--amount", type=float, default=10_000.0, help="mint: USDC")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    if a.cmd == "keygen":
        return _keygen()

    config.load_dotenv(Path(a.env_file))
    try:
        net = config.network()
        usdc_id = config._need("PERENNIA_USDC_ID")
        owner = near.Account(
            net.rpc_url, config._need("OWNER_ACCOUNT_ID"), config._key("OWNER_PRIVATE_KEY")
        )
    except config.ConfigError as e:
        log.error("%s", e)
        return 2
    admin = Admin(net.rpc_url, owner, net.contract_id, usdc_id)
    if a.cmd == "status":
        print(json.dumps(admin.status(), indent=2))
        return 0

    is_test_token = usdc_id.endswith("." + owner.account_id)
    if a.cmd in FAUCET_COMMANDS and not (net.network == "testnet" and is_test_token):
        log.error(
            "%s uses the test token's open faucet: testnet only, with PERENNIA_USDC_ID under the "
            "owner account",
            a.cmd,
        )
        return 2
    if a.cmd == "bootstrap" and net.network != "testnet":
        log.error("bootstrap is for testnet; on mainnet run the steps one at a time")
        return 2

    underlyings = [Underlying[x.strip()] for x in a.underlyings.split(",")]
    try:
        agent_pub = near.public_key_str(config.agent_key())
        steps: dict[str, Callable[[], None]] = {
            "deploy-usdc": lambda: admin.deploy_usdc(a.usdc_wasm, a.usdc_near),
            "deploy": lambda: admin.deploy(a.wasm, a.contract_near, agent_pub),
            "set-agent-keys": lambda: admin.set_agent_keys([agent_pub]),
            "set-params": admin.set_params,
            "register": lambda: admin.register(net.contract_id),
            "add-series": lambda: admin.add_series(underlyings, a.width),
            "seed-lp": lambda: admin.seed_lp(a.lp_usdc),
            "fund-keeper": lambda: _fund_keeper(admin, net, a.keeper_usdc),
            "mint": lambda: admin.mint(a.to or owner.account_id, a.amount),
            "upgrade": lambda: admin.upgrade(net.contract_id, a.wasm),
            "upgrade-usdc": lambda: admin.upgrade(usdc_id, a.usdc_wasm),
        }
        if a.cmd == "bootstrap":
            order = ["deploy", "set-agent-keys", "set-params", "register", "add-series"]
            if is_test_token:
                order = ["deploy-usdc", *order, "seed-lp", "fund-keeper"]
            else:
                log.warning(
                    "%s is not a test token under the owner: skipping deploy-usdc, seed-lp and fund-keeper",
                    usdc_id,
                )
            for name in order:
                log.info("== %s", name)
                steps[name]()
            print(json.dumps(admin.status(), indent=2))
        else:
            steps[a.cmd]()
    except (config.ConfigError, rpc.RpcError) as e:
        log.error("%s", e)
        return 1
    return 0


def _fund_keeper(admin: Admin, net: config.Network, usdc: float) -> None:
    keeper = config.keeper_account(net)
    if keeper is None:
        log.warning("KEEPER_ACCOUNT_ID is not set; skipping")
        return
    if os.environ.get("KEEPER_ACCOUNT_ID") == admin.owner.account_id:
        keeper = admin.owner  # share the nonce counter when both are one account
    admin.fund_keeper(keeper, usdc)


if __name__ == "__main__":
    sys.exit(main())
