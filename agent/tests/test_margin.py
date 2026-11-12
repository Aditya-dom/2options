"""Margin parity with the contract (fixture from contracts/twooptions/examples/margin_vectors.rs)."""

import json
from pathlib import Path

from twooptions_agent import margin
from twooptions_agent.wire import Underlying

FIXTURE = json.loads(
    (
        Path(__file__).parents[2] / "app" / "src" / "lib" / "fixtures" / "margin_vectors.json"
    ).read_text()
)


def test_fixture_is_non_trivial() -> None:
    assert len(FIXTURE["cases"]) > 100
    assert any(leg["size"].startswith("-") for c in FIXTURE["cases"] for leg in c["legs"])


def test_per_leg_band_marks_and_value() -> None:
    for c in FIXTURE["cases"]:
        p = margin.MarginParams.from_json(c["params"])
        for j in c["legs"]:
            spot = int(c["spots"][j["underlying"]])
            call = j["kind"] == "Call"
            strike, last = int(j["strike"]), int(j["last_mark"])
            assert margin.intrinsic(call, spot, strike) == int(j["intrinsic"])
            assert margin.price_band(call, spot, strike, p) == (
                int(j["band_lo"]),
                int(j["band_hi"]),
            )
            assert margin.liability_mark(call, spot, strike, last, p) == int(j["liability_mark"])
            leg = margin.Leg(Underlying[j["underlying"]], call, strike, int(j["size"]), last)
            assert margin.leg_value(leg, spot, p) == int(j["leg_value"])


def test_portfolio_requirement() -> None:
    for c in FIXTURE["cases"]:
        p = margin.MarginParams.from_json(c["params"])
        spots = {Underlying[u]: int(v) for u, v in c["spots"].items()}
        legs = [
            margin.Leg(
                Underlying[j["underlying"]], j["kind"] == "Call", int(j["strike"]), int(j["size"])
            )
            for j in c["legs"]
        ]
        assert margin.requirement(legs, spots, p) == int(c["requirement"])


def test_rounding_matches_rust() -> None:
    for r in FIXTURE["rounding"]:
        a, b, d = int(r["a"]), int(r["b"]), int(r["d"])
        assert margin.mul_div_floor(a, b, d) == int(r["floor"])
        assert margin.mul_div_ceil(a, b, d) == int(r["ceil"])
        assert margin.shock(abs(a), int(r["bps"])) == int(r["shock"])
