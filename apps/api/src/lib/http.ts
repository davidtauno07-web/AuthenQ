import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { badRequest } from './errors.js';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(`Some fields need attention: ${fields.map((f) => `${f.path || 'request'} — ${f.message}`).join('; ')}`, { fields });
  }
  return result.data;
}

export interface Page {
  limit: number;
  offset: number;
}

export function pageOf(query: Record<string, unknown>, max = 200): Page {
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), max);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (!v || !/^[0-9a-f-]{36}$/i.test(v)) throw badRequest(`Invalid ${name}`);
  return v;
}
