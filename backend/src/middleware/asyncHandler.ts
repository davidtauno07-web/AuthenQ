import type { NextFunction, Request, RequestHandler, Response } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  (handler: Handler): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };
