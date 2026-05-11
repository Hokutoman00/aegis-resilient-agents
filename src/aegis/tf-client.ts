// TrueFoundry-fronted OpenAI client. The OpenAI SDK is pointed at TF's gateway,
// which proxies requests to the underlying provider (Anthropic/OpenAI/Google/etc.)
// and applies L1 retry / L2 model fallback / L3 provider fallback per the
// Virtual Model configuration.
//
// L3 SPOF bypass (direct provider call) is not implemented here yet — landing
// in a subsequent commit. See AGENTS.md for the implementation order.

import OpenAI from 'openai';
import { getEnv } from '../config.js';

let cachedClient: OpenAI | null = null;

export function getTFClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  cachedClient = new OpenAI({
    apiKey: env.TRUEFOUNDRY_API_KEY,
    baseURL: env.TRUEFOUNDRY_OPENAI_BASE,
    // TF expects bearer auth on the API key, which OpenAI SDK does by default.
  });
  return cachedClient;
}

export function getDefaultVirtualModel(): string {
  return getEnv().TRUEFOUNDRY_VIRTUAL_MODEL;
}
