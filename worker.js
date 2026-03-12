// Cloudflare Worker — Airtable API Proxy + File Upload for Mila Ventures
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
// 5. Go to Workers & Pages → KV → Create a namespace called "FILE_STORE"
// 6. Go back to your Worker → Settings → Bindings → Add → KV Namespace
//    - Variable name: FILE_STORE
//    - KV namespace: FILE_STORE (the one you just created)
// 7. Note your worker URL (e.g. https://mila-proxy.YOUR-SUBDOMAIN.workers.dev)

const AIRTABLE_BASE = 'https://api.airtable.com';

// Only allow requests from your own site
const ALLOWED_ORIGINS = [
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Airtable-Path',
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

    // ─── FILE UPLOAD: POST /upload ───
    // Accepts a file via FormData, stores in KV, returns a public URL
    if (url.pathname === '/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) {
          return new Response(JSON.stringify({ error: 'No file provided' }), {
            status: 400,
            headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
          });
        }

        const id = crypto.randomUUID();
        const arrayBuffer = await file.arrayBuffer();

        // Store in KV with 1-hour expiration (plenty of time for Airtable to fetch)
        await env.FILE_STORE.put(id, arrayBuffer, {
          expirationTtl: 3600,
          metadata: { contentType: file.type || 'application/octet-stream', filename: file.name }
        });

        const fileUrl = url.origin + '/files/' + id;
        return new Response(JSON.stringify({ url: fileUrl, filename: file.name }), {
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Upload failed: ' + err.message }), {
          status: 500,
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      }
    }

    // ─── FILE SERVE: GET /files/:id ───
    // Serves a previously uploaded file from KV (Airtable fetches from this URL)
    if (url.pathname.startsWith('/files/') && request.method === 'GET') {
      const id = url.pathname.slice('/files/'.length);
      const { value, metadata } = await env.FILE_STORE.getWithMetadata(id, { type: 'arrayBuffer' });

      if (!value) {
        return new Response('File not found or expired', { status: 404 });
      }

      return new Response(value, {
        headers: {
          'Content-Type': metadata?.contentType || 'application/octet-stream',
          'Content-Disposition': 'inline; filename="' + (metadata?.filename || 'file') + '"',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // ─── AIRTABLE PROXY: /proxy ───
    // The client sends the Airtable path in the X-Airtable-Path header
    if (url.pathname === '/proxy') {
      const airtablePath = request.headers.get('X-Airtable-Path');
      if (!airtablePath) {
        return new Response(JSON.stringify({ error: 'Missing X-Airtable-Path header' }), {
          status: 400,
          headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
        });
      }

      const targetUrl = AIRTABLE_BASE + airtablePath;

      // Build proxied request
      const proxyHeaders = new Headers();
      proxyHeaders.set('Authorization', 'Bearer ' + env.AIRTABLE_API_KEY);

      // Forward Content-Type
      const contentType = request.headers.get('Content-Type');
      if (contentType) {
        proxyHeaders.set('Content-Type', contentType);
      }

      const proxyInit = {
        method: request.method,
        headers: proxyHeaders,
      };

      // Forward body for non-GET requests
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
