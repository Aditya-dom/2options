"""Live liquidation of a long that cannot pay its funding, with real transactions.

    cd agent && uv run python scripts/liquidation_demo.py <account.testnet> [--usdc 20]

A long has no margin requirement, but it owes funding every settlement. This run shows the two
rules the contract applies to it:

1. A buy is paid in full: an order whose premium is more than the account's cash is refused.
2. A long whose cash cannot cover the funding it owes is closed by the keeper at the mark, and
   what is left after a small fee stays in the account.

It deposits `--usdc`, spends almost all of it on an out-of-the-money call, then waits for the
next funding settlement. Nothing is staged: no parameter is changed and no price has to move.
The wait is up to one funding interval (an hour on the shared deployment), so start it a few
minutes before the top of the hour.

Needs: agent/.env (contract and token ids), the agent and its keeper running (AGENT_URL, default
http://127.0.0.1:8787), and the account's key in ~/.near-credentials/testnet/<account>.json or
in NEAR_ACCOUNT_KEY. Use an account with no open positions. It takes test USDC from the faucet
when the wallet is short.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from twooptions_agent import config, near, rpc  # noqa: E402

USDC = 10**6
ONE = 10**6
LOT = 1_000  # the contract's smallest trade size
results: list[bool] = []


def check(ok: bool, name: str, detail: Any = "") -> bool:
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail != "" else ""), flush=True)  # fmt: skip
    return bool(ok)


def main() -> int:
    p = argparse.ArgumentParser(description="Live liquidation of an under-funded long")
    p.add_argument("account")
    p.add_argument("--usdc", type=int, default=20, help="collateral to put behind the long")
    p.add_argument("--series", help="default: the first call above spot")
    p.add_argument("--env-file", default=str(Path(__file__).resolve().parents[1] / ".env"))
    p.add_argument("--wait", type=int, help="seconds to wait; default one funding interval + 5 min")
    a = p.parse_args()
    me = a.account

    config.load_dotenv(Path(a.env_file))
    agent_url = os.environ.get("AGENT_URL", "http://127.0.0.1:8787").rstrip("/")
    net = config.network()
    contract, token = net.contract_id, os.environ["TWOOPTIONS_USDC_ID"]
    secret = os.environ.get("NEAR_ACCOUNT_KEY", "").strip()
    if not secret:
        cred = Path.home() / ".near-credentials" / net.network / f"{me}.json"
        secret = json.loads(cred.read_text())["private_key"]
    acct = near.Account(net.rpc_url, me, near.parse_secret_key(secret))

    def view(account: str, method: str, args: dict[str, Any] | None = None) -> Any:
        return rpc.view(net.rpc_url, account, method, args, finality="optimistic")

    def agent(path: str) -> Any:
        try:
            with urllib.request.urlopen(agent_url + path, timeout=20) as r:  # noqa: S310
                return json.load(r)
        except urllib.error.HTTPError as e:
            return {"http": e.code, **json.load(e)}

    def account() -> Any:
        return view(contract, "get_account", {"account_id": me})

    def send(receiver: str, method: str, args: dict[str, Any], deposit: int = 0) -> near.TxResult:
        try:
            return acct.call(receiver, method, args, gas=100 * near.TGAS, deposit=deposit)
        finally:
            time.sleep(2.0)  # load-balanced RPCs: let the next view see this transaction

    def quote(series: str, side: str, size: int) -> Any:
        q: Any = {}
        for _ in range(6):
            query = urllib.parse.urlencode({"series": series, "side": side, "size": size, "taker": me})  # fmt: skip
            q = agent("/quote?" + query)
            if "quote" in q or q.get("http") not in (429, 502, 503):
                return q
            time.sleep(3)  # rate limit, spot momentarily stale, or an RPC hiccup
        return q

    def trade_error(q: Any) -> str:
        try:
            send(contract, "trade", {"quote": q["quote"], "signature": q["signature"]})
        except rpc.RpcError as e:
            return str(e)
        return ""

    # -- the deployment and the agent -------------------------------------------------------
    health = agent("/health")
    if not check(bool(health.get("ok")) and health.get("keeper") is not None, "agent is up with its keeper", health.get("spot_age_s")):  # fmt: skip
        return 1
    params = view(contract, "get_params")
    interval_s = int(params["funding_interval_ns"]) // 10**9
    spot = int(agent("/spot")["ETH"]["price"])
    print(f"      {contract}: spot {spot / 1e8:.2f}, funding every {interval_s} s")

    # -- collateral -------------------------------------------------------------------------
    before = account()
    if before is not None and before["positions"]:
        print("this account already has positions; use a fresh one", file=sys.stderr)
        return 2
    have = int(before["collateral"]) if before else 0
    need = a.usdc * USDC - have
    if need > 0:
        if int(view(token, "ft_balance_of", {"account_id": me})) < need:
            send(token, "faucet", {})
        send(token, "ft_transfer_call", {"receiver_id": contract, "amount": str(need), "msg": "deposit"}, deposit=1)  # fmt: skip
    cash = int(account()["collateral"])
    if not check(cash >= a.usdc * USDC, "collateral is in the contract", f"{cash / 1e6:.2f} USDC"):
        return 1

    # -- pick the option --------------------------------------------------------------------
    chain = {r["series"]: r for r in agent("/chain")}
    series_now = {s["id"]: s for s in view(contract, "list_series")}
    if a.series:
        sid = a.series
    else:
        above = [s for s in series_now.values() if s["kind"] == "Call" and int(s["strike"]) > spot and s["id"] in chain]  # fmt: skip
        if not above:
            print("no call above spot is listed", file=sys.stderr)
            return 2
        sid = min(above, key=lambda s: int(s["strike"]))["id"]
    ask = int(chain[sid]["ask"])
    net_before = int(series_now[sid]["net_trader_size"])
    print(f"      {sid}: ask {ask / 1e6:.4f} USDC per contract")

    # -- rule 1: a buy is paid in full -------------------------------------------------------
    big = (3 * cash * ONE // ask // LOT + 1) * LOT
    q = quote(sid, "Buy", big)
    if "quote" in q:
        err = trade_error(q)
        check(
            "not enough cash to pay the premium" in err,
            f"a buy of {big / ONE:g} contracts on {cash / 1e6:.2f} USDC of cash is refused",
            err[-70:] or "it was ACCEPTED: this contract still lets longs be opened on credit",
        )
        if not err:
            return 1
    else:
        print(f"      (agent would not quote {big / ONE:g} contracts: {q.get('error')}; skipped)")

    # -- open the long with almost no cash to spare -------------------------------------------
    price, size, q = ask, 0, {}
    for _ in range(5):  # the ask can move between the chain read and the quote: size from the quote
        size = cash * 998 // 1000 * ONE // price // LOT * LOT
        q = quote(sid, "Buy", size)
        if "quote" not in q:
            break
        price = int(q["quote"]["price"])
        if -(-price * size // ONE) <= cash:
            break
        q = {"error": "the ask kept moving; try again"}
    if "quote" not in q or size <= 0:
        check(False, "agent quotes the long", q)
        return 1
    premium = -(-int(q["quote"]["price"]) * size // ONE)
    err = trade_error(q)
    opened = account()
    if not check(err == "" and opened["positions"], f"buy {size / ONE:g} {sid} for {premium / 1e6:.4f} USDC", err[-70:]):  # fmt: skip
        return 1
    left = int(opened["collateral"])
    pos = opened["positions"][0]
    check(
        0 <= left < premium // 50,
        "the premium took nearly all the cash",
        f"{left / 1e6:.4f} USDC left, equity {int(opened['equity']) / 1e6:.4f}, requirement {opened['requirement']}",
    )
    seen = {x["tx_hash"] for x in (agent("/health").get("keeper") or {}).get("liquidated", [])}

    # -- rule 2: wait for funding to outgrow the cash, and for the keeper ---------------------
    deadline = time.time() + (a.wait or interval_s + 300)
    print(f"      waiting for the next funding settlement of {sid} (up to {int(deadline - time.time())} s)")  # fmt: skip
    owed_shown = -1
    final = opened
    while time.time() < deadline:
        time.sleep(5)
        try:
            final = account()
            idx = int(view(contract, "get_series", {"series": sid})["funding_index"])
        except rpc.RpcError:
            continue
        if final is None or not final["positions"]:
            break
        owed = -(-size * (idx - int(pos["entry_index"])) // ONE)
        if owed != owed_shown:
            owed_shown = owed
            state = "more than the cash: liquidatable" if owed > left else "covered"
            print(f"      funding owed {owed / 1e6:.4f} USDC against {left / 1e6:.4f} of cash ({state})")  # fmt: skip
    closed = final is None or not final["positions"]
    if not check(closed, "the keeper closed the position", "still open" if not closed else ""):
        return 1

    back = int(final["collateral"]) if final else 0
    net_after = int(view(contract, "get_series", {"series": sid})["net_trader_size"])
    check(net_after == net_before, "the vault's side of the position is closed too", net_after)
    s = view(contract, "get_solvency")
    check(s["ledger_total"] == s["net_inflow"], "contract ledger equals net USDC received", s)

    mine = [x for x in (agent("/health").get("keeper") or {}).get("liquidated", []) if x["account"] == me and x["tx_hash"] not in seen]  # fmt: skip
    if check(bool(mine), "the keeper reports the liquidation transaction"):
        explorer = "https://testnet.nearblocks.io" if net.network == "testnet" else "https://nearblocks.io"  # fmt: skip
        print(f"      {explorer}/txns/{mine[0]['tx_hash']}")
        # The transaction's own events say what was charged; the balance must match to the micro.
        tx = near._call(
            net.rpc_url,
            "tx",
            {"tx_hash": mine[0]["tx_hash"], "sender_account_id": mine[0]["liquidator"], "wait_until": "EXECUTED_OPTIMISTIC"},
            20,
        )  # fmt: skip
        events = {}
        for o in tx["receipts_outcome"]:
            for line in o["outcome"]["logs"]:
                if line.startswith("EVENT_JSON:"):
                    e = json.loads(line.removeprefix("EVENT_JSON:"))
                    events[e["event"]] = e["data"][0]
        liq = events["Liquidation"]
        value, reward, shortfall = int(liq["notional"]), int(liq["reward"]), int(liq["shortfall"])
        funding = int(events.get("FundingApplied", {}).get("amount", 0))
        settle = left - funding + value
        insurance = max(0, min(value * int(params["insurance_bps"]) // 10_000, settle - reward))
        expected = settle - reward - insurance if shortfall == 0 else 0
        check(
            back == expected and reward == min(value * int(params["liquidation_reward_bps"]) // 10_000, max(settle, 0)),
            "the account keeps cash - funding + value at the mark - fees, to the micro",
            f"{left / 1e6:.6f} - {funding / 1e6:.6f} + {value / 1e6:.6f} - {reward / 1e6:.6f} - {insurance / 1e6:.6f} = {back / 1e6:.6f} USDC",
        )  # fmt: skip
        print(f"      put in {(premium + left) / 1e6:.4f}, back {back / 1e6:.4f}: funding, a 1% fee on the value closed, and the option's price change since the buy")  # fmt: skip

    failed = results.count(False)
    print(f"\n{len(results) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
