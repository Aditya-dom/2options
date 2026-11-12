import pytest

from twooptions_agent.greeks import everlasting_delta
from twooptions_agent.inventory import SeriesState, compute, rebalance
from twooptions_agent.wire import Underlying

ETH, NEAR = Underlying.ETH, Underlying.NEAR
USD = 10**8
ONE = 10**6


def view(id_: str, u: str, strike: int, kind: str, net: int) -> dict[str, object]:
    return {
        "id": id_,
        "underlying": u,
        "strike": str(strike * USD),
        "kind": kind,
        "net_trader_size": str(net),
        "funding_index": "0",
        "last_mark": "0",
        "last_epoch": "0",
        "active": True,
    }


def test_atm_delta_and_put_call_parity() -> None:
    c = everlasting_delta(2_100, 2_100, 0.6, True)
    p = everlasting_delta(2_100, 2_100, 0.6, False)
    assert c == pytest.approx(0.5, abs=0.01)
    assert c - p == pytest.approx(1 - 2**-50, abs=1e-12)


def test_vault_is_short_what_traders_bought() -> None:
    series = [
        SeriesState.from_view(
            view("ETH-2100-C", "ETH", 2_100, "Call", 20 * ONE)
        ),  # traders long 20 calls
        SeriesState.from_view(
            view("ETH-2050-P", "ETH", 2_050, "Put", -10 * ONE)
        ),  # traders short 10 puts
        SeriesState.from_view(view("ETH-2150-C", "ETH", 2_150, "Call", 0)),
    ]
    inv = compute(series, {ETH: 2_100 * USD}, delta_fn=lambda S, K, v, call: 0.5 if call else -0.25)
    assert [e.series for e in inv.exposures] == ["ETH-2100-C", "ETH-2050-P"]
    # Vault: -20 calls x 0.5 = -10; +10 puts x -0.25 = -2.5.
    assert inv.net_delta == {"ETH": pytest.approx(-12.5)}
    assert inv.hedge_target == {"ETH": pytest.approx(12.5)}


def test_open_interest_without_spot_is_reported_not_guessed() -> None:
    inv = compute([SeriesState.from_view(view("NEAR-4-C", "NEAR", 4, "Call", ONE))], {})
    assert inv.exposures == [] and inv.missing_spot == ["NEAR"]


def test_rebalance_deadband() -> None:
    assert rebalance(12.5, 12.2, 0.5) == 0.0
    assert rebalance(12.5, 10.0, 0.5) == pytest.approx(2.5)
    assert rebalance(-3.0, 1.0, 0.5) == pytest.approx(-4.0)
