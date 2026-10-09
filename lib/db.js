// ============================================================
// 공용 DB 커넥션 풀 (Supabase 트랜잭션 풀러, 서버리스용)
// ============================================================
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    // 로컬 테스트용 Postgres(localhost)는 SSL 없이 접속
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 1, // 서버리스: 인스턴스당 커넥션 1개
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

const query = (text, params) => getPool().query(text, params);

module.exports = { getPool, query };
