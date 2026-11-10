import { expect, test } from 'bun:test';
import { refundAddressError } from './oneclick';

test('refund address format checks per chain family', () => {
  expect(refundAddressError('base', '0x2527D02599Ba641c19FEa793cD0F167589a0f10D')).toBeNull();
  expect(refundAddressError('arb', '0x2527')).not.toBeNull();
  expect(refundAddressError('sol', '3rvXxuU5PxBrBLeJuiDtfZVKits6w75CSDKT5RKc1XgZ')).toBeNull();
  expect(refundAddressError('sol', '0x2527D02599Ba641c19FEa793cD0F167589a0f10D')).not.toBeNull();
  expect(refundAddressError('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBeNull();
  expect(refundAddressError('btc', 'not-an-address')).not.toBeNull();
  expect(refundAddressError('eth', '')).not.toBeNull();
});
