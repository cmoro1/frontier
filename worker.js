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

const AIRTABLE_BASE = 'https://api.airtable.com';
const CONTENT_BASE = 'https://content.airtable.com';

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
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    // The client sends the Airtable path in the X-Airtable-Path header
    // e.g. "/v0/appXXX/Job%20Listings?filterByFormula=..."
    const airtablePath = request.headers.get('X-Airtable-Path');
    if (!airtablePath) {
      return new Response(JSON.stringify({ error: 'Missing X-Airtable-Path header' }), {
        status: 400,
        headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // Determine base URL (content.airtable.com for uploads, api.airtable.com for everything else)
    const isUpload = airtablePath.includes('uploadAttachment');
    const baseUrl = isUpload ? CONTENT_BASE : AIRTABLE_BASE;
    const targetUrl = baseUrl + airtablePath;

    // Build proxied request
    const proxyHeaders = new Headers();
    proxyHeaders.set('Authorization', 'Bearer ' + env.AIRTABLE_API_KEY);

    // Forward Content-Type (important: for multipart/form-data this includes the boundary)
    const contentType = request.headers.get('Content-Type');
    if (contentType) {
      proxyHeaders.set('Content-Type', contentType);
    }

    // For file uploads, also forward Content-Length if present
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && isUpload) {
      proxyHeaders.set('Content-Length', contentLength);
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
};
