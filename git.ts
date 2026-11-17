// git.ts — git smart HTTP, implemented from the protocol itself: pkt-lines,
// packfiles (plain objects; OFS/REF deltas resolve on read), protocol v2 fetch and
// ls-refs, protocol v0 upload-pack and receive-pack with report-status. No git binary,
// no outside service: the object store in store.ts is the only backend.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID, isOid, hashObject, parseCommit, parseTag, parseTree, buildTree,
  collectReachable, peelToCommit,
} from './store.ts';

const PKT_MAX = 65520;

export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush() {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim() {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items) {
  const parts = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode pkt-lines from the front of `buffer`; returns packets and the leftover bytes. */
export function decodePktLines(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------- packfiles

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Deterministic for the same input order. */
export function writePack(objects) {
  const list = [...objects];
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer, start) {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer, start) {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base, delta) {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Parse a packfile. Returns the objects keyed by their recomputed id. OFS_DELTA and
 * REF_DELTA entries resolve against the pack itself, or (a thin pack) against
 * `resolveBase`, which the caller supplies from its own store.
 */
export function readPack(pack, resolveBase) {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    // One info:true call both inflates the stream and reports how many input bytes
    // the zlib stream consumed (engine.bytesWritten), so the next entry starts at
    // the right offset. inflateSync tolerates the trailing bytes of later entries.
    const inflated = inflateSync(buffer.subarray(offset, trailerStart), { info: true });
    const consumed = inflated.engine?.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
    entry.data = inflated.buffer;
    offset = offset + consumed;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map();
  const resolvedByOid = new Map();
  const resolving = new Set();
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type;
    let data;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing from pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase ? resolveBase(entry.baseOid) : undefined;
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} not in pack or store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, count: declaredCount, version };
}

// ---------------------------------------------------------- fetch computation

/** Objects the client already holds: reachable from `haves`, stopping at shallow boundaries. */
function haveClosure(store, haves, shallowList) {
  const shallowSet = new Set(shallowList);
  const held = new Set();
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop();
    if (held.has(oid) || !isOid(oid)) continue;
    held.add(oid);
    if (shallowSet.has(oid)) continue;
    const commit = store.commitOf(peelToCommit(store, oid));
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return held;
}

/** Every object id reachable from `haves`: commits, their trees and blobs, stopping at shallow boundaries. */
function heldObjectSet(store, haves, shallowList) {
  const shallowSet = new Set(shallowList);
  const held = new Set();
  const queue = [...haves];
  const seen = new Set();
  const addTree = (treeOid) => {
    const object = store.getObject(treeOid);
    if (!object || object.type !== 'tree') return;
    if (held.has(treeOid)) return;
    held.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else held.add(entry.oid);
    }
  };
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid) || !isOid(oid)) continue;
    seen.add(oid);
    const object = store.getObject(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      held.add(oid);
      queue.push(peelToCommit(store, oid));
      continue;
    }
    if (object.type !== 'commit') {
      held.add(oid);
      continue;
    }
    held.add(oid);
    addTree(parseCommit(object.data).tree);
    if (shallowSet.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return held;
}

/**
 * The objects a fetch must send, plus the shallow boundary it establishes. `wants` are
 * object ids; `haves` are ids the client holds; `shallowList` is the client's current
 * shallow boundary; `depth` caps generations (undefined = full history).
 */
