import { ModelProvider } from '@prisma/client';
import { MockModelProvider } from './mockProvider.js';
import { RestModelProvider } from './restProvider.js';
import type { ModelProviderAdapter } from './provider.js';

const mock = new MockModelProvider();
const rest = new RestModelProvider();

const ADAPTERS: Record<ModelProvider, ModelProviderAdapter> = {
  [ModelProvider.MOCK]: mock,
  [ModelProvider.SANDBOX]: mock,
  [ModelProvider.REST]: rest,
  [ModelProvider.INTERNAL]: rest,
};

export const resolveProvider = (provider: ModelProvider): ModelProviderAdapter =>
  ADAPTERS[provider] ?? mock;

export * from './provider.js';
export { DEMO_BEHAVIORS } from './mockProvider.js';
