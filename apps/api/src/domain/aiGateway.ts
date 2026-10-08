import { assertOutboundUrl } from '../lib/net.js';
import { z } from 'zod';
import { securityViolation } from '../lib/errors.js';

/**
 * Controlled gateway for external AI providers. Every request declares the
 * data class of every payload; anything that is not SYNTHETIC, GUIDELINE or
 * AGGREGATE is rejected before a network call is made. Responses are validated
 * against the project label schema; malformed output is retried once and then
 * routed to human review rather than trusted.
 */
export type DataClass = 'REAL' | 'SYNTHETIC' | 'GUIDELINE' | 'AGGREGATE' | 'METADATA';
const ALLOWED: DataClass[] = ['SYNTHETIC', 'GUIDELINE', 'AGGREGATE'];

export interface AiPart {
  dataClass: DataClass;
  content: string;
}

export interface AiProviderConfig {
  provider: 'OPENAI_COMPATIBLE' | 'ANTHROPIC' | 'SELF_HOSTED';
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface AiLabelResult {
  ok: boolean;
  label: string | null;
  confidence: number;
  rationale: string;
  attempts: number;
  error?: string;
}

export function assertSafeParts(parts: AiPart[]) {
  const bad = parts.filter((p) => !ALLOWED.includes(p.dataClass));
  if (bad.length) {
    throw securityViolation(
      `Blocked: ${bad.length} payload part(s) are classed as ${[...new Set(bad.map((b) => b.dataClass))].join(', ')}. Only synthetic records, guidelines and aggregate statistics may be sent to an external AI provider.`,
    );
  }
}

const responseSchema = z.object({ label: z.string().min(1).max(200), confidence: z.number().min(0).max(1), rationale: z.string().max(2000) });

export function parseLabelResponse(raw: string, labels: string[]): { label: string; confidence: number; rationale: string } {
  const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!jsonText) throw new Error('Response did not contain a JSON object');
  const parsed = responseSchema.parse(JSON.parse(jsonText));
  if (!labels.includes(parsed.label)) throw new Error(`Label "${parsed.label}" is not in the project label schema`);
  return parsed;
}

export type Transport = (cfg: AiProviderConfig, system: string, user: string) => Promise<string>;

export const httpTransport: Transport = async (cfg, system, user) => {
  if (!cfg.apiKey && cfg.provider !== 'SELF_HOSTED') throw new Error('No API key configured for this provider');
  if (cfg.baseUrl) await assertOutboundUrl(cfg.baseUrl, 'AI provider URLs');
  if (cfg.provider === 'ANTHROPIC') {
    const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 400, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
    const body = (await res.json()) as { content?: { text?: string }[] };
    return body.content?.map((c) => c.text ?? '').join('') ?? '';
  }
  const res = await fetch(`${cfg.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
};

export async function labelWithAi(
  cfg: AiProviderConfig,
  parts: { guideline: AiPart; examples: AiPart[]; record: AiPart },
  labels: string[],
  transport: Transport = httpTransport,
): Promise<AiLabelResult> {
  assertSafeParts([parts.guideline, ...parts.examples, parts.record]);
  const system = `You label synthetic records for a dataset. Allowed labels: ${labels.join(', ')}. Reply only with JSON {"label": string, "confidence": number 0-1, "rationale": string}. Guidelines:\n${parts.guideline.content.slice(0, 8000)}`;
  const user = `Examples:\n${parts.examples.map((e) => e.content).join('\n').slice(0, 6000)}\n\nRecord:\n${parts.record.content.slice(0, 4000)}`;
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await transport(cfg, system, user);
      if (raw.length > 8000) throw new Error('Response exceeded the maximum length');
      const out = parseLabelResponse(raw, labels);
      return { ok: true, ...out, attempts: attempt };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { ok: false, label: null, confidence: 0, rationale: `Routed to human review: ${lastError}`, attempts: 2, error: lastError };
}