export function computeFetch(store, repo, request) {
  const wants = [...new Set(request.wants ?? [])].filter(isOid);
  const haves = [...new Set(request.haves ?? [])].filter(isOid);
  const shallowList = [...new Set(request.shallow ?? [])].filter(isOid);
  const depth = request.depth ?? null;
  const held = haveClosure(store, haves, shallowList);
  const heldObjects = heldObjectSet(store, haves, shallowList);
  const includedCommits = new Set();
  const includedTags = new Set();
  const shallow = new Set();
  const walkQueue = [];
  for (const want of wants) {
    const object = store.getObject(want);
    if (!object) continue;
    if (object.type === 'tag') {
      includedTags.add(want);
      const target = peelToCommit(store, want);
      walkQueue.push([target, 0]);
    } else if (object.type === 'commit') {
      walkQueue.push([want, 0]);
    } else {
      includedCommits.add(want);
    }
  }
  const visited = new Set();
  while (walkQueue.length) {
    const [oid, distance] = walkQueue.shift();
    if (visited.has(oid)) continue;
    visited.add(oid);
    // The depth limit is exclusive: depth 1 is the tip alone, depth 2 the tip and
    // its parent. A commit at or beyond the limit is neither sent nor traversed.
    if (depth !== null && distance >= depth) continue;
    const commit = store.commitOf(peelToCommit(store, oid));
    if (!commit) continue;
    const peeled = peelToCommit(store, oid);
    if (!held.has(peeled)) includedCommits.add(peeled);
    for (const parent of commit.parents) walkQueue.push([parent, distance + 1]);
  }
  // The shallow boundary exists only for a depth-limited fetch. A commit is
  // shallow when a parent is not in the pack — even when the client already
  // holds that parent (a new tip fetched at depth 1 is shallow although its
  // parent sits in the client's repo). A full fetch has no boundary: every
  // ancestor is either sent or held, so nothing is shallow.
  if (depth !== null) {
    for (const oid of includedCommits) {
      const commit = store.commitOf(oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        const peeled = peelToCommit(store, parent);
        if (!includedCommits.has(peeled)) {
          shallow.add(oid);
          break;
        }
      }
    }
  }
  // Unshallow: previously shallow commits whose parents are now included or held.
  const unshallow = [];
  for (const oid of shallowList) {
    const commit = store.commitOf(peelToCommit(store, oid));
    if (!commit) continue;
    const parentsKnown = commit.parents.every((p) => {
      const peeled = peelToCommit(store, p);
      return includedCommits.has(peeled) || held.has(peeled);
    });
    if (parentsKnown) unshallow.push(oid);
  }
  // The pack: included commits + tags + every tree/blob they reach (not parents).
  // Anything the client already holds is left out: a tree or blob reachable from
  // a held commit is already on the client, even when a new commit reaches it too.
  const send = new Map();
  const addTreeClosure = (treeOid) => {
    if (heldObjects.has(treeOid)) return;
    const object = store.getObject(treeOid);
    if (!object || object.type !== 'tree') return;
    if (send.has(treeOid)) return;
    send.set(treeOid, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') addTreeClosure(entry.oid);
      else {
        if (heldObjects.has(entry.oid)) continue;
        const blob = store.getObject(entry.oid);
        if (blob && !send.has(entry.oid)) send.set(entry.oid, blob);
      }
    }
  };
  for (const oid of includedTags) {
    if (heldObjects.has(oid)) continue;
    const object = store.getObject(oid);
    if (object) send.set(oid, object);
  }
  for (const oid of includedCommits) {
    const object = store.getObject(oid);
    if (!object) continue;
    send.set(oid, object);
    const commit = parseCommit(object.data);
    addTreeClosure(commit.tree);
  }
  // Deterministic pack order: sort by oid so two runs build identical bytes.
  const ordered = [...send.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const pack = writePack(ordered.map(([, object]) => object));
  return { pack, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
}

/** A cached fetch: identical wants/haves/shallow/depth on one repo reuse one pack. */
export function cachedFetch(store, repo, request) {
  const key = [
    repo.id,
    [...new Set(request.wants ?? [])].sort().join(','),
    [...new Set(request.haves ?? [])].sort().join(','),
    [...new Set(request.shallow ?? [])].sort().join(','),
    request.depth ?? '',
  ].join('|');
  const cached = store.packCache.get(key);
  if (cached) return cached;
  const result = computeFetch(store, repo, request);
  store.packCache.set(key, result);
  return result;
}

// ---------------------------------------------------------- sideband framing

/** Wrap `data` in sideband pkt-lines (band 1), chunked under the pkt-line maximum. */
export function sidebandPackets(data, band = 1) {
  const chunks = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const piece = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    chunks.push(pktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.from([band])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------- advertisements

function sortedRefs(repo) {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function v0Advertisement(store, repo, service) {
  const caps = service === 'git-upload-pack'
    ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag agent=forge/1.0'
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const defaultBranch = repo.defaultBranch;
  const symref = `symref=HEAD:refs/heads/${defaultBranch}`;
  const lines = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} ${symref}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${defaultBranch}`) ?? refs[0][1];
    lines.push(pktLine(`${headOid} HEAD\0${caps} ${symref}\n`));
    for (const [name, oid] of refs) {
      lines.push(pktLine(`${oid} ${name}\n`));
      const object = store.getObject(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(store, oid);
        lines.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function v2Advertisement() {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
    'flush',
  ]);
}

/** The ref list a v2 ls-refs answers, honouring peel/symrefs/unborn/ref-prefix. */
function lsRefsLines(store, repo, options) {
  const lines = [];
  const prefixes = options.prefixes ?? [];
  const keep = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (options.unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    return lines;
  }
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (options.symrefs && keep('HEAD') && headOid) {
    lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (options.peel) {
      const object = store.getObject(oid);
      if (object && object.type === 'tag') line += ` peeled:${peelToCommit(store, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

// ---------------------------------------------------------- the three services

export function handleInfoRefs(store, owner, repoName, service, gitProtocol) {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  let body;
  let contentType;
  if (service === 'git-upload-pack' && gitProtocol === 2) {
    body = v2Advertisement();
    contentType = 'application/x-git-upload-pack-advertisement';
  } else {
    body = v0Advertisement(store, repo, service);
    contentType = `application/x-${service}-advertisement`;
  }
  return { status: 200, contentType, body };
}

function parseV2Request(body) {
  const { packets } = decodePktLines(body);
  const lines = [];
  let command = null;
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!inArgs) {
      const match = /^command=([a-z-]+)\n?$/.exec(text);
      if (match) command = match[1];
      continue;
    }
    lines.push(text);
  }
  return { command, args: lines };
}

function handleLsRefs(store, repo, args) {
  const options = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line === 'peel') options.peel = true;
    else if (line === 'symrefs') options.symrefs = true;
    else if (line === 'unborn') options.unborn = true;
    else if (line.startsWith('ref-prefix ')) options.prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines = lsRefsLines(store, repo, options);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: encodePktLines([...lines, 'flush']) };
}

function handleFetchV2(store, repo, args) {
  const request = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7), 10);
  }
  const fetched = cachedFetch(store, repo, request);
  // A fetch that carries `done` never gets an acknowledgments section: real git
  // servers go straight to shallow-info / packfile, and real git clients die
  // ("expected 'packfile'") if an acknowledgments section shows up first.
  const parts = [];
  if (request.depth !== null || request.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of fetched.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of fetched.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(fetched.pack, 1));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(store, repo, body) {
  const { packets } = decodePktLines(body);
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
  }
  const fetched = cachedFetch(store, repo, { wants, haves, shallow, depth });
  const parts = [pktLine('NAK\n')];
  for (const oid of fetched.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of fetched.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPackets(fetched.pack, 1));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleUploadPack(store, owner, repoName, body, gitProtocol) {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  try {
    if (gitProtocol === 2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') return handleLsRefs(store, repo, args);
      if (command === 'fetch') return handleFetchV2(store, repo, args);
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Unknown command' }) + '\n') };
    }
    return handleFetchV0(store, repo, body);
  } catch (err) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: String(err?.message ?? err) }) + '\n') };
  }
}

