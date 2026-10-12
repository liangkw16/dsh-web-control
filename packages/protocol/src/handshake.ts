import { integer } from './limits.js';
import { ProtocolError } from './types.js';
export function negotiate(offered: number[], supported: number[]): number {
  for (const versions of [offered, supported]) {
    if (!Array.isArray(versions) || versions.length > 32) throw new ProtocolError('INVALID_MESSAGE');
    for (const version of versions) integer(version, 1, 0xffff);
  }
  const selected = supported.filter(v => offered.includes(v)).sort((a, b) => b - a)[0];
  if (selected === undefined) throw new ProtocolError('PROTOCOL_UNSUPPORTED');
  return selected;
}
