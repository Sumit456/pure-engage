import { loadConfig } from './config.js';
import { createTokenProvider } from './token.js';
import { createPureNetClient } from './client.js';

export { loadConfig, createTokenProvider, createPureNetClient };
export { PureNetError } from './errors.js';
export { sign, verify } from './signature.js';
export { memberToAttributes, eventToTrack, canSend, MEMBER_ID_SYSTEM } from './mapping.js';
export { createReceiver, createSeenSet } from './receiver.js';

// Wires config → token provider → client.
export function createPureNetFromEnv(env = process.env, { fetch = globalThis.fetch } = {}) {
  const config = loadConfig(env);
  const tokens = createTokenProvider({ ...config, fetch });
  return { config, client: createPureNetClient({ ...config, tokens, fetch }) };
}
