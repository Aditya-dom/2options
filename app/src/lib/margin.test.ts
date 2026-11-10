import { describe, expect, test } from 'bun:test';
import vectors from './fixtures/margin_vectors.json';
import {
  intrinsic, legValue, liabilityMark, mulDivCeil, mulDivFloor, priceBand, requirement, shock,
  type Kind, type MarginParams, type Underlying,
} from './margin';

// Fixture produced by contracts/perennia/examples/margin_vectors.rs from the contract's own code.
type Case = (typeof vectors.cases)[number];

const params = (c: Case): MarginParams => ({
  min_time_value_bps: BigInt(c.params.min_time_value_bps),
  max_time_value_bps: BigInt(c.params.max_time_value_bps),
  tv_reserve_bps: BigInt(c.params.tv_reserve_bps),
  min_margin_per_contract: BigInt(c.params.min_margin_per_contract),
});

describe('margin parity with contracts/perennia', () => {
  test('fixture is non-trivial', () => {
    expect(vectors.cases.length).toBeGreaterThan(100);
    expect(vectors.cases.some(c => c.legs.some(l => l.size.startsWith('-')))).toBe(true);
  });

  test('per-leg band, intrinsic, liability mark and value', () => {
    for (const c of vectors.cases) {
      const p = params(c);
      for (const l of c.legs) {
        const spot = BigInt(c.spots[l.underlying as Underlying]);
        const kind = l.kind as Kind;
        const strike = BigInt(l.strike);
        const lastMark = BigInt(l.last_mark);
        expect(intrinsic(kind, spot, strike).toString()).toBe(l.intrinsic);
        const [lo, hi] = priceBand(kind, spot, strike, p);
        expect([lo.toString(), hi.toString()]).toEqual([l.band_lo, l.band_hi]);
        expect(liabilityMark(kind, spot, strike, lastMark, p).toString()).toBe(l.liability_mark);
        expect(legValue(kind, spot, strike, lastMark, BigInt(l.size), p).toString()).toBe(l.leg_value);
      }
    }
  });

  test('portfolio requirement', () => {
    for (const c of vectors.cases) {
      const legs = c.legs.map(l => ({
        underlying: l.underlying as Underlying,
        kind: l.kind as Kind,
        strike: BigInt(l.strike),
        size: BigInt(l.size),
      }));
      const spotOf = (u: Underlying) => BigInt(c.spots[u]);
      expect(requirement(legs, spotOf, params(c)).toString()).toBe(c.requirement);
    }
  });

  test('floor/ceil division and shocks round like Rust', () => {
    for (const r of vectors.rounding) {
      const [a, b, d] = [BigInt(r.a), BigInt(r.b), BigInt(r.d)];
      expect(mulDivFloor(a, b, d).toString()).toBe(r.floor);
      expect(mulDivCeil(a, b, d).toString()).toBe(r.ceil);
      expect(shock(a < 0n ? -a : a, BigInt(r.bps)).toString()).toBe(r.shock);
    }
  });
});
