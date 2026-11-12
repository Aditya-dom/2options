"""An in-memory stand-in for the twooptions contract's views and keeper methods.

It verifies agent signatures the way the contract does and enforces the checks the keeper has
to get right (sequence, staleness, epoch, band), so tests fail for the same reasons a real
transaction would.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import margin, wire
from twooptions_agent.near import TxError, TxResult

SEC = 1_000_000_000
HOUR = 3_600 * SEC
CONTRACT = "twooptions.testnet"
#: 2026-11-10T00:00:00Z, the start of an hourly funding epoch.
T0 = 1_794_268_800 * SEC

PARAMS: dict[str, Any] = {
    "max_quote_ttl_ns": 30 * SEC,
    "max_spot_age_ns": 30 * SEC,
    "max_positions": 16,
    "max_funding_rate": 50_000_000,
    "funding_interval_ns": HOUR,
    "liquidation_reward_bps": 50,
    "insurance_bps": 50,
    "lp_cooldown_ns": HOUR,
    "min_lp_liquidity": 1_000_000,
    "min_deposit": 1_000_000,
    "initial_ratio_bps": 15_000,
    "close_only_ratio_bps": 13_000,
    "liquidation_ratio_bps": 11_500,
    "vault_ratio_bps": 12_000,
    "max_time_value_bps": 400,
    "min_time_value_bps": 20,
    "tv_reserve_bps": 100,
    "min_margin_per_contract": 5_000_000,
    "max_spot_jump_bps": 1_000,
    "mark_band_bps": 100,
    "max_epoch_outflow_bps": 1_000,
}


def series_view(sid: str, net: int = 0, last_mark: int = 0, active: bool = True) -> dict[str, Any]:
    u, strike, kind = sid.split("-")
    return {
        "id": sid,
        "underlying": u,
        "strike": str(int(strike) * 10**8),
        "kind": "Call" if kind == "C" else "Put",
        "funding_index": "0",
        "last_mark": str(last_mark),
        "last_epoch": "0",
        "net_trader_size": str(net),
        "active": active,
    }


@dataclass
class FakeChain:
    agent: Ed25519PrivateKey
    now_ns: int = T0 + 60 * SEC
    params: dict[str, Any] = field(default_factory=lambda: dict(PARAMS))
    series: dict[str, dict[str, Any]] = field(default_factory=dict)
    spots: dict[str, tuple[int, int, int]] = field(default_factory=dict)  # price, ts, seq
    accounts: dict[str, dict[str, Any]] = field(default_factory=dict)
    vault_cash: int = 100_000 * 10**6
    paused: bool = False
    account_id: str = "keeper.testnet"
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    # The vault's net payout in the current funding interval (the contract's outflow cap).
    out_epoch: int = -1
    epoch_net_out: int = 0
    epoch_start_cash: int = 0
    fail_next: str | None = None

    def add_series(self, *ids: str) -> None:
        for sid in ids:
            self.series[sid] = series_view(sid)

    def set_spot(self, u: str, usd: float, age_s: float = 0) -> None:
        ts = self.now_ns - int(age_s * SEC)
        self.spots[u] = (round(usd * 10**8), ts, ts // 1_000_000)

    # -- views --------------------------------------------------------------------------------

    def view(self, method: str, args: dict[str, Any] | None = None) -> Any:
        a = args or {}
        if method == "get_params":
            return dict(self.params)
        if method == "list_series":
            return [dict(s) for s in self.series.values()]
        if method == "get_spot":
            sp = self.spots.get(a["underlying"])
            return None if sp is None else [str(sp[0]), str(sp[1])]
        if method == "get_vault":
            epoch = self.now_ns // self.params["funding_interval_ns"]
            same = epoch == self.out_epoch
            return {
                "cash": str(self.vault_cash),
                "epoch": str(epoch),
                "epoch_net_outflow": str(self.epoch_net_out if same else 0),
                "epoch_start_cash": str(self.epoch_start_cash if same else self.vault_cash),
            }
        if method == "is_paused":
            return self.paused
        if method == "get_account":
            return self.accounts.get(a["account_id"])
        if method == "is_agent_key":
            return True
        raise AssertionError(f"unexpected view {method}")

    # -- transactions -------------------------------------------------------------------------

    def _verify(self, msg: wire.Message, signature: str) -> None:
        try:
            self.agent.public_key().verify(base64.b64decode(signature), wire.digest(CONTRACT, msg))
        except InvalidSignature as e:
            raise TxError("invalid agent signature") from e

    def call(
        self,
        receiver_id: str,
        method: str,
        args: dict[str, Any] | None = None,
        gas: int = 0,
        deposit: int = 0,
    ) -> TxResult:
        assert receiver_id == CONTRACT
        a = args or {}
        if self.fail_next:
            msg, self.fail_next = self.fail_next, None
            raise TxError(msg)
        if method == "post_spot":
            u = wire.SpotUpdate.from_json(a["update"])
            self._verify(u, a["signature"])
            if u.ts_ns > self.now_ns + 5 * SEC:
                raise TxError("timestamp is in the future")
            if self.now_ns - u.ts_ns > self.params["max_spot_age_ns"]:
                raise TxError("spot update is stale")
            prev = self.spots.get(u.underlying.name)
            if prev is not None:
                if u.seq <= prev[2]:
                    raise TxError("sequence must increase")
                if u.ts_ns < prev[1]:
                    raise TxError("timestamp must not go backwards")
            self.spots[u.underlying.name] = (u.price, u.ts_ns, u.seq)
        elif method == "settle_funding":
            f = wire.FundingUpdate.from_json(a["update"])
            self._verify(f, a["signature"])
            now_epoch = self.now_ns // self.params["funding_interval_ns"]
            if not (f.epoch <= now_epoch and f.epoch + 1 >= now_epoch):
                raise TxError("epoch is not current")
            s = self.series[f.series]
            if f.epoch <= int(s["last_epoch"]):
                raise TxError("epoch already settled")
            spot = self.spots[s["underlying"]][0]
            lo, hi = margin.price_band(
                s["kind"] == "Call",
                spot,
                int(s["strike"]),
                margin.MarginParams.from_json(self.params),
            )
            if not lo <= f.mark <= hi:
                raise TxError("mark is outside the allowed band")
            cap = self.params["max_funding_rate"]
            rate = max(-cap, min(cap, f.rate))
            s["funding_index"] = str(int(s["funding_index"]) + rate * f.mark // 10**9)
            s["last_mark"] = str(f.mark)
            s["last_epoch"] = str(f.epoch)
            s["ref_mark"] = str(f.mark)
            s["ref_spot"] = str(spot)
        elif method == "liquidate":
            if self.account_id not in self.accounts:
                raise TxError("liquidator needs an account to receive the reward")
            acct = self.accounts[a["account_id"]]
            acct["positions"] = []
        else:
            raise AssertionError(f"unexpected call {method}")
        self.calls.append((method, a))
        return TxResult(f"tx{len(self.calls)}", [], None)
