/**
 * Searchlight — self-host server (zero dependencies, Node 18+)
 * Serves the static site from /public and proxies AI requests to the
 * Google Gemini API (free tier) using a key kept safely on the server.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

// --- minimal .env loader (no dependency) ---
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file — that's fine, use real env vars */ }

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.woff2':'font/woff2'
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // ---- AI proxy (Google Gemini) ----
  if (req.method === 'POST' && req.url === '/api/ai') {
    if (!API_KEY) return sendJSON(res, 500, { error: 'GEMINI_API_KEY is not set on the server. See README.' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { messages, system } = JSON.parse(body || '{}');
        if (!Array.isArray(messages)) return sendJSON(res, 400, { error: 'messages[] required' });

        // Map chat history to Gemini's format (assistant -> model)
        const contents = messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(m.content || '') }]
        }));
        const payload = { contents, generationConfig: { maxOutputTokens: 1024 } };
        if (system) payload.systemInstruction = { parts: [{ text: system }] };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(API_KEY)}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (!r.ok) return sendJSON(res, r.status, { error: (data.error && data.error.message) || 'Gemini API error' });

        const text = ((data.candidates && data.candidates[0] && data.candidates[0].content
                        && data.candidates[0].content.parts) || [])
                        .map(p => p.text || '').join('').trim();
        if (!text) return sendJSON(res, 502, { error: 'The model returned no text (it may have been rate-limited or filtered). Try again.' });
        sendJSON(res, 200, { text });
      } catch (e) {
        sendJSON(res, 500, { error: String(e && e.message || e) });
      }
    });
    return;
  }

  // ---- static files from /public (path-traversal safe) ----
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const publicDir = path.join(__dirname, 'public');
  const filePath = path.normalize(path.join(publicDir, urlPath));
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Searchlight running →  http://localhost:${PORT}`);
  if (!API_KEY) console.log('  ⚠  GEMINI_API_KEY not set — AI features will be disabled until you add it.\n');
  else console.log(`  ✓  Gemini key loaded (model: ${MODEL}) — AI features enabled.\n`);
});
