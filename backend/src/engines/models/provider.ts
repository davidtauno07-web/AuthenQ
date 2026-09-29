export interface ModelInvocationProfile {
  [attribute: string]: unknown;
}

export interface ModelPrediction {
  outcome: string;
  score: number;
  latencyMs: number;
  raw?: Record<string, unknown>;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  version: string;
  endpoint?: string | null;
  authConfig?: Record<string, unknown>;
  demoBehavior?: string | null;
  isDemo: boolean;
}

/**
 * Abstraction over the system under test. Swapping a demo model for a real
 * enterprise endpoint is a provider change only — no engine code changes.
 */
export interface ModelProviderAdapter {
  readonly kind: string;
  predict(descriptor: ModelDescriptor, profile: ModelInvocationProfile): Promise<ModelPrediction>;
  healthCheck(descriptor: ModelDescriptor): Promise<{ healthy: boolean; message: string }>;
}

export const POSITIVE_OUTCOME = 'APPROVED';
export const NEGATIVE_OUTCOME = 'REJECTED';
