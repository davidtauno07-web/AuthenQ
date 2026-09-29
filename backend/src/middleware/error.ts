import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/errors.js';

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
};

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  console.error('[authenq] unhandled error:', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
};
