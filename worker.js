// Cloudflare Worker — Airtable API Proxy for Mila Ventures
// Keeps the Airtable API key server-side so it's never exposed in client code.
//
// SETUP:
// 1. Create a free Cloudflare account at https://dash.cloudflare.com
// 2. Go to Workers & Pages → Create → Create Worker
// 3. Paste this code and deploy
// 4. Go to Settings → Variables and Secrets → Add
//    - Name: AIRTABLE_API_KEY
//    - Value: your Airtable personal access token
//    - Click "Encrypt"
// 5. Note your worker URL (e.g. https://mila-proxy.YOUR-SUBDOMAIN.workers.dev)

const AIRTABLE_API_BASE = 'https://api.airtable.com';
const AIRTABLE_CONTENT_BASE = 'https://content.airtable.com';

// Only allow requests from your own site
const ALLOWED_ORIGINS = [
  'https://buildanaistartup.com',
  'https://www.buildanaistartup.com',
  'https://cmoro1.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'null' // for local file:// testing
];

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o)) || origin === 'null';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Airtable-Path, X-Airtable-Content-Path',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    // ─── AIRTABLE CONTENT API PROXY: /content-proxy ───
    // For uploading attachments via content.airtable.com
    // Client sends the path in X-Airtable-Content-Path header
    if (url.pathname === '/content-proxy') {
      const contentPath = request.headers.get('X-Airtable-Content-Path');
      if (!contentPath) {
        return new Response(JSON.stringify({ error: 'Missing X-Airtable-Content-Path header' }), {
          status: 400,
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      }

      const targetUrl = AIRTABLE_CONTENT_BASE + contentPath;

      const proxyHeaders = new Headers();
      proxyHeaders.set('Authorization', 'Bearer ' + env.AIRTABLE_API_KEY);
      proxyHeaders.set('Content-Type', 'application/json');

      const proxyInit = {
        method: request.method,
        headers: proxyHeaders,
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        proxyInit.body = request.body;
      }

      try {
        const response = await fetch(targetUrl, proxyInit);
        const responseHeaders = new Headers(getCorsHeaders(request));
        responseHeaders.set('Content-Type', response.headers.get('Content-Type') || 'application/json');

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Content proxy error: ' + err.message }), {
          status: 502,
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      }
    }

    // ─── AIRTABLE API PROXY: /proxy ───
    // The client sends the Airtable path in the X-Airtable-Path header
    if (url.pathname === '/proxy') {
      const airtablePath = request.headers.get('X-Airtable-Path');
      if (!airtablePath) {
        return new Response(JSON.stringify({ error: 'Missing X-Airtable-Path header' }), {
          status: 400,
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      }

      const targetUrl = AIRTABLE_API_BASE + airtablePath;

      const proxyHeaders = new Headers();
      proxyHeaders.set('Authorization', 'Bearer ' + env.AIRTABLE_API_KEY);

      const contentType = request.headers.get('Content-Type');
      if (contentType) {
        proxyHeaders.set('Content-Type', contentType);
      }

      const proxyInit = {
        method: request.method,
        headers: proxyHeaders,
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        proxyInit.body = request.body;
      }

      try {
        const response = await fetch(targetUrl, proxyInit);
        const responseHeaders = new Headers(getCorsHeaders(request));
        responseHeaders.set('Content-Type', response.headers.get('Content-Type') || 'application/json');

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
          status: 502,
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      }
    }

    // ─── Fallback ───
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
