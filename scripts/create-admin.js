// ============================================================
// 관리자 계정 생성 / 비밀번호 재설정
//   사용법 (PowerShell):
//     $env:DATABASE_URL="postgresql://..."; npm run create-admin -- 아이디
//   비밀번호는 화면에서 입력받으며(표시되지 않음) 파일·명령기록에 남지 않는다.
//   같은 아이디가 있으면 비밀번호를 바꾸고 기존 로그인을 모두 무효화한다.
// ============================================================
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) {
    console.error('아이디는 영문 소문자·숫자·_.- 3~40자로 입력하세요. 예) npm run create-admin -- lineco');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 환경변수를 먼저 설정하세요.');
    process.exit(1);
  }

  const pw = await askHidden('새 비밀번호 (12자 이상): ');
  const pw2 = await askHidden('비밀번호 확인: ');
  if (pw.length < 12) { console.error('비밀번호는 12자 이상이어야 합니다.'); process.exit(1); }
  if (pw !== pw2) { console.error('비밀번호가 서로 다릅니다.'); process.exit(1); }

  const hash = await bcrypt.hash(pw, 12);
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query(
    `INSERT INTO public.admin_users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           token_version = public.admin_users.token_version + 1,
           is_active = TRUE
     RETURNING id, (xmax = 0) AS created`,
    [username, hash]
  );
  await client.query('DELETE FROM public.admin_login_attempts WHERE username = $1 AND success = FALSE', [username]);
  await client.end();
  console.log(rows[0].created ? `관리자 계정 생성 완료: ${username}` : `비밀번호 재설정 완료: ${username} (기존 로그인 모두 해제)`);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
