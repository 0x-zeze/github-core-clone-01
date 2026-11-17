// app.ts — the forge's HTTP server: one process, one store, four surfaces.
//
//   git smart HTTP  /{owner}/{repo}.git   (upload-pack v2/v0, receive-pack v0)
//   REST v3         /api/v3/*
//   GraphQL         /api/graphql
//   MCP             /mcp
//
// Auth: when MAKEFUN_SHOP_TOKEN is set, the API surfaces require the exact
// Bearer token. Git write access (receive-pack) always does too, and private
// repos are unreadable over git without it; public repos stay openly
// cloneable and /healthz never requires auth. Every reply carries a
// non-empty X-GitHub-Request-Id and a JSON content type (git replies carry
// their own x-git-* types instead).

import { createServer } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestSeq = 0;

function sendRaw(res, status, contentType, body, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'x-github-request-id': `req-${(requestSeq += 1)}`,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJson(res, status, body, extraHeaders = {}) {
  sendRaw(res, status, JSON_TYPE, `${JSON.stringify(body)}\n`, extraHeaders);
}

function authOk(req) {
  if (!SHOP_TOKEN) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body leniently: empty bodies are null, bad JSON is an error. */
function parseJsonBody(buffer) {
  if (!buffer || buffer.length === 0) return { value: null, error: null };
  try {
    return { value: JSON.parse(buffer.toString('utf8')), error: null };
  } catch (err) {
    return { value: null, error: err };
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp() {
  const store = new Store(VIEWER);
  return createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      url = new URL('/', 'http://entry');
    }
    const path = url.pathname;
    const base = `http://${req.headers.host ?? '127.0.0.1'}`;

    try {
      // The env's boot check: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // --- git smart HTTP ---
      // receive-pack mutates refs, so it always needs the Bearer token when
      // one is configured; private repos are not readable over git without
      // it either (info/refs advertises refs, upload-pack serves objects).
      // Public repos stay openly cloneable, as the git protocol expects.
      const gitMatch = GIT_PATH.exec(path);
      if (gitMatch) {
        const [, owner, repoName, service] = gitMatch;
        if (service === 'git-receive-pack' && method === 'POST' && !authOk(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        if ((service === 'info/refs' || service === 'git-upload-pack') && !authOk(req)) {
          const repo = store.getRepo(owner, repoName);
          if (repo && repo.private) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
        }
        if (service === 'info/refs' && method === 'GET') {
          const gitService = url.searchParams.get('service');
          if (gitService !== 'git-upload-pack' && gitService !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'Invalid service' });
            return;
          }
          const protocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
          const result = handleInfoRefs(store, owner, repoName, gitService, protocol);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const protocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
          const result = handleUploadPack(store, owner, repoName, body, protocol);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = handleReceivePack(store, owner, repoName, body);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 405, { message: 'Method not allowed' });
        return;
      }

      // --- MCP (parse first, then auth: a malformed body is 400/-32700) ---
      if (path === '/mcp') {
        const bodyText = (await readBody(req)).toString('utf8');
        const result = handleMcp(store, { method, bodyText, authOk: authOk(req), base });
        sendRaw(res, result.status, result.status === 204 ? 'application/json; charset=utf-8' : JSON_TYPE, result.body, result.headers ?? {});
        return;
      }

      // --- GraphQL ---
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method not allowed' });
          return;
        }
        if (!authOk(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (parsed.error) {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return;
        }
        const result = handleGraphQL(store, parsed.value);
        sendRaw(res, result.status, JSON_TYPE, result.body, result.headers ?? {});
        return;
      }

      // --- REST v3 ---
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authOk(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let body = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (parsed.error) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          body = parsed.value;
        }
        const result = handleRest(store, {
          method,
          pathname: path,
          query: url.searchParams,
          body,
          base,
        });
        sendRaw(res, result.status, JSON_TYPE, result.body, result.headers ?? {});
        return;
      }

      // Everything else: GitHub's JSON 404.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { message: String(err?.message ?? err) });
      else res.end();
    }
  });
}
