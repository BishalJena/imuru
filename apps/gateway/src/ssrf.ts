import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Addresses an admin-entered upstream must never reach: loopback, private,
// link-local (includes cloud metadata 169.254.169.254), CGNAT, multicast,
// and their IPv6 equivalents (incl. AWS IMDSv6 fd00:ec2::254 via ULA).
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  // Prefixes that embed an IPv4 address: NAT64 and 6to4.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 6 && addr.toLowerCase().startsWith("::ffff:")) {
    return isBlockedAddress(addr.slice(7));
  }
  return family === 4
    ? blocked.check(addr, "ipv4")
    : family === 6
      ? blocked.check(addr, "ipv6")
      : true;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Validates upstream URLs entered through the admin API. Hosts in the
 * allowlist (from Helm values) bypass the address checks, which is how the
 * in-cluster demo servers are registered on purpose.
 */
export class UrlGuard {
  private readonly allow: Set<string>;

  constructor(
    allowedHosts: string[],
    private readonly resolve: Resolver = defaultResolver,
  ) {
    this.allow = new Set(allowedHosts.map((h) => h.toLowerCase()));
  }

  /** Returns a reason the URL is not allowed, or null. */
  async check(raw: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return "Not a valid URL";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "Only http and https URLs are allowed";
    if (url.username || url.password)
      return "Credentials in the URL are not allowed; use the credential field";
    // A trailing dot is the same name in DNS; strip it before matching.
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (this.allow.has(host)) return null;
    if (!host.includes(".") && isIP(host) === 0)
      return "Single-label hostnames resolve inside the cluster and are not allowed";
    if (/\.(svc|cluster\.local|internal|local|localhost)$/.test(host) || host === "localhost") {
      return "Cluster-internal hostnames are not allowed";
    }
    let addrs: string[];
    try {
      addrs = isIP(host) ? [host] : await this.resolve(host);
    } catch {
      return "Hostname does not resolve";
    }
    if (addrs.length === 0) return "Hostname does not resolve";
    if (addrs.some(isBlockedAddress))
      return "URL resolves to a private, loopback or metadata address";
    return null;
  }

  /**
   * fetch that re-validates the host on every request. A hostname can resolve
   * to a public address when the server is added and to an internal one later
   * (DNS rebinding); checking per request narrows that window to the gap
   * between this lookup and the connection.
   */
  fetch(): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const reason = await this.check(url);
      if (reason) throw new Error(`blocked by SSRF guard: ${reason}`);
      return fetch(input, init);
    };
  }
}
