// Gửi lên TikTok các bài trong queue.json đã đến giờ (GitHub Actions gọi mỗi 15 phút).
// queue.json do workflow n8n "Vegan & Animal rights → TikTok" ghi; ảnh nằm ở https://sunnyoziwi.github.io/vegan-legal/p/…
// Mỗi ngôn ngữ tối đa 1 bài / lần chạy; lỗi thì thử lại sau 30 phút, tối đa 3 lần.
// Hộp nháp TikTok đầy (spam_risk_too_many_pending_share, ~5 bài chờ / 24 giờ) → thử lại mỗi 3 giờ, tối đa 5 ngày.
// Bài gửi bù (retry: true, do flow n8n xếp vào khi gửi ngay bị lỗi) → lỗi khác thì thử lại mỗi 3 giờ, tối đa 4 lần.
// Env: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN, TIKTOK_POST_MODE (inbox|direct), TIKTOK_PRIVACY.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { TIKTOK_CLIENT_KEY: CK, TIKTOK_CLIENT_SECRET: CS, TIKTOK_REFRESH_TOKEN: RT } = process.env;
const MODE = (process.env.TIKTOK_POST_MODE || 'inbox').toLowerCase() === 'direct' ? 'DIRECT_POST' : 'MEDIA_UPLOAD';
const PRIVACY = process.env.TIKTOK_PRIVACY || 'SELF_ONLY';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600000;
const INBOX_FULL = /spam_risk|too_many_pending|pending_share/i;
const vnTime = (ms) => new Date(ms + 7 * HOUR).toISOString().slice(0, 16).replace('T', ' ') + ' giờ VN';

if (!CK || !CS || !RT) {
  console.log('Thiếu TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN trong Secrets → bỏ qua.');
  process.exit(0);
}
const queue = existsSync('queue.json') ? JSON.parse(readFileSync('queue.json', 'utf8') || '[]') : [];
const now = Date.now();
const due = ['en', 'vi'].map((lang) => queue.find((q) => q.lang === lang && q.status === 'queued' && q.due <= now)).filter(Boolean);
if (!due.length) {
  console.log('Chưa có bài đến giờ. Đang chờ:', queue.filter((q) => q.status === 'queued').map((q) => q.dueLocal + ' ' + q.folder));
  process.exit(0);
}

const tokRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_key: CK, client_secret: CS, grant_type: 'refresh_token', refresh_token: RT }),
});
const tok = await tokRes.json();
if (!tok.access_token) throw new Error('TikTok refresh token lỗi: ' + JSON.stringify(tok).slice(0, 200));
const tt = async (path, body) => (await fetch('https://open.tiktokapis.com' + path, {
  method: 'POST', headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body),
})).json();

for (const q of due) {
  const post_info = MODE === 'DIRECT_POST'
    ? { title: q.title.slice(0, 90), description: q.captionText.slice(0, 4000), privacy_level: PRIVACY, disable_comment: false, auto_add_music: true }
    : { title: q.title.slice(0, 90), description: q.captionText.slice(0, 4000) };
  const init = await tt('/v2/post/publish/content/init/', { media_type: 'PHOTO', post_mode: MODE, post_info,
    source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: q.photos } });
  let st;
  const pid = init.data && init.data.publish_id;
  if (!pid) st = 'error: ' + JSON.stringify(init.error || init).slice(0, 200);
  else {
    st = 'PROCESSING';
    for (let t = 0; t < 8 && /PROCESSING|DOWNLOAD|UPLOAD/.test(st); t++) {
      await sleep(4000);
      const s = await tt('/v2/post/publish/status/fetch/', { publish_id: pid });
      st = (s.data && s.data.status) || st;
      if (st === 'FAILED') st = 'error: FAILED ' + ((s.data && s.data.fail_reason) || '');
    }
    st = st === 'SEND_TO_USER_INBOX' ? 'inbox (vào hộp nháp TikTok)' : st === 'PUBLISH_COMPLETE' ? 'published' : st;
  }
  q.attempts = (q.attempts || 0) + 1;
  q.queuedAt = q.queuedAt || q.due || now; // mốc tính 5 ngày, không đổi khi dời giờ thử lại
  q.result = st;
  q.sentAt = new Date().toISOString();
  if (!/^error/.test(st)) q.status = 'sent';
  else if (INBOX_FULL.test(st) && now - q.queuedAt < 5 * 24 * HOUR) {
    q.status = 'queued'; q.due = now + 3 * HOUR;
  } else if (q.attempts < (q.retry ? 4 : 3)) {
    q.status = 'queued'; q.due = now + (q.retry ? 3 * HOUR : 30 * 60000);
  } else q.status = 'failed';
  if (q.status === 'queued') q.dueLocal = vnTime(q.due) + ' (thử lại)';
  console.log(q.folder, '→', st);
}
const keep = queue.filter((q) => q.status === 'queued' || q.status === 'pending' || now - (q.due || 0) < 14 * 24 * HOUR);
writeFileSync('queue.json', JSON.stringify(keep, null, 1));
