import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env, isProduction } from '../config/env.js';
import { badRequest } from './errors.js';

/** True for loopback, private, link-local, CGNAT, unique-local, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(v) === 6) return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
  return false;
}

export type OutboundKind = 'Webhook URLs' | 'Connector hosts' | 'AI provider URLs';
type Resolver = (host: string) => Promise<string[]>;
const dnsResolve: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function allowlist() {
  return env.OUTBOUND_PRIVATE_ALLOWLIST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Private targets are blocked in production unless OUTBOUND_BLOCK_PRIVATE says otherwise. */
export function blocksPrivateTargets() {
  return env.OUTBOUND_BLOCK_PRIVATE ?? isProduction;
}

/**
 * Rejects outbound targets that resolve to internal addresses (SSRF protection).
 * Every resolved address is checked, so a public name pointing at a private IP is rejected too.
 */
export async function assertOutboundHost(hostname: string, kind: OutboundKind, opts: { block?: boolean; resolve?: Resolver } = {}) {
  if (!(opts.block ?? blocksPrivateTargets())) return;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw badRequest(`${kind} need a host name.`);
  if (allowlist().includes(host)) return;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await (opts.resolve ?? dnsResolve)(host);
    } catch {
      throw badRequest(`${kind}: the host "${host}" could not be resolved.`);
    }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) {
    throw badRequest(`${kind} cannot point to a private, loopback or link-local address ("${host}"). An administrator can allow specific internal hosts with OUTBOUND_PRIVATE_ALLOWLIST.`);
  }
}

export async function assertOutboundUrl(url: string, kind: OutboundKind, opts: { block?: boolean; resolve?: Resolver } = {}) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('Enter a valid URL.');
  }
  await assertOutboundHost(u.hostname, kind, opts);
}
