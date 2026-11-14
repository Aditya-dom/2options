"""End-to-end check against a live deployment: every user-facing contract path, with real
transactions, from a throwaway account.

    cd agent && uv run python scripts/e2e_testnet.py <account.testnet>

Needs: agent/.env (contract and token ids), the agent running on :8787, and the account's key in
~/.near-credentials/testnet/<account>.json (as `near account create-account ... save-to-legacy-keychain`
leaves it). The account pays its own gas and mints its own test USDC, so nothing here uses the
owner or keeper key. Not covered here: liquidation (scripts/liquidation_demo.py runs one live).
The LP claim has a one-hour cooldown: run the script again with the same account an hour or more
later and it collects the claim the first run left (one more check).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from twooptions_agent import config, near, rpc, wire  # noqa: E402

AGENT = os.environ.get("AGENT_URL", "http://127.0.0.1:8787")
USDC = 10**6
ONE = 10**6
results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: Any = "") -> None:
    results.append((bool(ok), name, str(detail)))
    print(
        ("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail != "" else ""),
        flush=True,
    )


def agent(path: str) -> Any:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(AGENT + path, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            return {"http": e.code, **json.load(e)}
        except (urllib.error.URLError, TimeoutError):
            # The agent answers from chain state; a stalled public RPC behind it shows up here.
            if attempt == 2:
                raise
            time.sleep(3)
    raise AssertionError("unreachable")


def main() -> int:
    me = sys.argv[1]
    config.load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    net = config.network()
    contract, token = net.contract_id, os.environ["TWOOPTIONS_USDC_ID"]
    cred = json.loads((Path.home() / ".near-credentials" / "testnet" / f"{me}.json").read_text())
    acct = near.Account(net.rpc_url, me, near.parse_secret_key(cred["private_key"]))
    # Public RPCs are load-balanced: a view right after a transaction can hit a node that has
    # not seen it yet. Give every write a moment before the checks read it back.
    send_now = acct.send

    def send_and_settle(
        receiver_id: str, actions: list[near.Action], wait: str = "EXECUTED_OPTIMISTIC"
    ) -> near.TxResult:
        try:
            return send_now(receiver_id, actions, wait)
        finally:
            time.sleep(2.0)

    acct.send = send_and_settle  # type: ignore[method-assign]

    def view(account: str, method: str, args: dict[str, Any] | None = None) -> Any:
        return rpc.view(net.rpc_url, account, method, args, finality="optimistic")

    def account() -> Any:
        return view(contract, "get_account", {"account_id": me})

    def wallet() -> int:
        return int(view(token, "ft_balance_of", {"account_id": me}))

    def fails(fn: Any) -> str:
        try:
            fn()
        except rpc.RpcError as e:
            return str(e)
        return "(succeeded)"

    def quote(series: str, side: str, size: int, taker: str = me) -> Any:
        for _ in range(5):
            q = agent(f"/quote?series={series}&side={side}&size={size}&taker={taker}")
            if "quote" in q or q.get("http") not in (502, 503):
                return q
            time.sleep(3)  # spot momentarily stale or RPC hiccup
        return q

    def trade(q: Any) -> near.TxResult:
        return acct.call(
            contract,
            "trade",
            {"quote": q["quote"], "signature": q["signature"]},
            gas=100 * near.TGAS,
        )

    def transfer_call(usdc: int, msg: str) -> near.TxResult:
        args = {"receiver_id": contract, "amount": str(usdc * USDC), "msg": msg}
        return acct.call(token, "ft_transfer_call", args, gas=100 * near.TGAS, deposit=1)

    # -- agent and market -------------------------------------------------------------------
    health = agent("/health")
    check(
        health.get("ok") and max(health["spot_age_s"].values()) < 30,
        "agent healthy, spot on chain is fresh",
        health.get("spot_age_s"),
    )
    att = agent("/attestation")
    check(
        view(contract, "is_agent_key", {"key": att["agent_public_key"]}),
        "agent key is registered on the contract",
    )
    spot = int(agent("/spot")["ETH"]["price"]) / 1e8
    chain = {r["series"]: r for r in agent("/chain")}
    # The listed strike nearest spot that has a neighbour on each side (for the two-leg trade
    # below). The grid's spacing depends on the deployment, so it is read, not assumed.
    strikes = sorted({int(s.split("-")[1]) for s in chain if s.startswith("ETH-")})
    below = {k: strikes[i - 1] for i, k in enumerate(strikes) if 0 < i < len(strikes) - 1}
    above = {k: strikes[i + 1] for i, k in enumerate(strikes) if 0 < i < len(strikes) - 1}
    strike = min(below or strikes, key=lambda k: abs(k - spot))
    call, put = f"ETH-{strike}-C", f"ETH-{strike}-P"
    check(
        call in chain and put in chain,
        "chain prices the at-the-money strike",
        f"spot {spot:.2f}, strike {strike}",
    )
    c = chain[call]
    check(
        # Within one strike of the money. On a deployment with a short funding interval the
        # options are short-dated and delta is steep, so the bounds are wide.
        int(c["bid"]) < int(c["mark"]) < int(c["ask"]) and 0.1 < c["delta"] < 0.9,
        "nearest-strike call: bid < mark < ask, delta between 0.1 and 0.9",
        f"{int(c['bid']) / 1e6:.2f} / {int(c['ask']) / 1e6:.2f}, delta {c['delta']}",
    )

    # -- funds in ---------------------------------------------------------------------------
    check(
        quote(call, "Buy", ONE).get("error") == "deposit first", "no quote before the first deposit"
    )
    # The faucet pays 2,000 once per 24h per account; this account's earlier claims may still be
    # cooling down, so claim only when it is open and check the refusal either way.
    if view(token, "faucet_status", {"account_id": me})["next_claim_ns"] is None:
        before = wallet()
        acct.call(token, "faucet", {})
        check(wallet() == before + 2_000 * USDC, "faucet pays 2,000 test USDC", wallet() / USDC)
    before = wallet()
    err = fails(lambda: acct.call(token, "faucet", {}))
    check(
        "already claimed" in err and wallet() == before,
        "a second faucet claim within 24 hours is refused",
        err[-45:],
    )
    err = fails(lambda: acct.call(token, "mint", {"account_id": me, "amount": str(USDC)}))
    check("only the owner can mint" in err, "mint is owner only", err[-45:])
    w0 = wallet()
    check(w0 >= 6_000 * USDC, "wallet holds the 6,000 test USDC this run moves", w0 / USDC)
    transfer_call(5_000, "deposit")
    check(
        int(account()["collateral"]) == 5_000 * USDC and wallet() == w0 - 5_000 * USDC,
        "deposit credits collateral 1:1",
    )
    fails(lambda: transfer_call(1, "nonsense"))
    check(
        wallet() == w0 - 5_000 * USDC,
        "a deposit with an unknown message is refunded by the token",
        wallet() / USDC,
    )

    # -- trading ----------------------------------------------------------------------------
    # A long has no margin requirement, so this rule is all that stops a buy on credit. The
    # deepest in-the-money call costs the most per unit of risk the vault takes on.
    deep = min(
        (s for s in view(contract, "list_series") if s["kind"] == "Call" and s["id"] in chain),
        key=lambda s: int(s["strike"]),
    )["id"]
    cash = int(account()["collateral"])
    too_many = (cash * 12 // 10 * ONE // int(chain[deep]["ask"]) // 1_000 + 1) * 1_000
    credit = quote(deep, "Buy", too_many)
    err = (
        fails(lambda: trade(credit))
        if "quote" in credit
        else f"agent refused: {credit.get('error')}"
    )
    check(
        "not enough cash to pay the premium" in err and int(account()["collateral"]) == cash,
        "a buy that costs more than the account's cash is rejected",
        f"{too_many / ONE:g} {deep}: {err[-50:]}",
    )

    q = quote(call, "Buy", 2 * ONE)
    before = int(account()["collateral"])
    r = trade(q)
    a = account()
    paid = before - int(a["collateral"])
    check(
        paid == -(-int(q["quote"]["price"]) * 2 * ONE // ONE)
        and a["positions"][0]["size"] == str(2 * ONE),
        "buy 2 calls: premium debited, position opened",
        f"paid {paid / 1e6:.2f}, tx {r.tx_hash}",
    )
    check("entry_index" in a["positions"][0], "position view carries entry_index")

    err = fails(lambda: trade(q))
    check("nonce already used" in err, "replaying a quote is rejected", err[-60:])
    q2 = quote(call, "Buy", ONE)
    forged = {"quote": {**q2["quote"], "price": "1"}, "signature": q2["signature"]}
    err = fails(lambda: trade(forged))
    check("invalid agent signature" in err, "a tampered price is rejected", err[-60:])
    # Any other account the agent will quote for: the keeper always has a contract balance.
    someone_else = os.environ.get("KEEPER_ACCOUNT_ID") or os.environ["OWNER_ACCOUNT_ID"]
    other = quote(call, "Buy", ONE, taker=someone_else)
    err = fails(lambda: trade(other)) if "quote" in other else "agent refused"
    check("different taker" in err, "someone else's quote is rejected", err[-60:])

    # A stolen agent key: a validly signed quote that the general price band still accepts (just
    # under its top edge, intrinsic + max_time_value_bps of spot) but that sits far from the
    # last funding mark. Only the mark anchor stands between this price and a fill.
    agent_key = config.agent_key()
    series_view = view(contract, "get_series", {"series": call})
    if series_view.get("ref_mark") is not None:
        good = quote(call, "Buy", ONE)["quote"]
        params = view(contract, "get_params")
        spot_raw = int(view(contract, "get_spot", {"underlying": "ETH"})[0])
        spot_micros = spot_raw // 100  # spot is 1e8 fixed point, USDC 1e6
        intrinsic = max(0, spot_raw - int(series_view["strike"])) // 100
        tv_bps = int(params["max_time_value_bps"]) - 50  # room for spot to tick before inclusion
        far = intrinsic + spot_micros * tv_bps // 10_000
        allowed = (
            abs(spot_raw - int(series_view["ref_spot"])) // 100
            + spot_micros * int(params["mark_band_bps"]) // 10_000
        )
        check(
            abs(far - int(series_view["ref_mark"])) > allowed,
            "the forged price is inside the price band but outside the mark band",
            f"forged {far / 1e6:.2f}, mark {int(series_view['ref_mark']) / 1e6:.2f}, "
            f"allowed ±{allowed / 1e6:.2f}",
        )
        forged = wire.Quote(
            call,
            me,
            wire.Side.Buy,
            ONE,
            far,
            int(good["nonce"]) + 1,
            int(good["expiry_ns"]),
        )
        err = fails(
            lambda: acct.call(
                contract,
                "trade",
                {"quote": forged.to_json(), "signature": wire.sign(agent_key, contract, forged)},
                gas=100 * near.TGAS,
            )
        )
        check(
            "too far from the last funding mark" in err,
            "a validly signed price far from the funding mark is rejected",
            err[-60:],
        )
    v = view(contract, "get_vault")
    check(
        "epoch_net_outflow" in v and int(v["epoch_start_cash"]) > 0,
        "vault reports its hourly outflow and cap base",
        {k: v.get(k) for k in ("epoch_net_outflow", "epoch_start_cash")},
    )

    q = quote(put, "Sell", ONE)
    trade(q)
    a = account()
    req, eq = int(a["requirement"]), int(a["equity"])
    check(
        req > 0.2 * spot * USDC and eq > req,
        "sell 1 put: margin requirement appears",
        f"requirement {req / 1e6:.2f}, equity {eq / 1e6:.2f}, health {eq / req:.2f}x",
    )

    big = quote(put, "Sell", 40 * ONE)
    err = fails(lambda: trade(big)) if "quote" in big else big.get("error", "")
    check(
        "insufficient margin" in err or "risk limit" in err,
        "an under-margined short is rejected",
        err[-70:],
    )

    # Two legs in one transaction, as the strategy builder sends them.
    lo, hi = f"ETH-{below[strike]}-P", f"ETH-{above[strike]}-C"
    legs = [quote(hi, "Buy", ONE), quote(lo, "Buy", ONE)]
    acct.send(
        contract,
        [
            near.FunctionCall(
                "trade", {"quote": x["quote"], "signature": x["signature"]}, 100 * near.TGAS
            )
            for x in legs
        ],
    )
    check(
        len(account()["positions"]) == 4,
        "two legs fill in one transaction",
        [p["series"] for p in account()["positions"]],
    )
    bad = [
        quote(hi, "Buy", ONE),
        {"quote": {**legs[0]["quote"]}, "signature": legs[0]["signature"]},
    ]
    n_before = len(account()["positions"])
    hi_before = next(p["size"] for p in account()["positions"] if p["series"] == hi)
    fails(
        lambda: acct.send(
            contract,
            [
                near.FunctionCall(
                    "trade", {"quote": x["quote"], "signature": x["signature"]}, 100 * near.TGAS
                )
                for x in bad
            ],
        )
    )
    hi_after = next(p["size"] for p in account()["positions"] if p["series"] == hi)
    check(
        hi_after == hi_before and len(account()["positions"]) == n_before,
        "a batch with one bad leg fills nothing",
    )

    # -- withdraw ---------------------------------------------------------------------------
    err = fails(
        lambda: acct.call(contract, "withdraw", {"amount": str(4_900 * USDC)}, gas=100 * near.TGAS)
    )
    check(
        "under-margined" in err or "insufficient" in err,
        "cannot withdraw margin behind a short",
        err[-60:],
    )
    w = wallet()
    acct.call(contract, "withdraw", {"amount": str(100 * USDC)}, gas=100 * near.TGAS)
    check(wallet() == w + 100 * USDC, "withdraw pays USDC to the wallet")

    # -- LP vault ---------------------------------------------------------------------------
    # A claim left by an earlier run of this script (an hour or more ago) has matured: collect
    # it first, because requesting another redemption below restarts its cooldown.
    old_claim = view(contract, "get_lp_claim", {"account_id": me})
    if old_claim is not None and int(old_claim[1]) <= time.time_ns():
        w = wallet()
        acct.call(contract, "lp_claim", {}, gas=100 * near.TGAS)
        check(
            wallet() == w + int(old_claim[0])
            and view(contract, "get_lp_claim", {"account_id": me}) is None,
            "a matured LP claim pays out in full and is cleared",
            f"{int(old_claim[0]) / 1e6:.6f} USDC",
        )
    shares0 = int(view(contract, "get_lp_shares", {"account_id": me}))
    transfer_call(1_000, "lp")
    shares = int(view(contract, "get_lp_shares", {"account_id": me})) - shares0
    check(shares > 0, "LP deposit mints shares", f"{shares / 1e6:.4f} shares for 1,000 USDC")
    acct.call(contract, "lp_request_redeem", {"shares": str(shares // 2)})
    claim = view(contract, "get_lp_claim", {"account_id": me})
    check(
        claim is not None and int(claim[0]) > 490 * USDC,
        "redeem request creates a claim at the share price",
        f"{int(claim[0]) / 1e6:.2f} USDC",
    )
    err = fails(lambda: acct.call(contract, "lp_claim", {}, gas=100 * near.TGAS))
    check("cooldown" in err, "claim is refused during the cooldown", err[-40:])

    # -- funding ----------------------------------------------------------------------------
    hist = agent("/funding/history?limit=500")
    check(
        len(hist) >= 1 and all(h["tx_hash"] for h in hist),
        "agent serves funding settlements it posted",
        f"{len(hist)} settlements",
    )
    series = {s["id"]: s for s in view(contract, "list_series")}
    accrued = sum(
        int(p["size"]) * (int(series[p["series"]]["funding_index"]) - int(p["entry_index"])) // ONE
        for p in account()["positions"]
    )
    print(
        f"      funding accrued since entry: {accrued / 1e6:.4f} USDC (non-zero only after the next hourly settlement)"
    )

    # -- close out --------------------------------------------------------------------------
    for p in account()["positions"]:
        size = int(p["size"])
        q = quote(p["series"], "Sell" if size > 0 else "Buy", abs(size))
        if "quote" not in q:
            check(False, f"close {p['series']}", q)
            continue
        trade(q)
    a = account()
    check(
        a["positions"] == [] and int(a["requirement"] or 0) == 0,
        "every position closes",
        f"collateral {int(a['collateral']) / 1e6:.2f}",
    )
    left = int(a["collateral"])
    w = wallet()
    acct.call(contract, "withdraw", {"amount": str(left)}, gas=100 * near.TGAS)
    check(
        account() is None and wallet() == w + left,
        "withdraw everything: account is removed from contract storage",
        f"wallet {wallet() / 1e6:.2f}",
    )
    cost = 5_000 * USDC - 100 * USDC - left
    print(f"      round trip cost (spreads + funding): {cost / 1e6:.2f} USDC")
    s = view(contract, "get_solvency")
    check(s["ledger_total"] == s["net_inflow"], "contract ledger equals net USDC received", s)
    inv = agent("/inventory")
    check("net_delta" in inv, "agent reports vault inventory", inv.get("net_delta"))

    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
