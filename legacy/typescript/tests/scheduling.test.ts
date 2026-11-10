import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCronTime, nextIntervalTime } from '../src/local/scheduling.ts';

test('timezone cron keeps a Toronto morning at local 09:00 across spring daylight-saving change', async () => {
  assert.equal(new Date(await nextCronTime('0 9 * * *', 'America/Toronto', new Date('2027-03-13T15:00:00Z'))).toISOString(), '2027-03-14T13:00:00.000Z');
  assert.equal(new Date(await nextCronTime('0 9 * * *', 'America/Toronto', new Date('2027-03-12T15:00:00Z'))).toISOString(), '2027-03-13T14:00:00.000Z');
});
test('fixed intervals coalesce missed ticks and invalid timezone/cron is rejected', async () => {
  assert.equal(nextIntervalTime(1000, 60, 181000), 241000);
  await assert.rejects(nextCronTime('99 * * * *', 'UTC'), /range/);
  await assert.rejects(nextCronTime('0 9 * * *', 'Imaginary/Nowhere'));
});