export function handleReceivePack(store, owner, repoName, body) {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  const { packets, rest } = decodePktLines(body);
  const commands = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'No commands' }) + '\n') };
  }
  // Unpack the pack (if any): a delete-only push carries none.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    } else {
      try {
        const parsed = readPack(rest, (oid) => store.getObject(oid));
        for (const [oid, object] of parsed.objects) store.putObject(object.type, object.data);
      } catch (err) {
        unpackOk = false;
        unpackDetail = String(err?.message ?? err);
      }
    }
  }
  const reportLines = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) reason = 'non-fast-forward';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
        else {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) reason = 'already exists';
        else if (!store.getObject(command.newOid)) reason = 'missing object';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else {
        // update
        if (current === undefined) reason = 'non-fast-forward';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else if (!store.getObject(command.newOid)) reason = 'missing object';
        else if (!store.isAncestor(command.oldOid, command.newOid)) reason = 'non-fast-forward';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      }
    }
    reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  if (commands.some((c) => c.newOid !== ZERO_OID) || commands.some((c) => c.newOid === ZERO_OID)) {
    repo.updatedAt = store.nowIso();
    repo.pushedAt = repo.updatedAt;
    store.invalidatePackCache();
  }
  const report = encodePktLines(reportLines);
  // The report travels as sideband band 1, closed by one flush (end of the
  // sideband stream), and the response itself by a second flush: real git's
  // receive-pack sends both, and its client dies with "the remote end hung
  // up" when the second one is missing, even though the report parsed fine.
  const bodyOut = Buffer.concat([sidebandPackets(report, 1), pktFlush(), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}
