/**
 * Emits NEAR transaction encoding vectors from @near-js/transactions, so the Python agent's
 * own encoder (agent/twooptions_agent/near.py) can be checked byte for byte.
 *
 *   cd app && bun scripts/near_tx_vectors.ts > ../agent/tests/fixtures/near_tx_vectors.json
 */
import { PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const seed = new Uint8Array(32).map((_, i) => i + 1);
const pub = ed25519.getPublicKey(seed);
const publicKey = PublicKey.fromString(`ed25519:${base58.encode(pub)}`);
const otherKey = PublicKey.fromString(`ed25519:${base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)))}`);
const blockHash = sha256(new TextEncoder().encode('twooptions block hash'));
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const { functionCall, deployContract, createAccount, transfer, addKey, fullAccessKey } = actionCreators;

const spotArgs = { update: { underlying: 'ETH', price: '211012345678', ts_ns: '1794268800000000000', seq: '1794268800000' }, signature: 'c2ln' };
const cases = [
  {
    name: 'function_call',
    signer_id: 'keeper.testnet', receiver_id: 'twooptions.testnet', nonce: '87654321000001',
    actions: [{ type: 'FunctionCall', method: 'post_spot', args: spotArgs, gas: '30000000000000', deposit: '0' }],
    build: () => [functionCall('post_spot', json(spotArgs), 30_000_000_000_000n, 0n)],
  },
  {
    name: 'function_call_with_deposit',
    signer_id: 'owner.testnet', receiver_id: 'usdc.owner.testnet', nonce: '5',
    actions: [{ type: 'FunctionCall', method: 'ft_transfer_call', args: { receiver_id: 'twooptions.testnet', amount: '1000000000', msg: 'lp' }, gas: '100000000000000', deposit: '1' }],
    build: () => [functionCall('ft_transfer_call', json({ receiver_id: 'twooptions.testnet', amount: '1000000000', msg: 'lp' }), 100_000_000_000_000n, 1n)],
  },
  {
    name: 'create_subaccount_and_deploy',
    signer_id: 'owner.testnet', receiver_id: 'twooptions.owner.testnet', nonce: '18446744073709551615',
    actions: [
      { type: 'CreateAccount' },
      { type: 'Transfer', deposit: '6000000000000000000000000' },
      { type: 'AddFullAccessKey', public_key: otherKey.toString() },
      { type: 'DeployContract', code_hex: '0061736d01000000' },
      { type: 'FunctionCall', method: 'new', args: { owner_id: 'owner.testnet', usdc: 'usdc.owner.testnet', agent_keys: [otherKey.toString()] }, gas: '50000000000000', deposit: '0' },
    ],
    build: () => [
      createAccount(),
      transfer(6_000_000_000_000_000_000_000_000n),
      addKey(otherKey, fullAccessKey()),
      deployContract(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
      functionCall('new', json({ owner_id: 'owner.testnet', usdc: 'usdc.owner.testnet', agent_keys: [otherKey.toString()] }), 50_000_000_000_000n, 0n),
    ],
  },
];

const out = cases.map(({ build, ...c }) => {
  const tx = createTransaction(c.signer_id, publicKey, c.receiver_id, BigInt(c.nonce), build(), blockHash);
  const encoded = encodeTransaction(tx);
  const hash = sha256(encoded);
  const signature = ed25519.sign(hash, seed);
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: signature }) });
  return { ...c, transaction_hex: hex(encoded), hash_b58: base58.encode(hash), signed_hex: hex(signed.encode()) };
});

console.log(JSON.stringify({
  generator: 'app/scripts/near_tx_vectors.ts',
  secret_seed_hex: hex(seed),
  public_key: publicKey.toString(),
  block_hash_hex: hex(blockHash),
  cases: out,
}, null, 2));
