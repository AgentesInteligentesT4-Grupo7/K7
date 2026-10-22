import dns from 'node:dns';
import net from 'node:net';

/** Faixas que uma ferramenta HTTP de perfil nunca pode alcançar (SSRF): rede local, loopback, link-local, multicast. */
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  BLOCKED.addSubnet(address, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    // IPv4 mapeado em IPv6 (::ffff:127.0.0.1) é checado como IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return mapped ? BLOCKED.check(mapped[1]!, 'ipv4') : BLOCKED.check(address, 'ipv6');
  }
  return true;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * `lookup` para `https.request`: resolve o nome e recusa se QUALQUER endereço for interno.
 * Validar na hora da conexão evita que o DNS troque de IP entre a checagem e o acesso (rebinding).
 */
export function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((a) => isBlockedAddress(a.address));
    if (blocked || list.length === 0) {
      const refused = Object.assign(new Error(`${hostname} resolve para endereço interno (${blocked?.address ?? 'nenhum'}): acesso recusado`), { code: 'EBLOCKED' });
      return callback(refused, '');
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}
