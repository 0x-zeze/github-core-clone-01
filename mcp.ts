// mcp.ts — the Model Context Protocol surface: JSON-RPC 2.0 over Streamable HTTP
// (plain application/json responses; no SSE needed). Implements the modern
// 2026-07-28 discovery handshake the suite probes, the legacy initialize path as
// a safety net, and eight tools that operate on the same store as REST and
// GraphQL. Tool results carry both a text rendering and structuredContent.

import { repoJson, issueJson, pullJson } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

// Batching bound (audit #4): at most 50 JSON-RPC requests per batched call.
// Single requests are unaffected; the suite never sends batches.
const MAX_BATCH_REQUESTS = 50;

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the head branch.' },
        base: { type: 'string', description: 'The name of the base branch.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function resolveRepo(store, args) {
  let owner = args.owner ?? args.login ?? null;
  let repoName = args.repo ?? args.repository ?? args.repository_name ?? null;
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repoName = repoName ?? parts[1];
    }
  }
  if (!owner || !repoName) return { error: 'owner and repo are required' };
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== store.viewer.login) return { error: 'Repository not found' };
  return { repo };
}

function checkRequired(args, required) {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `Missing required argument: ${key}`;
  }
  return null;
}

function callTool(store, name, args, base) {
  const tool = TOOLS.find((t) => t.name === name)
    ?? TOOLS.find((t) => t.name.toLowerCase().endsWith(name.toLowerCase()));
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = checkRequired(args, tool.inputSchema.required ?? []);
  if (missing) return { result: toolError(missing) };
  const baseUrl = base;

  if (tool.name === 'create_repo') {
    const existing = store.getRepo(store.viewer.login, args.name);
    if (existing) return { result: toolError(`Repository "${args.name}" already exists`) };
    const { repo } = store.createRepo(args.name, {
      description: args.description ?? '',
      private: args.private === true,
    });
    return { result: toolResult(repoJson(repo, baseUrl)) };
  }

  const resolved = resolveRepo(store, args);
  if (resolved.error) return { result: toolError(resolved.error) };
  const repo = resolved.repo;

  if (tool.name === 'get_repo') return { result: toolResult(repoJson(repo, baseUrl)) };

  if (tool.name === 'create_issue') {
    const created = store.createIssue(repo, { title: args.title, body: args.body ?? '', labels: [] });
    if (created.error) return { result: toolError(created.error) };
    return { result: toolResult(issueJson(repo, created.issue, baseUrl)) };
  }

  if (tool.name === 'get_issue') {
    const issue = repo.issues.get(Number(args.issue_number));
    if (!issue) return { result: toolError('Issue not found') };
    return { result: toolResult(issueJson(repo, issue, baseUrl)) };
  }

  if (tool.name === 'list_issues') {
    const issues = store.listIssues(repo, { state: args.state ?? 'open' });
    return { result: toolResult(issues.map((i) => issueJson(repo, i, baseUrl))) };
  }

  if (tool.name === 'create_pull_request') {
    const created = store.createPull(repo, { title: args.title, body: args.body ?? '', head: args.head, base: args.base });
    if (created.error) return { result: toolError(created.error) };
    return { result: toolResult(pullJson(repo, created.pr, baseUrl)) };
  }

  if (tool.name === 'list_pull_requests') {
    const pulls = store.listPulls(repo, args.state ?? 'open');
    return { result: toolResult(pulls.map((p) => pullJson(repo, p, baseUrl))) };
  }

  if (tool.name === 'merge_pull_request') {
    const merged = store.mergePull(repo, Number(args.pull_number));
    if (merged.error) return { result: toolError(merged.error) };
    return { result: toolResult({ sha: merged.mergeSha, merged: true, message: `Pull request #${args.pull_number} merged` }) };
  }

  return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

function rpcResult(id, result) {
  return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) + '\n' };
}

function rpcError(id, code, message, status = 200) {
  return { status, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) + '\n' };
}

function handleOne(store, request, authOk, base) {
  const id = request?.id ?? null;
  const method = request?.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const isNotification = id === null || id === undefined;
  if (method.startsWith('notifications/')) return { status: 202, headers: {}, body: '' };
  if (!authOk) return rpcError(id, -32000, 'Unauthorized', 401);

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: {
        'io.modelcontextprotocol/supportedVersions': SUPPORTED_VERSIONS,
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        'io.modelcontextprotocol/capabilities': { tools: {} },
      },
    });
  }
  if (method === 'initialize') {
    const requested = request.params?.protocolVersion;
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = request.params ?? {};
    const outcome = callTool(store, params.name, params.arguments ?? {}, base);
    if (outcome.rpcError) return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle one MCP request. `ctx` carries the method, raw body text and whether
 * the Bearer token checked out. Parse errors are answered before auth, so a
 * malformed body is a 400/-32700 even without credentials.
 */
export function handleMcp(store, ctx) {
  if (ctx.method === 'DELETE') return { status: 204, headers: {}, body: '' };
  if (ctx.method !== 'POST') return { status: 405, headers: {}, body: JSON.stringify({ message: 'Method not allowed' }) + '\n' };
  let request;
  try {
    request = JSON.parse(ctx.bodyText);
  } catch {
    return { status: 400, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n' };
  }
  if (Array.isArray(request)) {
    if (request.length > MAX_BATCH_REQUESTS) {
      return { status: 400, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Too many requests in batch: at most ${MAX_BATCH_REQUESTS}.` } }) + '\n' };
    }
    const responses = request.map((item) => {
      const one = handleOne(store, item, ctx.authOk, ctx.base);
      return JSON.parse(one.body);
    });
    return { status: 200, headers: {}, body: JSON.stringify(responses) + '\n' };
  }
  return handleOne(store, request, ctx.authOk, ctx.base);
}
