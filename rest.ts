// rest.ts — the REST v3 API: repos, branches, commits, contents, labels, issues
// (+comments) and pull requests. All state lives in the store; this module only
// shapes it into GitHub-flavoured JSON and enforces the protocol rules the suite
// checks (status codes, pagination Link headers, 409 on stale content sha,
// 422 on unknown labels / duplicate pull requests, 405 on conflicted merges).

import { ZERO_OID, isOid, peelToCommit } from './store.ts';

const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };

// ---------------------------------------------------------- serialization

export function repoJson(repo, base) {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function userJson(user) {
  return { login: user.login, id: user.id, type: user.type ?? 'User' };
}

export function issueJson(repo, issue, base) {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name))),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.commentIds.length,
  };
}

export function labelJson(label) {
  if (!label) return null;
  return {
    id: label.id,
    node_id: label.nodeId,
    url: '',
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function commentJson(repo, comment, base) {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo, pr, base) {
  return {
    id: pr.id,
    node_id: pr.nodeId,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(pr.user),
    head: { label: `${repo.owner}:${pr.head.ref}`, ref: pr.head.ref, sha: pr.head.sha },
    base: { label: `${repo.owner}:${pr.base.ref}`, ref: pr.base.ref, sha: pr.base.sha },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
  };
}

function commitJson(store, repo, sha) {
  const commit = store.commitOf(peelToCommit(store, sha));
  if (!commit) return null;
  return {
    sha,
    node_id: '',
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
      committer: { name: commit.committer.name, email: commit.committer.email, date: commit.committer.date },
      message: commit.message,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((p) => ({ sha: p })),
    tree: { sha: commit.tree },
  };
}

// ---------------------------------------------------------- pagination

function paginate(list, query, base, pathname) {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const items = list.slice(start, start + perPage);
  const links = [];
  const urlFor = (p) => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}${pathname}?${params.toString()}`;
  };
  if (start + perPage < list.length) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  const lastPage = Math.max(1, Math.ceil(list.length / perPage));
  links.push(`<${urlFor(lastPage)}>; rel="last"`);
  return { items, link: links.join(', ') };
}

// ---------------------------------------------------------- the router

export function handleRest(store, ctx) {
  const { method, pathname, query, body, base } = ctx;
  const ok = (status, payload, headers = {}) => ({ status, headers, body: JSON.stringify(payload) + '\n' });
  const err = (status, message) => ok(status, { message });
  const notFound = () => err(404, 'Not Found');

  // The viewer owns every repo the suite creates; another owner is a 404, never 403.
  const loadRepo = (owner, name) => {
    const repo = store.getRepo(owner, name);
    if (!repo || repo.owner !== VIEWER.login) return null;
    return repo;
  };

  const segments = pathname.split('/').filter(Boolean);
  // segments[0] === 'api', segments[1] === 'v3'

  // GET /api/v3/
  if (segments.length === 2 && method === 'GET') {
    return ok(200, { current_user_url: `${base}/api/v3/user`, repository_url: `${base}/api/v3/repos/{owner}/{repo}` }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true, ssh_key_fingerprints: {}, ssh_keys: [], hooks: [], git: [], packages: [], github_enterprise: false, api: [] });
  }
  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    return ok(200, { login: VIEWER.login, id: VIEWER.id, node_id: '', type: 'User', name: VIEWER.name, email: VIEWER.email, html_url: `${base}/${VIEWER.login}`, public_repos: store.listRepos(VIEWER.login).length });
  }
  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const name = body?.name;
      if (!name || typeof name !== 'string') return err(422, 'name is required');
      const existing = store.getRepo(VIEWER.login, name);
      if (existing) return err(422, 'Repository already exists');
      const { repo } = store.createRepo(name, { description: body.description ?? '', private: body.private === true });
      return ok(201, repoJson(repo, base));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const page = paginate(repos, query, base, pathname);
      return ok(200, page.items.map((r) => repoJson(r, base)), { Link: page.link });
    }
  }
  // /api/v3/repos/{owner}/{name}[/...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = segments[3];
    const name = segments[4];
    const repo = loadRepo(owner, name);
    const rest = segments.slice(5);

    // GET/PATCH/DELETE /repos/{owner}/{name}
    if (rest.length === 0) {
      if (method === 'GET') return repo ? ok(200, repoJson(repo, base)) : notFound();
      if (method === 'PATCH' && repo) {
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.private === 'boolean') repo.private = body.private;
        if (typeof body?.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
        repo.updatedAt = store.nowIso();
        return ok(200, repoJson(repo, base));
      }
      if (method === 'DELETE' && repo) {
        store.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: '' };
      }
      return notFound();
    }
    if (!repo) return notFound();

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = body?.ref;
      const sha = body?.sha;
      if (!ref || !sha || !isOid(sha) || !store.getObject(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.updatedAt = store.nowIso();
      store.invalidatePackCache();
      return ok(201, { ref, node_id: '', object: { sha, type: 'commit', url: '' } });
    }
    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length >= 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      // ref names may contain slashes; rejoin the tail
      const full = decodeURIComponent(segments.slice(8).join('/'));
      const oid = repo.refs.get(`refs/heads/${full}`);
      if (!oid) return notFound();
      return ok(200, { ref: `refs/heads/${full}`, node_id: '', object: { sha: oid, type: 'commit', url: '' } });
    }
    // GET /repos/{o}/{r}/branches[/{branch}]
    if (rest[0] === 'branches' && method === 'GET') {
      if (rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`), url: '' }, protected: false }));
        return ok(200, branches);
      }
      const branch = decodeURIComponent(segments.slice(6).join('/'));
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return notFound();
      return ok(200, { name: branch, commit: { sha: oid, url: '' }, protected: false });
    }
    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${ref}`);
      if (!tip && isOid(ref) && store.getObject(ref)) tip = ref;
      if (!tip) return ok(200, []);
      const seen = new Set();
      const out = [];
      const queue = [tip];
      while (queue.length) {
        const oid = queue.shift();
        const peeled = peelToCommit(store, oid);
        if (seen.has(peeled)) continue;
        seen.add(peeled);
        const json = commitJson(store, repo, peeled);
        if (!json) continue;
        out.push(json);
        const commit = store.commitOf(peeled);
        for (const parent of commit.parents) queue.push(parent);
      }
      return ok(200, out);
    }
    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const path = decodeURIComponent(segments.slice(6).join('/'));
      if (method === 'GET') {
        const read = store.readPath(repo, path, query.get('ref') ?? undefined);
        if (read.kind === 'missing') return notFound();
        if (read.kind === 'file') {
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: read.data.length,
            name: path.split('/').pop(),
            path,
            content: read.data.toString('base64'),
            sha: read.oid,
            url: `${base}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,
            html_url: `${base}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
          });
        }
        return ok(200, read.entries.map((e) => ({
          type: e.type,
          size: e.size,
          name: e.name,
          path: e.path,
          sha: e.sha,
          url: `${base}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(e.path)}`,
          html_url: `${base}/${owner}/${name}/tree/${repo.defaultBranch}/${e.path}`,
        })));
      }
      if (method === 'PUT') {
        if (typeof body?.content !== 'string' || typeof body?.message !== 'string') return err(422, 'content and message are required');
        const current = store.readPath(repo, path, body.branch ?? undefined);
        const content = Buffer.from(body.content.replace(/\s/g, ''), 'base64');
        if (current.kind === 'file') {
          if (!body.sha) return err(409, 'sha is required to update a file');
          if (body.sha !== current.oid) return err(409, 'sha does not match the current file');
          const result = store.commitFile(repo, { path, content, message: body.message, branch: body.branch });
          return ok(200, {
            content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: result.commitSha },
          });
        }
        const result = store.commitFile(repo, { path, content, message: body.message, branch: body.branch });
        return ok(201, {
          content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha },
        });
      }
      if (method === 'DELETE') {
        const current = store.readPath(repo, path, body?.branch ?? undefined);
        if (current.kind !== 'file') return notFound();
        if (body?.sha && body.sha !== current.oid) return err(409, 'sha does not match the current file');
        const result = store.deleteFile(repo, { path, message: body?.message ?? 'Delete file', branch: body?.branch });
        if (!result) return notFound();
        return ok(200, { commit: { sha: result.commitSha } });
      }
    }
    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      if (!body?.name) return err(422, 'name is required');
      const { label } = store.createLabel(repo, body.name, body.color, body.description);
      return ok(201, labelJson(label));
    }
    // /repos/{o}/{r}/issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!body?.title) return err(422, 'title is required');
          const created = store.createIssue(repo, { title: body.title, body: body.body ?? '', labels: body.labels ?? [] });
          if (created.error) return err(422, created.error);
          return ok(201, issueJson(repo, created.issue, base));
        }
        if (method === 'GET') {
          const issues = store.listIssues(repo, {
            state: query.get('state') ?? 'open',
            sort: query.get('sort') ?? 'created',
            direction: query.get('direction') ?? 'desc',
          });
          const page = paginate(issues, query, base, pathname);
          return ok(200, page.items.map((i) => issueJson(repo, i, base)), { Link: page.link });
        }
      }
      const number = parseInt(rest[1], 10);
      if (Number.isNaN(number)) return notFound();
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (!issue) return notFound();
        if (method === 'GET') return ok(200, issueJson(repo, issue, base));
        if (method === 'PATCH') {
          const patched = store.patchIssue(repo, number, body ?? {});
          if (patched?.error) return err(422, patched.error);
          return ok(200, issueJson(repo, patched.issue, base));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (!issue) return notFound();
        if (method === 'POST') {
          if (!body?.body) return err(422, 'body is required');
          const created = store.createComment(repo, number, body.body);
          return ok(201, commentJson(repo, created.comment, base));
        }
        if (method === 'GET') {
          const comments = store.listComments(repo, number) ?? [];
          return ok(200, comments.map((c) => commentJson(repo, c, base)));
        }
      }
    }
    // /repos/{o}/{r}/pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!body?.title || !body?.head || !body?.base) return err(422, 'title, head and base are required');
          const created = store.createPull(repo, { title: body.title, body: body.body ?? '', head: body.head, base: body.base });
          if (created.error) return err(422, created.error);
          return ok(201, pullJson(repo, created.pr, base));
        }
        if (method === 'GET') {
          const pulls = store.listPulls(repo, query.get('state') ?? 'open');
          const page = paginate(pulls, query, base, pathname);
          return ok(200, page.items.map((p) => pullJson(repo, p, base)), { Link: page.link });
        }
      }
      const number = parseInt(rest[1], 10);
      if (Number.isNaN(number)) return notFound();
      if (rest.length === 2 && method === 'GET') {
        const pr = repo.pulls.get(number);
        if (!pr) return notFound();
        return ok(200, pullJson(repo, pr, base));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pr = repo.pulls.get(number);
        if (!pr) return notFound();
        const files = store.pullFiles(repo, pr);
        return ok(200, files.map((f) => ({
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const merged = store.mergePull(repo, number);
        if (merged.error === 'not found') return notFound();
        if (merged.error) return err(merged.status, merged.error);
        return ok(200, { sha: merged.mergeSha, merged: true, message: `Pull request #${number} merged` });
      }
    }
    return notFound();
  }
  return notFound();
}
