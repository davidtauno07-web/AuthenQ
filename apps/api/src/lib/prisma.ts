import { PrismaClient, Prisma } from '@prisma/client';
import '../config/env.js';

export const prisma = new PrismaClient({ log: ['warn', 'error'] });
export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;
export { Prisma };
