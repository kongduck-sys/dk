// ============================================================
// POST /api/consult — 홈페이지 하단 상담 신청 폼 저장 (공개, 인증 없음)
// 환경변수 DATABASE_URL: Supabase 트랜잭션 풀러(6543) 접속 문자열
// ============================================================
const { query } = require('../lib/db');

const PHONE_RE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;

function validate(body) {
  const name = String(body.name ?? '').trim();
  const phone = String(body.tel ?? body.phone ?? '').trim();
  const content = String(body.contents ?? body.content ?? '').trim();
  const agree = body.agree === true;

  if (!name || name.length > 30) return { error: '이름을 확인해주세요.' };
  if (!PHONE_RE.test(phone)) return { error: '연락처를 정확히 입력해주세요.' };
  if (content.length > 1000) return { error: '상담내용은 1000자 이내로 입력해주세요.' };
  if (!agree) return { error: '개인정보처리방침에 동의해주세요.' };
  return { data: { name, phone, content: content || null } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }

  // 봇 차단용 허니팟: 사람에게 보이지 않는 website 필드가 채워지면 성공인 척 무시
  if (req.body && req.body.website) return res.status(200).json({ ok: true });

  const { error, data } = validate(req.body || {});
  if (error) return res.status(400).json({ ok: false, message: error });

  try {
    const { rows } = await query(
      `INSERT INTO public.consult_requests
         (name, phone, content, privacy_agreed, privacy_agreed_at, user_agent)
       VALUES ($1, $2, $3, TRUE, now(), $4)
       RETURNING id, created_at`,
      [data.name, data.phone, data.content, String(req.headers['user-agent'] || '').slice(0, 300)]
    );
    return res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[consult] insert failed:', e.message);
    return res.status(500).json({ ok: false, message: '일시적인 오류로 접수되지 않았습니다.' });
  }
};
