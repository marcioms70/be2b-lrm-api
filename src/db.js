import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

export async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (error) {
    console.error("Erro SQL:", {
      message: error.message,
      code: error.code
    });

    throw error;
  }
}
