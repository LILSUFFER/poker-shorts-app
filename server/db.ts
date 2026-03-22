import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

// NEON_DATABASE_URL works from anywhere (RunPod, deployments, external).
// DATABASE_URL is Replit-internal only (dev fallback).
const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString,
  ssl: connectionString?.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export { pool };
