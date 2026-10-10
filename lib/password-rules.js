// ============================================================
// 관리자 비밀번호 규칙 (비밀번호 변경 · 재설정 공용)
// ============================================================
// 너무 흔하거나 추측하기 쉬운 비밀번호
const WEAK = ['1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890', 'password', 'qwerty', 'admin', 'lineco', 'makeline', '00000000', '11111111'];

function checkStrength(pw, username) {
  if (pw.length < 10) return '새 비밀번호는 10자 이상이어야 합니다.';
  if (pw.length > 72) return '새 비밀번호는 72자 이하로 입력하세요.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (kinds < 3) return '영문 대문자·소문자·숫자·특수문자 중 3가지 이상을 섞어 주세요.';
  const low = pw.toLowerCase();
  if (WEAK.some(w => low.includes(w))) return '흔하거나 추측하기 쉬운 단어(1234, admin, makeline 등)는 넣을 수 없습니다.';
  if (username && low.includes(String(username).toLowerCase())) return '아이디가 들어간 비밀번호는 쓸 수 없습니다.';
  if (/(.)\1\1\1/.test(pw)) return '같은 문자를 4번 이상 연달아 쓸 수 없습니다.';
  return null;
}

module.exports = { checkStrength };
