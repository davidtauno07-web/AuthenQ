import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This API endpoint does not exist.' } });
}

/** Converts errors into plain-language responses; stack traces are never returned. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const isAdmin = req.ctx?.roleKey === 'ADMIN';
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, actions: err.actions, requestId: req.requestId },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The request was not valid.', details: err.issues } });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string; code?: string };
  if (e?.type === 'entity.too.large' || e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The upload is larger than the allowed size for this endpoint.' } });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' } });
    return;
  }
  logger.error({ err, requestId: req.requestId, path: req.path }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'AuthenQ could not complete this request because of an unexpected server problem. The error has been recorded.',
      requestId: req.requestId,
      details: isAdmin ? { hint: e?.message?.slice(0, 300) } : undefined,
    },
  });
}
