import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { tooMany } from '../lib/errors.js';

/**
 * Fixed-window rate limiter backed by PostgreSQL so limits hold across API
 * instances without requiring Redis. Returns the hit count in the window.
 */
export async function hit(key: string, windowSeconds: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (key, "windowStart", count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets."windowStart" < now() - make_interval(secs => ${windowSeconds}) THEN 1 ELSE rate_limit_buckets.count + 1 END,
      "windowStart" = CASE WHEN rate_limit_buckets."windowStart" < now() - make_interval(secs => ${windowSeconds}) THEN now() ELSE rate_limit_buckets."windowStart" END
    RETURNING count`;
  return Number(rows[0]?.count ?? 1);
}

export function rateLimit(name: string, max: number, windowSeconds: number, keyOf?: (req: Request) => string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const id = keyOf ? keyOf(req) : req.ctx?.userId ?? req.ip ?? 'anon';
      const count = await hit(`${name}:${id}`, windowSeconds);
      if (count > max) return next(tooMany());
      next();
    } catch (err) {
      next(err);
    }
  };
}
