import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('flags IPv4-mapped loopback written as hex groups (WHATWG URL canonical form)', () => {
    // `new URL('https://[::ffff:127.0.0.1]/x').hostname` normalizes to
    // `[::ffff:7f00:1]`, not the dotted form — this must be caught too.
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('::ffff:0808:0808')).toBe(false); // 8.8.8.8
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects an IPv4-mapped loopback given as a literal bracketed IPv6 host', async () => {
    // Regression test: the WHATWG URL parser rewrites this to
    // `[::ffff:7f00:1]` before we ever see it, and the previous guard
    // only recognized the dotted-decimal mapped form — this exact URL
    // was reachable/deliverable before the ssrf.ts fix.
    expect(await isDeliverableUrl('https://[::ffff:127.0.0.1]/hook')).toBe(false);
  });

  it('rejects alternative IPv4 notations (decimal, hex, octal, shorthand)', async () => {
    // The WHATWG URL parser itself canonicalizes all of these to
    // dotted-decimal before `.hostname` is read, so they hit the same
    // literal-IP branch as `127.0.0.1` — asserted here so a future
    // change to that assumption doesn't silently reopen the bypass.
    expect(await isDeliverableUrl('https://2130706433/hook')).toBe(false); // decimal
    expect(await isDeliverableUrl('https://0x7f000001/hook')).toBe(false); // hex
    expect(await isDeliverableUrl('https://0177.0.0.1/hook')).toBe(false); // octal
    expect(await isDeliverableUrl('https://127.1/hook')).toBe(false); // shorthand
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});
