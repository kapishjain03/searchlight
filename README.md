# Searchlight — Self-Hosted SEO Copilot

A single-page SEO app with a landing page, an AI chat, AI-powered SEO and competitor analysis, and four browser-only SEO tools. The AI features run through a tiny Node server that keeps your API key safe on the server side. It uses **Google Gemini's free tier**, so there's no prepaid credit and no credit card required.

## What's inside

```
searchlight/
├─ public/
│  └─ index.html      # the whole front-end (page + app + tools)
├─ server.js          # zero-dependency Node server + Gemini proxy
├─ package.json
├─ render.yaml        # one-step config for Render
├─ .env.example       # copy to .env and add your key
└─ .gitignore
```

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`; no `npm install` needed).
- A free Google Gemini API key — get one at https://aistudio.google.com/apikey (no credit card).

## Run it locally

1. Add your key:
   ```bash
   cp .env.example .env
   # open .env and paste your real key into GEMINI_API_KEY
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open http://localhost:3000

That's it. There are no dependencies to install.

## How it works

- The four **Free Tools** (SERP preview, meta checker, keyword density, readability) run entirely in the browser — they never touch the server or any API.
- The **AI Chat**, **SEO Analysis**, and **Competitor Analysis** tabs send a request to `/api/ai` on your own server. The server adds your Gemini key and forwards the call to Google, so the key is never exposed to visitors.

## Get a free Gemini key

1. Go to https://aistudio.google.com/apikey and sign in with a Google account.
2. Click **Create API key**. No billing or credit card is needed.
3. Copy the key into your `.env` file (or your host's environment variables).

Free-tier notes: it's genuinely free with generous daily limits, but Google may use free-tier prompts to improve their models — so don't send confidential data. If you ever need higher limits or data privacy, you can enable billing on the Google Cloud project.

## Deploy to Render

1. Put this folder in a GitHub repo.
2. On Render: **New +** → **Web Service** → pick the repo. The included `render.yaml` fills in the settings (Node, `npm install`, `node server.js`).
3. In the service's **Environment** section, add `GEMINI_API_KEY` with your key. Do **not** set `PORT` — Render provides it.
4. Click **Create Web Service**. You'll get a live URL when the build finishes.

## Customize

Everything visual lives in `public/index.html`:

- Brand name and logo: search for `Searchlight` and the `◎` mark.
- Colors: the `--indigo` and `--coral` CSS variables near the top.
- Testimonials, client logos, and FAQ: the `testimonials`, `companies`, and `faqs` arrays in the `<script>` block.
- The assistant's behavior: the `SEO_SYSTEM` string in the same script.
- The model: set `GEMINI_MODEL` (e.g. `gemini-2.5-flash-lite` for higher rate limits).
