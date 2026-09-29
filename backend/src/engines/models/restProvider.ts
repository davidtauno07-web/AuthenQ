import {
  NEGATIVE_OUTCOME,
  POSITIVE_OUTCOME,
  type ModelDescriptor,
  type ModelInvocationProfile,
  type ModelPrediction,
  type ModelProviderAdapter,
} from './provider.js';

interface RestAuthConfig {
  type?: 'none' | 'bearer' | 'api_key' | 'basic';
  /** Name of the environment variable holding the credential. */
  credentialEnvVar?: string;
  headerName?: string;
  timeoutMs?: number;
  positiveOutcome?: string;
  scoreField?: string;
  outcomeField?: string;
}

/**
 * Adapter for models exposed over HTTP. Credentials are never stored in the
 * database: the model record only names the environment variable that holds
 * them, and the value is read at invocation time.
 */
export class RestModelProvider implements ModelProviderAdapter {
  readonly kind = 'REST';

  async predict(
    descriptor: ModelDescriptor,
    profile: ModelInvocationProfile,
  ): Promise<ModelPrediction> {
    if (!descriptor.endpoint) {
      throw new Error(`Model "${descriptor.name}" has no endpoint configured`);
    }
    const config = (descriptor.authConfig ?? {}) as RestAuthConfig;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);

    try {
      const response = await fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...buildAuthHeaders(config) },
        body: JSON.stringify({ features: profile, modelVersion: descriptor.version }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Model endpoint responded with ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      const score = Number(body[config.scoreField ?? 'score'] ?? 0);
      const rawOutcome = body[config.outcomeField ?? 'outcome'];
      const outcome =
        typeof rawOutcome === 'string'
          ? rawOutcome
          : score >= 0.5
            ? POSITIVE_OUTCOME
            : NEGATIVE_OUTCOME;
      return { outcome, score, latencyMs: Date.now() - started, raw: body };
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(descriptor: ModelDescriptor) {
    if (!descriptor.endpoint) return { healthy: false, message: 'No endpoint configured' };
    try {
      const response = await fetch(descriptor.endpoint, { method: 'OPTIONS' });
      return {
        healthy: response.ok,
        message: `Endpoint responded with ${response.status}`,
      };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : 'Unreachable' };
    }
  }
}

const buildAuthHeaders = (config: RestAuthConfig): Record<string, string> => {
  if (!config.type || config.type === 'none' || !config.credentialEnvVar) return {};
  const credential = process.env[config.credentialEnvVar];
  if (!credential) {
    throw new Error(
      `Credential environment variable "${config.credentialEnvVar}" is not set on the API host`,
    );
  }
  switch (config.type) {
    case 'bearer':
      return { authorization: `Bearer ${credential}` };
    case 'basic':
      return { authorization: `Basic ${Buffer.from(credential).toString('base64')}` };
    case 'api_key':
      return { [config.headerName ?? 'x-api-key']: credential };
    default:
      return {};
  }
};
