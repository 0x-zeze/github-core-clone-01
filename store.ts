// store.ts — the forge's whole state: git objects, repositories, issues, pull
// requests, labels and comments, all in memory. Nothing here touches the network or
// the clock: commit timestamps come from a logical counter so two runs of the same
// requests build byte-identical objects.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value) {
  return typeof value === 'string' && HEX40.test(value);
}

/** SHA-1 over `<type> <size>\0` + bytes, exactly as git computes an object id. */
export function hashObject(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function parseTree(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a, b) {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeNames);
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  // Git stores commit messages with a trailing newline; the API view trims it.
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8').replace(/\n+$/, '');
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. `timestamp` is a fixed logical second, never Date.now(). */
export function buildCommit(fields) {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? fields.author} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Every object reachable from `roots`: commit -> tree + parents, tag -> target, tree -> entries. */
export function collectReachable(roots, lookup) {
  const seen = new Set();
  const queue = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag object (recursively) to the commit it names. */
export function peelToCommit(store, oid) {
  let current = oid;
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = store.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

function countLines(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function lineDiff(oldText, newText) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  const oldCount = new Map();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  const newCount = new Map();
  for (const line of newLines) newCount.set(line, (newCount.get(line) ?? 0) + 1);
  let deletions = 0;
  for (const line of oldLines) {
    const left = newCount.get(line) ?? 0;
    if (left > 0) newCount.set(line, left - 1);
    else deletions += 1;
  }
  return { additions, deletions };
}

export function globalId(kind, ...parts) {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id) {
  try {
    const text = Buffer.from(String(id), 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

const BASE_EPOCH = 1700000000;

/** The whole forge state. One instance per process; the trial starts it empty. */
export class Store {
  constructor(viewer) {
    this.viewer = viewer;
    this.objects = new Map();
    this.repos = new Map();
    this.repoSeq = 0;
    this.issueIdSeq = 0;
    this.commentIdSeq = 0;
    this.labelIdSeq = 0;
    this.clockSeq = 0;
    this.commitSeq = 0;
    this.treeFlatCache = new Map();
    this.packCache = new Map();
  }

  /** A deterministic ISO timestamp: the logical clock, never the wall clock. */
  nowIso() {
    this.clockSeq += 1;
    return new Date((BASE_EPOCH + this.clockSeq) * 1000).toISOString();
  }

  putObject(type, data) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: body });
    return oid;
  }

  getObject(oid) {
    return this.objects.get(oid);
  }

  invalidatePackCache() {
    this.packCache.clear();
  }

  repoKey(owner, name) {
    return `${owner}/${name}`;
  }

  getRepo(owner, name) {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(name, options = {}) {
    const owner = this.viewer.login;
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return { repo: this.repos.get(key), created: false };
    this.repoSeq += 1;
    const id = this.repoSeq;
    const stamp = this.nowIso();
    const repo = {
      id,
      nodeId: globalId('R', String(id)),
      owner,
      name,
      fullName: key,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: stamp,
      updatedAt: stamp,
      pushedAt: stamp,
      createdSeq: this.repoSeq,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
    };
    this.repos.set(key, repo);
    return { repo, created: true };
  }

  deleteRepo(owner, name) {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos() {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------- git helpers

  commitOf(oid) {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** The commit a ref points at, peeling tags. Null when the ref is absent or not a commit. */
  refCommit(repo, ref) {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    const peeled = peelToCommit(this, oid);
    const commit = this.commitOf(peeled);
    return commit === null ? null : { oid: peeled, commit };
  }

  isAncestor(ancestorOid, descendantOid) {
    if (ancestorOid === descendantOid) return true;
    const seen = new Set();
    const queue = [descendantOid];
    while (queue.length) {
      const oid = queue.pop();
      if (oid === ancestorOid) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(peelToCommit(this, oid));
      if (!commit) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return false;
  }

  mergeBase(aOid, bOid) {
    const aAncestors = new Map();
    const queue = [[peelToCommit(this, aOid), 0]];
    while (queue.length) {
      const [oid, depth] = queue.shift();
      if (aAncestors.has(oid)) continue;
      aAncestors.set(oid, depth);
      const commit = this.commitOf(oid);
      if (!commit) continue;
      for (const parent of commit.parents) queue.push([parent, depth + 1]);
    }
    const bQueue = [[peelToCommit(this, bOid), 0]];
    const bSeen = new Set();
    let best = null;
    let bestDepth = Infinity;
    while (bQueue.length) {
      const [oid, depth] = bQueue.shift();
      if (bSeen.has(oid)) continue;
      bSeen.add(oid);
      const aDepth = aAncestors.get(oid);
      if (aDepth !== undefined && aDepth + depth < bestDepth) {
        best = oid;
        bestDepth = aDepth + depth;
      }
      const commit = this.commitOf(oid);
      if (!commit) continue;
      for (const parent of commit.parents) bQueue.push([parent, depth + 1]);
    }
    return best;
  }

  /** Flatten a tree to path -> {oid, mode}, cached (trees are immutable). */
  flattenTree(treeOid) {
    const cached = this.treeFlatCache.get(treeOid);
    if (cached) return cached;
    const out = new Map();
    const walk = (oid, prefix) => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    this.treeFlatCache.set(treeOid, out);
    return out;
  }

  /** The tree a commit points at, flattened. Empty map for a null tree. */
  treeMapOfCommit(commitOid) {
    if (!commitOid) return new Map();
    const commit = this.commitOf(peelToCommit(this, commitOid));
    if (!commit) return new Map();
    return this.flattenTree(commit.tree);
  }

  /** Diff two trees (null = empty): one entry per changed path. */
  diffTrees(baseTreeOid, headTreeOid) {
    const baseMap = baseTreeOid ? this.flattenTree(baseTreeOid) : new Map();
    const headMap = headTreeOid ? this.flattenTree(headTreeOid) : new Map();
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    const out = [];
    for (const path of [...paths].sort()) {
      const base = baseMap.get(path);
      const head = headMap.get(path);
      if (base && head && base.oid === head.oid) continue;
      let status;
      let additions = 0;
      let deletions = 0;
      if (!base && head) {
        status = 'added';
        const data = this.objects.get(head.oid)?.data;
        additions = data ? countLines(data.toString('utf8')) : 0;
      } else if (base && !head) {
        status = 'removed';
        const data = this.objects.get(base.oid)?.data;
        deletions = data ? countLines(data.toString('utf8')) : 0;
      } else {
        status = 'modified';
        const oldData = this.objects.get(base.oid)?.data?.toString('utf8') ?? '';
        const newData = this.objects.get(head.oid)?.data?.toString('utf8') ?? '';
        const diff = lineDiff(oldData, newData);
        additions = diff.additions;
        deletions = diff.deletions;
        if (additions === 0 && deletions === 0) additions = 1;
      }
      out.push({
        path,
        status,
        oldOid: base?.oid ?? null,
        newOid: head?.oid ?? null,
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  /** Diff two commits' trees. */
  diffCommits(baseCommitOid, headCommitOid) {
    const base = baseCommitOid ? this.commitOf(peelToCommit(this, baseCommitOid)) : null;
    const head = headCommitOid ? this.commitOf(peelToCommit(this, headCommitOid)) : null;
    return this.diffTrees(base?.tree ?? null, head?.tree ?? null);
  }

  /** A new commit object on top of `parents` with `treeOid`. Returns its oid. */
  makeCommit(treeOid, parents, message) {
    this.commitSeq += 1;
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      message: text,
      author: who,
      committer: who,
      timestamp: BASE_EPOCH + this.commitSeq,
    });
    return this.putObject('commit', data);
  }

  /** Set (or replace) one path in a tree, returning the new root tree oid. */
  setPathInTree(treeOid, path, blobOid, mode = '100644') {
    const segments = path.split('/').filter((s) => s !== '');
    const setIn = (currentOid, depth) => {
      const entries = currentOid ? parseTree(this.objects.get(currentOid).data) : [];
      const name = segments[depth];
      const last = depth === segments.length - 1;
      const out = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          out.push(entry);
          continue;
        }
        replaced = true;
        if (last) {
          out.push({ mode, name, oid: blobOid });
        } else if (entry.mode === '40000') {
          const child = setIn(entry.oid, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        } else {
          const child = setIn(null, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (last) out.push({ mode, name, oid: blobOid });
        else {
          const child = setIn(null, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (out.length === 0) return null;
      return this.putObject('tree', buildTree(out));
    };
    const result = setIn(treeOid, 0);
    return result ?? this.putObject('tree', buildTree([]));
  }

  /** Remove one path from a tree, returning the new root tree oid (empty tree when nothing is left). */
  removePathFromTree(treeOid, path) {
    const segments = path.split('/').filter((s) => s !== '');
    const removeFrom = (currentOid, depth) => {
      if (!currentOid) return null;
      const entries = parseTree(this.objects.get(currentOid).data);
      const name = segments[depth];
      const last = depth === segments.length - 1;
      const out = [];
      for (const entry of entries) {
        if (entry.name !== name) {
          out.push(entry);
          continue;
        }
        if (last) continue;
        if (entry.mode === '40000') {
          const child = removeFrom(entry.oid, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (out.length === 0) return null;
      return this.putObject('tree', buildTree(out));
    };
    const result = removeFrom(treeOid, 0);
    return result ?? this.putObject('tree', buildTree([]));
  }
}

// ---------------------------------------------------------- contents (REST file API)

/** Commit `content` at `path` on `branch` (default branch when omitted). */
Store.prototype.commitFile = function commitFile(repo, options) {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip ? this.commitOf(peelToCommit(this, tip))?.tree ?? null : null;
  const blobOid = this.putObject('blob', options.content);
  const newTree = this.setPathInTree(baseTree, options.path, blobOid);
  const commitOid = this.makeCommit(newTree, tip ? [peelToCommit(this, tip)] : [], options.message);
  repo.refs.set(ref, commitOid);
  repo.updatedAt = this.nowIso();
  repo.pushedAt = repo.updatedAt;
  this.invalidatePackCache();
  return { commitSha: commitOid, blobSha: blobOid, branch };
};

/** Commit the removal of `path` on `branch`. Returns null when the file is absent. */
Store.prototype.deleteFile = function deleteFile(repo, options) {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip) return null;
  const commit = this.commitOf(peelToCommit(this, tip));
  if (!commit) return null;
  const flat = this.flattenTree(commit.tree);
  if (!flat.has(options.path)) return null;
  const newTree = this.removePathFromTree(commit.tree, options.path);
  const commitOid = this.makeCommit(newTree, [peelToCommit(this, tip)], options.message);
  repo.refs.set(ref, commitOid);
  repo.updatedAt = this.nowIso();
  this.invalidatePackCache();
  return { commitSha: commitOid, branch };
};

/** Read a file's blob (or a directory's entries) at a ref (branch name or commit oid). */
Store.prototype.readPath = function readPath(repo, path, ref) {
  let tip = null;
  if (ref) {
    const byBranch = repo.refs.get(`refs/heads/${ref}`);
    if (byBranch) tip = byBranch;
    else if (isOid(ref) && this.objects.has(ref)) tip = ref;
    else return { kind: 'missing' };
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (!tip) return { kind: 'missing' };
  const commit = this.commitOf(peelToCommit(this, tip));
  if (!commit) return { kind: 'missing' };
  const flat = this.flattenTree(commit.tree);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') return { kind: 'dir', entries: this.listDir(commit.tree, ''), commitSha: tip };
  const file = flat.get(clean);
  if (file) {
    const object = this.objects.get(file.oid);
    return { kind: 'file', oid: file.oid, mode: file.mode, data: object?.data ?? Buffer.alloc(0), commitSha: tip };
  }
  const entries = this.listDir(commit.tree, clean);
  if (entries.length > 0) return { kind: 'dir', entries, commitSha: tip };
  return { kind: 'missing' };
};

/** The immediate children of `dir` in a tree: files and subdirectories. */
Store.prototype.listDir = function listDir(treeOid, dir) {
  const object = this.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const segments = dir === '' ? [] : dir.split('/');
  let current = treeOid;
  for (const segment of segments) {
    const entry = parseTree(this.objects.get(current).data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return [];
    current = entry.oid;
  }
  const entries = [];
  for (const entry of parseTree(this.objects.get(current).data)) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.mode === '40000') entries.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    else {
      const blob = this.objects.get(entry.oid);
      entries.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return entries;
};

// ---------------------------------------------------------- labels, issues, comments

Store.prototype.createLabel = function createLabel(repo, name, color, description) {
  const existing = repo.labels.get(name);
  if (existing) return { label: existing, created: false };
  this.labelIdSeq += 1;
  const label = {
    id: this.labelIdSeq,
    nodeId: globalId('L', String(repo.id), String(this.labelIdSeq)),
    name,
    color: color ?? 'ededed',
    description: description ?? '',
    url: '',
  };
  repo.labels.set(name, label);
  return { label, created: true };
};

Store.prototype.createIssue = function createIssue(repo, input) {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
  }
  this.issueIdSeq += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const stamp = this.nowIso();
  const issue = {
    id: this.issueIdSeq,
    nodeId: globalId('I', String(repo.id), String(number)),
    number,
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    createdSeq: this.issueIdSeq,
    commentIds: [],
  };
  repo.issues.set(number, issue);
  return { issue };
};

Store.prototype.listIssues = function listIssues(repo, query = {}) {
  let list = [...repo.issues.values()];
  if (query.state && query.state !== 'all') list = list.filter((i) => i.state === query.state);
  if (query.sort === 'created') {
    list.sort((a, b) => (query.direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  } else {
    list.sort((a, b) => b.createdSeq - a.createdSeq);
  }
  return list;
};

Store.prototype.patchIssue = function patchIssue(repo, number, patch) {
  const issue = repo.issues.get(number);
  if (!issue) return null;
  if (patch.title !== undefined) issue.title = patch.title;
  if (patch.body !== undefined) issue.body = patch.body;
  if (patch.state !== undefined && (patch.state === 'open' || patch.state === 'closed')) {
    issue.state = patch.state;
    issue.closedAt = patch.state === 'closed' ? this.nowIso() : null;
  }
  if (patch.labels !== undefined) {
    for (const name of patch.labels) if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
    issue.labels = [...patch.labels];
  }
  issue.updatedAt = this.nowIso();
  return { issue };
};

Store.prototype.createComment = function createComment(repo, number, body) {
  const issue = repo.issues.get(number);
  if (!issue) return null;
  this.commentIdSeq += 1;
  const stamp = this.nowIso();
  const comment = {
    id: this.commentIdSeq,
    nodeId: globalId('C', String(repo.id), String(this.commentIdSeq)),
    issueNumber: number,
    body,
    user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.comments.set(comment.id, comment);
  issue.commentIds.push(comment.id);
  return { comment };
};

Store.prototype.listComments = function listComments(repo, number) {
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return issue.commentIds.map((id) => repo.comments.get(id)).filter(Boolean);
};

// ---------------------------------------------------------- pull requests

Store.prototype.createPull = function createPull(repo, input) {
  const headRef = `refs/heads/${input.head}`;
  const baseRef = `refs/heads/${input.base}`;
  const headTip = repo.refs.get(headRef);
  const baseTip = repo.refs.get(baseRef);
  if (!headTip) return { error: `Head branch "${input.head}" does not exist` };
  if (!baseTip) return { error: `Base branch "${input.base}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head.ref === input.head && existing.base.ref === input.base) {
      return { error: 'A pull request already exists for this head and base', duplicate: true };
    }
  }
  this.issueIdSeq += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const stamp = this.nowIso();
  const pr = {
    id: this.issueIdSeq,
    nodeId: globalId('P', String(repo.id), String(number)),
    number,
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    merged: false,
    head: { ref: input.head, sha: peelToCommit(this, headTip) },
    base: { ref: input.base, sha: peelToCommit(this, baseTip) },
    user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.set(number, pr);
  return { pr };
};

Store.prototype.listPulls = function listPulls(repo, state = 'open') {
  let list = [...repo.pulls.values()];
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => b.number - a.number);
  return list;
};

/** Whether merging `pr` into its base would conflict (three-way, same path changed both ways). */
Store.prototype.pullConflicts = function pullConflicts(repo, pr) {
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  if (!headTip || !baseTip) return false;
  const base = this.mergeBase(headTip, baseTip);
  const headChanges = this.diffCommits(base, headTip);
  const baseChanges = this.diffCommits(base, baseTip);
  const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (!other) continue;
    if (other.newOid !== change.newOid) return true;
  }
  return false;
};

Store.prototype.pullFiles = function pullFiles(repo, pr) {
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  if (!headTip || !baseTip) return [];
  const base = this.mergeBase(headTip, baseTip);
  return this.diffCommits(base, headTip);
};

/** Squash-merge a pull request onto its base branch. */
Store.prototype.mergePull = function mergePull(repo, number) {
  const pr = repo.pulls.get(number);
  if (!pr) return { error: 'not found', status: 404 };
  if (pr.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
  if (this.pullConflicts(repo, pr)) return { error: 'Merge conflict', status: 405 };
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headCommit = this.commitOf(peelToCommit(this, headTip));
  const mergeSha = this.makeCommit(headCommit.tree, [peelToCommit(this, baseTip)], `Merge pull request #${pr.number} from ${repo.owner}/${pr.head.ref}`);
  repo.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = this.nowIso();
  pr.closedAt = pr.mergedAt;
  pr.mergeCommitSha = mergeSha;
  pr.updatedAt = pr.mergedAt;
  repo.updatedAt = pr.mergedAt;
  this.invalidatePackCache();
  return { pr, mergeSha };
};
