// WEESTWARM — сервер заявок для Railway.
// Принимает заказ с сайта (GitHub Pages) и пересылает его в Telegram.
// Зависимостей нет, нужен Node.js 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';            // задаётся в Railway → Variables
const CHAT_ID = process.env.CHAT_ID || '1222770105';      // ваш Telegram ID
const TG_API = process.env.TG_API || 'https://api.telegram.org';
// Можно ограничить, с каких сайтов принимаются заявки: адреса через запятую,
// например https://weestwarm.ru. Если пусто — заявки принимаются с любого сайта.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const rate = new Map(); // ip -> время последней заявки

function originAllowed(origin) {
  if (!origin || EXTRA_ORIGINS.length === 0) return true;
  try {
    const h = new URL(origin).hostname;
    return h.endsWith('.github.io') || h.endsWith('.up.railway.app') || h === 'localhost' || h === '127.0.0.1'
      || EXTRA_ORIGINS.includes(origin);
  } catch { return false; }
}

function send(res, code, obj, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin && originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

const esc = v => String(v ?? '').trim().replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const rub = n => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';

function buildMessage(o) {
  const c = o.customer || {}, d = o.delivery || {};
  const items = (o.items || []).slice(0, 50).map(i => {
    const q = Math.max(1, parseInt(i.qty, 10) || 1);
    return `• ${esc(i.name)} (${esc(i.level)}) × ${q} = ${rub((i.price || 0) * q)}`;
  });

  let address, method;
  if (d.method === 'pickup') {
    method = 'Пункт выдачи';
    address = `${esc(d.city)}, ${esc(d.pvz)}`;
  } else {
    method = 'Курьер до двери';
    const p = [esc(d.city), esc(d.street), 'д. ' + esc(d.house)];
    if (d.flat) p.push('кв. ' + esc(d.flat));
    if (d.entrance) p.push('подъезд ' + esc(d.entrance));
    if (d.floor) p.push('этаж ' + esc(d.floor));
    if (d.intercom) p.push('домофон ' + esc(d.intercom));
    address = p.join(', ');
    if (d.date) {
      const [y, m, dd] = String(d.date).split('-');
      method += `, ${esc(dd)}.${esc(m)}.${esc(y)} ${esc(d.slot)}`;
    }
  }
  const pay = o.payment === 'cod' ? 'При получении' : 'Онлайн (карта / СБП)';

  let t = `🛒 <b>Новый заказ #${parseInt(o.id, 10) || ''}</b>\n\n`;
  t += `👤 <b>Имя:</b> ${esc(c.name)}\n`;
  t += `📞 <b>Телефон:</b> ${esc(c.phone)}\n`;
  t += `✉️ <b>Почта:</b> ${c.email ? esc(c.email) : '—'}\n\n`;
  t += `📦 <b>Что купил:</b>\n${items.join('\n')}\n\n`;
  if (o.promo) t += `🏷 Промокод: ${esc(o.promo)} (−${rub(o.discount)})\n`;
  t += `🚚 Доставка: ${Number(o.shipping) ? rub(o.shipping) : 'бесплатно'}\n`;
  t += `💰 <b>Итого: ${rub(o.total)}</b>\n`;
  t += `💳 Оплата: ${pay}\n\n`;
  t += `📍 <b>Адрес доставки:</b> ${address}\n`;
  t += `🚛 <b>Способ:</b> ${method}\n`;
  if (d.comment) t += `💬 <b>Комментарий:</b> ${esc(d.comment)}\n`;
  return t;
}

async function handleOrder(req, res, origin) {
  if (!originAllowed(origin)) return send(res, 403, { ok: false, error: 'Forbidden origin' }, origin);
  if (!BOT_TOKEN) return send(res, 500, { ok: false, error: 'BOT_TOKEN не задан в Railway → Variables' }, origin);

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 50000) return send(res, 413, { ok: false, error: 'Too large' }, origin);
  }
  let o;
  try { o = JSON.parse(body); } catch { return send(res, 400, { ok: false, error: 'Bad JSON' }, origin); }

  // Антиспам: скрытое поле
  if (o.website) return send(res, 200, { ok: true, id: o.id }, origin);

  // Не чаще 1 заявки в 20 секунд с одного IP
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  if (rate.has(ip) && now - rate.get(ip) < 20000) return send(res, 429, { ok: false, error: 'Слишком часто, подождите немного' }, origin);
  rate.set(ip, now);
  if (rate.size > 5000) rate.clear();

  const c = o.customer || {};
  if (String(c.name || '').trim().length < 2 || String(c.phone || '').replace(/\D/g, '').length < 11)
    return send(res, 422, { ok: false, error: 'Нужны имя и телефон' }, origin);
  if (!Array.isArray(o.items) || !o.items.length)
    return send(res, 422, { ok: false, error: 'Корзина пустая' }, origin);

  try {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: buildMessage(o), parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) {
      console.error('Telegram error:', j);
      return send(res, 502, { ok: false, error: 'Telegram: ' + (j.description || r.status) }, origin);
    }
    console.log('Order sent', o.id);
    return send(res, 200, { ok: true, id: o.id }, origin);
  } catch (e) {
    console.error(e);
    return send(res, 502, { ok: false, error: 'Нет связи с Telegram' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') {
    const h = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
    if (origin && originAllowed(origin)) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
    res.writeHead(204, h);
    return res.end();
  }

  if (url.pathname === '/api/order' && req.method === 'POST') return handleOrder(req, res, origin);

  if (url.pathname === '/health') return send(res, 200, { ok: true, bot: !!BOT_TOKEN });

  // Сервер сам тоже показывает лендинг (index.html из той же папки)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const file = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find(f => fs.existsSync(f));
    if (file) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 200, { ok: true, service: 'WEESTWARM orders' });
  }

  send(res, 404, { ok: false, error: 'Not found' }, origin);
});

server.listen(PORT, () => console.log(`WEESTWARM orders server on port ${PORT}`));
