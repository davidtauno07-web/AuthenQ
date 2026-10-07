/**
 * Application errors carry a stable machine code, an HTTP status and a
 * plain-language message suitable for end users. Technical detail is kept
 * separately and only returned to administrators.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly actions?: { label: string; href?: string; action?: string }[],
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'Your role does not allow this action. Ask an administrator for access.') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (resource = 'resource') => new AppError(404, 'NOT_FOUND', `The requested ${resource} could not be found.`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const tooMany = (message = 'Too many requests. Please wait a moment and try again.') => new AppError(429, 'RATE_LIMITED', message);
export const gateBlocked = (gate: string, reasons: string[], actions?: AppError['actions']) =>
  new AppError(422, 'GATE_BLOCKED', `The ${gate} gate is blocked: ${reasons.join(' ')}`, { gate, reasons }, actions);
export const securityViolation = (message: string, details?: unknown) => new AppError(422, 'DATA_BOUNDARY_VIOLATION', message, details);
