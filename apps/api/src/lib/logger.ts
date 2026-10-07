import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logger. Redaction covers credentials, cookies and any field that
 * might carry row payloads so real source data never reaches log sinks.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'authenq' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.apiKey',
      '*.secret',
      '*.credentials',
      '*.rows',
      '*.data',
      '*.prompt',
    ],
    censor: '[redacted]',
  },
});
