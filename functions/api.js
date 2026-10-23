// Ускоритель формы ALFA TICKET (Cloudflare Pages Function, адрес /api).
// GET  /api?a=init&code=...  — данные формы: отдаём из кэша Cloudflare мгновенно,
//                              свежую копию из Apps Script подтягиваем в фоне.
// POST /api                  — заявка: передаём в Apps Script как есть, ответ возвращаем форме.
// Бот, таблица и проверка подписи Telegram остаются в Apps Script.

// Ссылка на веб-приложение Apps Script (та же, что в Script Properties → WEBAPP_URL).
const APPS = 'https://script.google.com/macros/s/AKfycbztPBIRM3R96jkPyA6xnqB-kjd1JlDWtlkoBNNqpz1hURqv5yhWVS220LvdsXmmyln1WA/exec';

const FRESH_SEC = 600;          // через 10 минут кэш обновляется в фоне
const KEEP_SEC = 7 * 24 * 3600; // сколько хранить копию на случай, если Google не отвечает
const WARM_SEC = 240;           // как часто «будить» Apps Script, чтобы отправка шла быстрее

export async function onRequest(ctx) {
  const m = ctx.request.method;
  if (m === 'GET') return handleGet(ctx);
  if (m === 'POST') return handlePost(ctx);
  if (m === 'OPTIONS') return new Response(null, { status: 204 });
  return json({ ok: false, error: 'method' }, 405);
}

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

// Запрос в Apps Script. Ответ обязан быть JSON, иначе считаем ошибкой (Google иногда отдаёт HTML-страницу).
async function apps(url, init) {
  const r = await fetch(url, { ...init, redirect: 'follow' });
  const t = await r.text();
  JSON.parse(t);
  return t;
}

function cacheOk() { return typeof caches !== 'undefined' && caches.default; }

async function handleGet(ctx) {
  const url = new URL(ctx.request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (url.searchParams.get('a') !== 'init' || !code) {
    try { return json(await apps(APPS + url.search)); } catch (e) { return json({ ok: false, error: 'server' }, 502); }
  }
  const src = APPS + '?a=init&code=' + encodeURIComponent(code);
  if (!cacheOk()) {
    try { return json(await apps(src)); } catch (e) { return json({ ok: false, error: 'server' }, 502); }
  }
  const cache = caches.default;
  const key = new Request('https://alfa-cache.internal/init/' + encodeURIComponent(code));

  const refresh = async () => {
    const t = await apps(src);
    const j = JSON.parse(t);
    if (j.ok) {
      await cache.put(key, new Response(t, {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + KEEP_SEC, 'x-at': String(Date.now()) },
      }));
    } else {
      await cache.delete(key); // клиент отключён или код неверный — не держим старую копию
    }
    return t;
  };

  const hit = await cache.match(key);
  if (hit) {
    const age = (Date.now() - Number(hit.headers.get('x-at') || 0)) / 1000;
    if (age > FRESH_SEC) ctx.waitUntil(refresh().catch(() => {}));
    else warm(ctx);
    return json(await hit.text(), 200, { 'x-cache': 'HIT' });
  }
  try { return json(await refresh(), 200, { 'x-cache': 'MISS' }); }
  catch (e) { return json({ ok: false, error: 'server' }, 502); }
}

// Пока клиент заполняет форму, будим Apps Script, чтобы заявка потом отправилась быстрее.
function warm(ctx) {
  if (!cacheOk()) return;
  const k = new Request('https://alfa-cache.internal/warm');
  ctx.waitUntil((async () => {
    if (await caches.default.match(k)) return;
    await caches.default.put(k, new Response('1', { headers: { 'cache-control': 'public, max-age=' + WARM_SEC } }));
    try { await fetch(APPS + '?a=ping', { redirect: 'follow' }); } catch (e) {}
  })());
}

async function handlePost(ctx) {
  const body = await ctx.request.text();
  // Без повторов: повтор мог бы создать заявку дважды.
  try {
    return json(await apps(APPS, { method: 'POST', body, headers: { 'content-type': 'text/plain;charset=utf-8' } }));
  } catch (e) {
    return json({ ok: false, error: 'server' }, 502);
  }
}
