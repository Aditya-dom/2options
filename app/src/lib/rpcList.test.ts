import { expect, test } from 'bun:test';
import { DEFAULT_RPCS, rpcList } from './rpcList';

test('with nothing configured the defaults are used, several per network', () => {
  expect(rpcList('', 'testnet')).toEqual([...DEFAULT_RPCS.testnet]);
  expect(DEFAULT_RPCS.testnet.length).toBeGreaterThanOrEqual(4);
  expect(DEFAULT_RPCS.mainnet.length).toBeGreaterThanOrEqual(4);
  for (const url of [...DEFAULT_RPCS.testnet, ...DEFAULT_RPCS.mainnet]) expect(url).toMatch(/^https:\/\/[^/]+/);
});

test('configured endpoints come first, in their order, and the defaults still follow', () => {
  const urls = rpcList(' https://mine.example/ , https://near-testnet.drpc.org', 'testnet');
  expect(urls.slice(0, 2)).toEqual(['https://mine.example', 'https://near-testnet.drpc.org']);
  expect(urls).toContain('https://test.rpc.fastnear.com');
  expect(new Set(urls).size).toBe(urls.length); // each endpoint once
});

test('junk in the setting is ignored', () => {
  expect(rpcList(', ,not-a-url,', 'testnet')).toEqual([...DEFAULT_RPCS.testnet]);
});
