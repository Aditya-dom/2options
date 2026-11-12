import { expect, test } from 'bun:test';
import { fillsOf, tradeTxs, type TxDetail, type TxListRow } from './history';

const quote = (series: string, side: 'Buy' | 'Sell', size: string, price: string) =>
  ({ action: 'FUNCTION_CALL', method: 'trade', args: { args_json: { quote: { series, taker: 'alice.testnet', side, size, price, nonce: '1', expiry_ns: '2' }, signature: 'c2ln' } } });

test('only successful transactions with a trade call count', () => {
  const rows: TxListRow[] = [
    { transaction_hash: 'a', block_timestamp: '1', actions: [{ action: 'FUNCTION_CALL', method: 'trade' }], outcomes: { status: true } },
    { transaction_hash: 'b', block_timestamp: '1', actions: [{ action: 'FUNCTION_CALL', method: 'trade' }], outcomes: { status: false } },
    { transaction_hash: 'c', block_timestamp: '1', actions: [{ action: 'FUNCTION_CALL', method: 'withdraw' }], outcomes: { status: true } },
    { transaction_hash: 'd', block_timestamp: '1', actions: [{ action: 'FUNCTION_CALL', method: 'trade' }, { action: 'FUNCTION_CALL', method: 'trade' }], outcomes: { status: true } },
  ];
  expect(tradeTxs(rows).map(r => r.transaction_hash)).toEqual(['a', 'd']);
});

test('a two-leg transaction is two fills, in order, at the quoted size and price', () => {
  const tx: TxDetail = {
    transaction_hash: 'h', block_timestamp: '1794511140235536588', outcomes: { status: true },
    actions: [quote('ETH-2050-C', 'Buy', '1000000', '9770000'), quote('ETH-1950-P', 'Buy', '2500000', '5720000')],
  };
  const fills = fillsOf(tx);
  expect(fills.map(f => [f.leg, f.series, f.side, f.size, f.price])).toEqual([
    [0, 'ETH-2050-C', 'Buy', 1_000_000n, 9_770_000n],
    [1, 'ETH-1950-P', 'Buy', 2_500_000n, 5_720_000n],
  ]);
  expect(fills[0].atMs).toBe(1_794_511_140_235);
});

test('arguments given as base64 or as a JSON string are read too; a failed transaction has no fills', () => {
  const args = { quote: { series: 'ETH-2000-P', side: 'Sell', size: '1000000', price: '16000000' } };
  const b64: TxDetail = { transaction_hash: 'x', block_timestamp: '0', outcomes: { status: true }, actions: [{ action: 'FUNCTION_CALL', method: 'trade', args: { args_base64: btoa(JSON.stringify(args)) } }] };
  const str: TxDetail = { transaction_hash: 'y', block_timestamp: '0', outcomes: { status: true }, actions: [{ action: 'FUNCTION_CALL', method: 'trade', args: { args_json: JSON.stringify(args) } }] };
  expect(fillsOf(b64)[0].series).toBe('ETH-2000-P');
  expect(fillsOf(str)[0].side).toBe('Sell');
  expect(fillsOf({ ...b64, outcomes: { status: false } })).toEqual([]);
});
