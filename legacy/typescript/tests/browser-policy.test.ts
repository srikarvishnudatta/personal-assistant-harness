import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserService, isPublicBrowserAddress, validateBrowserUrl, assertPublicBrowserUrl } from '../src/local/browser.ts';

test('browser policy permits ordinary public HTTP(S) destinations', () => {
  assert.equal(validateBrowserUrl('https://example.com/path?q=hello').hostname, 'example.com');
  assert.equal(validateBrowserUrl('http://8.8.8.8').hostname, '8.8.8.8');
  assert.equal(validateBrowserUrl('https://[2606:4700:4700::1111]').protocol, 'https:');
});

test('browser policy rejects local names, metadata, loopback and obfuscated private addresses', () => {
  const denied = ['http://localhost', 'http://localhost.', 'http://a.localhost', 'http://server', 'http://printer.local',
    'http://service.internal', 'http://home.lan', 'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001',
    'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'http://169.254.169.254/latest/meta-data',
    'http://100.100.100.200', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fc00::1]', 'http://[fe80::1]'];
  for (const url of denied) assert.throws(() => validateBrowserUrl(url), Error, url);
});

test('browser policy rejects credentials, non-web schemes and reserved networks', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com',
    'https://user:password@example.com', 'http://0.0.0.0', 'http://224.0.0.1', 'http://198.18.0.1',
    'http://192.0.2.1', 'http://198.51.100.1', 'http://203.0.113.1', 'https://[2001:db8::1]', 'https://[2001:0db8::1]',
    'https://[2001:20::1]', 'https://[2002:7f00:1::1]'])
    assert.throws(() => validateBrowserUrl(url), Error, url);
});

test('IPv4 and IPv6 classification rejects non-IP input', () => {
  assert.equal(isPublicBrowserAddress('example.com'), false);
  assert.equal(isPublicBrowserAddress('8.8.8.8'), true);
  assert.equal(isPublicBrowserAddress('172.32.1.1'), true);
  assert.equal(isPublicBrowserAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicBrowserAddress('::'), false);
  assert.equal(isPublicBrowserAddress('ff02::1'), false);
});

test('browser profile cannot point at an everyday Chrome or Edge profile', () => {
  assert.throws(() => new BrowserService({ profileDir: 'C:/Users/person/AppData/Local/Google/Chrome/User Data' }));
  assert.throws(() => new BrowserService({ profileDir: '/home/person/.config/chromium/Default' }));
  assert.doesNotThrow(() => new BrowserService({ profileDir: '.assistant/browser-profile' }));
});

test('DNS failures remain blocked with actionable diagnostics and never bypass private-address validation', async () => {
  await assert.rejects(assertPublicBrowserUrl('https://example.com', async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); }), /DNS validation failed.*ENOTFOUND.*doctor:network/);
  await assert.rejects(assertPublicBrowserUrl('https://example.com', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]), /private or reserved/);
  await assert.rejects(assertPublicBrowserUrl('https://example.com', async () => []), /private or reserved/);
  assert.equal((await assertPublicBrowserUrl('https://example.com', async () => [{ address: '8.8.8.8' }])).hostname, 'example.com');
});
