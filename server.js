/**
 * Searchlight — self-host server (zero dependencies, Node 18+)
 *
 * Serves the static site from /public, proxies AI requests to Google Gemini,
 * and connects to Google Search Console (OAuth) to pull a user's real ranking
 * data and feed it to the AI for an action plan.
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// --- minimal .env loader (no dependency) ---
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT          = process.env.PORT || 3000;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GOOGLE_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SCOPE         = 'openid email https://www.googleapis.com/auth/webmasters.readonly';

// --- in-memory session store (resets if the server restarts) ---
const sessions = new Map(); // sid -> { tokens:{access_token,refresh_token,expiry}, email }

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.woff2':'font/woff2'
};

const json = (res, status, obj) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b=''; req.on('data',c=>{b+=c; if(b.length>1e6)req.destroy();}); req.on('end',()=>r(b)); });
const cookies = req => Object.fromEntries((req.headers.cookie||'').split(';').map(c=>c.trim().split('=').map(decodeURIComponent)).filter(x=>x[0]));
const baseUrl = req => {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
};

// --- Gemini ---
async function callGemini(messages, system) {
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content||'') }] }));
  const payload = { contents, generationConfig: { maxOutputTokens: 3000 } };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Gemini API error');
  return ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
           .map(p => p.text || '').join('').trim();
}

// --- Google OAuth helpers ---
async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({ code, client_id:GOOGLE_ID, client_secret:GOOGLE_SECRET, redirect_uri:redirectUri, grant_type:'authorization_code' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'token exchange failed');
  return d;
}
async function refreshToken(refresh_token) {
  const body = new URLSearchParams({ refresh_token, client_id:GOOGLE_ID, client_secret:GOOGLE_SECRET, grant_type:'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'token refresh failed');
  return d;
}
async function accessTokenFor(sess) {
  if (!sess || !sess.tokens) throw new Error('not connected');
  if (Date.now() < sess.tokens.expiry - 60000) return sess.tokens.access_token;
  const d = await refreshToken(sess.tokens.refresh_token);
  sess.tokens.access_token = d.access_token;
  sess.tokens.expiry = Date.now() + (d.expires_in || 3600) * 1000;
  return sess.tokens.access_token;
}
const gFetch = (url, token, opts={}) => fetch(url, { ...opts, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type':'application/json', ...(opts.headers||{}) } });
const ymd = d => d.toISOString().slice(0,10);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl(req));
  const p = url.pathname;
  const sid = cookies(req).sid;
  const sess = sid ? sessions.get(sid) : null;

  try {
    // ---------- AI chat / manual analysis / competitor ----------
    if (req.method === 'POST' && p === '/api/ai') {
      if (!GEMINI_KEY) return json(res, 500, { error: 'GEMINI_API_KEY is not set on the server.' });
      const { messages, system } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(messages)) return json(res, 400, { error: 'messages[] required' });
      const text = await callGemini(messages, system);
      return json(res, 200, { text: text || '(no response)' });
    }

    // ---------- Google OAuth: start ----------
    if (p === '/auth/google') {
      if (!GOOGLE_ID) { res.writeHead(500); return res.end('GOOGLE_CLIENT_ID not set on the server. See README.'); }
      const redirectUri = baseUrl(req) + '/auth/callback';
      const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: GOOGLE_ID, redirect_uri: redirectUri, response_type: 'code',
        scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true'
      });
      res.writeHead(302, { Location: auth });
      return res.end();
    }

    // ---------- Google OAuth: callback ----------
    if (p === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) { res.writeHead(400); return res.end('Missing code'); }
      const redirectUri = baseUrl(req) + '/auth/callback';
      const tok = await exchangeCode(code, redirectUri);
      let email = '';
      try {
        const ui = await (await gFetch('https://openidconnect.googleapis.com/v1/userinfo', tok.access_token)).json();
        email = ui.email || '';
      } catch {}
      const newSid = crypto.randomBytes(18).toString('hex');
      sessions.set(newSid, {
        tokens: { access_token: tok.access_token, refresh_token: tok.refresh_token, expiry: Date.now() + (tok.expires_in||3600)*1000 },
        email
      });
      res.writeHead(302, {
        'Set-Cookie': `sid=${newSid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${baseUrl(req).startsWith('https')?'; Secure':''}`,
        'Location': '/#app'
      });
      return res.end();
    }

    // ---------- who am I ----------
    if (p === '/api/me') return json(res, 200, { connected: !!(sess && sess.tokens), email: sess ? sess.email : '' });

    // ---------- logout ----------
    if (req.method === 'POST' && p === '/auth/logout') {
      if (sid) sessions.delete(sid);
      res.writeHead(200, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      return res.end('{}');
    }

    // ---------- list verified GSC sites ----------
    if (p === '/api/gsc/sites') {
      const token = await accessTokenFor(sess);
      const d = await (await gFetch('https://www.googleapis.com/webmasters/v3/sites', token)).json();
      const sites = (d.siteEntry || []).filter(s => s.permissionLevel !== 'siteUnverifiedUser').map(s => s.siteUrl);
      return json(res, 200, { sites });
    }

    // ---------- analyze real GSC data with AI ----------
    if (req.method === 'POST' && p === '/api/gsc/analyze') {
      if (!GEMINI_KEY) return json(res, 500, { error: 'GEMINI_API_KEY is not set on the server.' });
      const token = await accessTokenFor(sess);
      const { siteUrl } = JSON.parse((await readBody(req)) || '{}');
      if (!siteUrl) return json(res, 400, { error: 'siteUrl required' });
      const end = new Date(Date.now() - 3*864e5), start = new Date(Date.now() - 31*864e5);
      const enc = encodeURIComponent(siteUrl);
      const q = dims => gFetch(`https://www.googleapis.com/webmasters/v3/sites/${enc}/searchAnalytics/query`, token, {
        method:'POST', body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), dimensions: dims, rowLimit: 25 })
      }).then(r => r.json());
      const [byQuery, byPage] = await Promise.all([ q(['query']), q(['page']) ]);
      const rows = (o) => (o.rows || []).map(r => ({
        k: r.keys[0], clicks: r.clicks, impr: r.impressions, ctr: +(r.ctr*100).toFixed(1), pos: +r.position.toFixed(1)
      }));
      const queries = rows(byQuery), pages = rows(byPage);
      if (!queries.length && !pages.length) return json(res, 200, { text: 'No Search Console data was returned for this property in the last 28 days. If the site is new or low-traffic, there may be nothing to analyze yet.' });

      const summary =
        `Site: ${siteUrl}\nPeriod: ${ymd(start)} to ${ymd(end)} (last 28 days)\n\n` +
        `TOP QUERIES (query | clicks | impressions | CTR% | avg position):\n` +
        queries.map(r => `- ${r.k} | ${r.clicks} | ${r.impr} | ${r.ctr}% | ${r.pos}`).join('\n') +
        `\n\nTOP PAGES (page | clicks | impressions | CTR% | avg position):\n` +
        pages.map(r => `- ${r.k} | ${r.clicks} | ${r.impr} | ${r.ctr}% | ${r.pos}`).join('\n');

      const system = "You are an expert SEO consultant analyzing real Google Search Console data. Be specific and reference the actual queries, pages, and numbers provided. Prioritize by impact. Use short paragraphs and bullets.";
      const prompt = `Here is my real Search Console data:\n\n${summary}\n\nGive me: 1) a one-line diagnosis of the biggest opportunity, 2) "Quick wins this week" (e.g. queries ranking positions 5-15 with high impressions but low CTR — these are striking-distance keywords), 3) "Bigger bets this month", each tagged with effort. Reference specific queries/pages from my data.`;
      const text = await callGemini([{ role:'user', content: prompt }], system);
      return json(res, 200, { text, queries, pages });
    }

    // ---------- static files ----------
    let urlPath = decodeURIComponent(p);
    if (urlPath === '/') urlPath = '/index.html';
    const publicDir = path.join(__dirname, 'public');
    const filePath = path.normalize(path.join(publicDir, urlPath));
    if (!filePath.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(content);
    });
  } catch (e) {
    if (String(e.message).includes('not connected')) return json(res, 401, { error: 'Not connected to Search Console.' });
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Searchlight running →  http://localhost:${PORT}`);
  console.log(`  Gemini:        ${GEMINI_KEY ? '✓ enabled ('+GEMINI_MODEL+')' : '⚠ GEMINI_API_KEY missing'}`);
  console.log(`  Search Console:${GOOGLE_ID && GOOGLE_SECRET ? ' ✓ OAuth configured' : ' ⚠ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing'}\n`);
});
