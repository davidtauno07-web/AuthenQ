import type { Role } from '@prisma/client';

export interface AuthPrincipal {
  userId: string;
  organizationId: string;
  email: string;
  role: Role;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: AuthPrincipal;
    }
  }
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type JsonObject = Record<string, unknown>;
