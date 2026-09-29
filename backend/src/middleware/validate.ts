import type { Request } from 'express';
import type { z, ZodTypeAny } from 'zod';

export const parseBody = <S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> =>
  schema.parse(req.body) as z.infer<S>;

export const parseQuery = <S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> =>
  schema.parse(req.query) as z.infer<S>;

export const parseParams = <S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> =>
  schema.parse(req.params) as z.infer<S>;
