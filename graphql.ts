// graphql.ts — a small, self-contained GraphQL executor for the shapes gh and
// github-mcp-server send: viewer/repository/node queries, issue and pull-request
// connections with cursor pagination, the five mutations the suite uses, and the
// __type introspection it probes. No external GraphQL library; the parser,
// validator and resolvers below are written for this forge only.

import { parseGlobalId } from './store.ts';

// ---------------------------------------------------------- schema tables

const FIELD_MAP = {
  Query: ['viewer', 'repository', 'node', '__schema', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'user', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'closedAt', 'mergeCommitSha', 'user'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  ChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  ChangedFileEdge: ['node', 'cursor'],
  ChangedFile: ['path', 'status', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueComment: ['id', 'body', 'user', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
};

const CHILD_TYPE = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Query.__schema': '__Schema',
  'Query.__type': '__Type',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'IssueConnection.nodes': 'Issue',
  'IssueConnection.edges': 'IssueEdge',
  'IssueConnection.pageInfo': 'PageInfo',
  'IssueEdge.node': 'Issue',
  'PullRequestConnection.nodes': 'PullRequest',
  'PullRequestConnection.edges': 'PullRequestEdge',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestEdge.node': 'PullRequest',
  'PullRequest.files': 'ChangedFileConnection',
  'ChangedFileConnection.nodes': 'ChangedFile',
  'ChangedFileConnection.edges': 'ChangedFileEdge',
  'ChangedFileConnection.pageInfo': 'PageInfo',
  'ChangedFileEdge.node': 'ChangedFile',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'IssueCommentEdge',
  'IssueCommentEdge.node': 'IssueComment',
  'Issue.user': 'User',
  'PullRequest.user': 'User',
  'IssueComment.user': 'User',
  '__Type.fields': '__Field',
  '__Type.enumValues': '__EnumValue',
  '__Field.args': '__InputValue',
  '__Field.type': '__Type',
  '__InputValue.type': '__Type',
  '__Schema.queryType': '__Type',
  '__Schema.mutationType': '__Type',
  '__Schema.types': '__Type',
};

const SCHEMA_TYPES = {
  Query: { kind: 'OBJECT' },
  Mutation: { kind: 'OBJECT' },
  User: { kind: 'OBJECT' },
  Repository: { kind: 'OBJECT' },
  Issue: { kind: 'OBJECT' },
  PullRequest: { kind: 'OBJECT' },
  IssueConnection: { kind: 'OBJECT' },
  PullRequestConnection: { kind: 'OBJECT' },
  IssueEdge: { kind: 'OBJECT' },
  PullRequestEdge: { kind: 'OBJECT' },
  ChangedFileConnection: { kind: 'OBJECT' },
  ChangedFileEdge: { kind: 'OBJECT' },
  ChangedFile: { kind: 'OBJECT' },
  PageInfo: { kind: 'OBJECT' },
  Ref: { kind: 'OBJECT' },
  IssueComment: { kind: 'OBJECT' },
  IssueCommentEdge: { kind: 'OBJECT' },
  CreateIssuePayload: { kind: 'OBJECT' },
  CloseIssuePayload: { kind: 'OBJECT' },
  CreatePullRequestPayload: { kind: 'OBJECT' },
  MergePullRequestPayload: { kind: 'OBJECT' },
  AddCommentPayload: { kind: 'OBJECT' },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// ---------------------------------------------------------- lexer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s|,/.test(c)) { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: end === -1 ? source.slice(i + 3) : source.slice(i + 3, end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'EOF' });
  return tokens;
}

// ---------------------------------------------------------- parser

function parseDocument(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (kind) => {
    const token = next();
    if (token.kind !== kind) throw new Error(`Expected ${kind} but got ${token.kind}`);
    return token;
  };
  const expectName = (value) => {
    const token = next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) throw new Error(`Expected name ${value ?? ''} but got ${token.kind} ${token.value ?? ''}`);
    return token.value;
  };

  function parseType() {
    if (peek().kind === '[') {
      next();
      const inner = parseType();
      expect(']');
      let type = `[${inner}]`;
      if (peek().kind === '!') { next(); type += '!'; }
      return type;
    }
    const name = expectName();
    let type = name;
    if (peek().kind === '!') { next(); type += '!'; }
    return type;
  }

  function parseValue() {
    const token = next();
    if (token.kind === '$') return { kind: 'variable', name: expectName() };
    if (token.kind === 'int') return { kind: 'literal', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'literal', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === '[') {
      const values = [];
      while (peek().kind !== ']') values.push(parseValue());
      expect(']');
      return { kind: 'list', value: values };
    }
    if (token.kind === '{') {
      const fields = {};
      while (peek().kind !== '}') {
        const name = expectName();
        expect(':');
        fields[name] = parseValue();
      }
      expect('}');
      return { kind: 'object', value: fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected token ${token.kind} in value`);
  }

  function parseArguments() {
    const args = {};
    expect('(');
    while (peek().kind !== ')') {
      const name = expectName();
      expect(':');
      args[name] = parseValue();
    }
    expect(')');
    return args;
  }

  function skipDirectives() {
    while (peek().kind === '@') {
      next();
      expectName();
      if (peek().kind === '(') parseArguments();
    }
  }

  function parseSelectionSet() {
    expect('{');
    const selections = [];
    while (peek().kind !== '}') {
      if (peek().kind === '...') {
        next();
        if (peek().kind === 'name' && peek().value === 'on') {
          next();
          const typeCondition = expectName();
          skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: parseSelectionSet() });
        } else {
          const name = expectName();
          skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      const first = expectName();
      let alias = null;
      let name = first;
      if (peek().kind === ':') {
        next();
        alias = first;
        name = expectName();
      }
      let args = {};
      if (peek().kind === '(') args = parseArguments();
      skipDirectives();
      let selectionSet = null;
      if (peek().kind === '{') selectionSet = parseSelectionSet();
      selections.push({ kind: 'field', name, alias, arguments: args, selectionSet });
    }
    expect('}');
    return selections;
  }

  function parseVariableDefinitions() {
    const variables = {};
    expect('(');
    while (peek().kind !== ')') {
      expect('$');
      const name = expectName();
      expect(':');
      const type = parseType();
      let defaultValue;
      if (peek().kind === '=') {
        next();
        defaultValue = parseValue();
      }
      variables[name] = { type, defaultValue };
    }
    expect(')');
    return variables;
  }

  const definitions = [];
  while (peek().kind !== 'EOF') {
    if (peek().kind === 'name' && peek().value === 'fragment') {
      next();
      const name = expectName();
      expectName('on');
      const typeCondition = expectName();
      skipDirectives();
      definitions.push({ kind: 'fragment', name, typeCondition, selectionSet: parseSelectionSet() });
      continue;
    }
    let type = 'query';
    let name = null;
    if (peek().kind === '{') {
      definitions.push({ kind: 'operation', type, name, variables: {}, selectionSet: parseSelectionSet() });
      continue;
    }
    type = expectName();
    if (type !== 'query' && type !== 'mutation' && type !== 'subscription') throw new Error(`Unknown operation type ${type}`);
    if (peek().kind === 'name') name = next().value;
    let variables = {};
    if (peek().kind === '(') variables = parseVariableDefinitions();
    skipDirectives();
    definitions.push({ kind: 'operation', type, name, variables, selectionSet: parseSelectionSet() });
  }
  return definitions;
}

function valueFromAst(node, variables) {
  if (!node) return undefined;
  if (node.kind === 'variable') return variables[node.name];
  if (node.kind === 'enum') return node.value;
  if (node.kind === 'list') return node.value.map((v) => valueFromAst(v, variables));
  if (node.kind === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node.value)) out[k] = valueFromAst(v, variables);
    return out;
  }
  if (node.kind === 'literal') return node.value;
  return undefined;
}

// ---------------------------------------------------------- validation

function validateSelection(typeName, selectionSet, fragments, errors, seenFragments = new Set()) {
  for (const selection of selectionSet) {
    if (selection.kind === 'fragmentSpread') {
      if (seenFragments.has(selection.name)) continue;
      seenFragments.add(selection.name);
      const fragment = fragments[selection.name];
      if (!fragment) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      validateSelection(fragment.typeCondition, fragment.selectionSet, fragments, errors, seenFragments);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      validateSelection(selection.typeCondition ?? typeName, selection.selectionSet, fragments, errors, seenFragments);
      continue;
    }
    if (selection.name === '__typename') continue;
    const fields = FIELD_MAP[typeName] ?? [];
    if (!fields.includes(selection.name)) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    if (selection.selectionSet) {
      const childType = CHILD_TYPE[`${typeName}.${selection.name}`];
      if (childType && childType !== 'Node') validateSelection(childType, selection.selectionSet, fragments, errors, seenFragments);
    }
  }
}

// ---------------------------------------------------------- resolvers

function userObject(user) {
  return { __typename: 'User', id: user.id, login: user.login, name: user.name ?? user.login, email: user.email ?? '' };
}

function repoObject(repo) {
  return {
    __typename: 'Repository',
    repo,
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueObject(repo, issue) {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: '',
  };
}

function pullObject(repo, pr) {
  return {
    __typename: 'PullRequest',
    repo,
    pr,
    id: pr.nodeId,
    number: pr.number,
    title: pr.title,
    state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
    merged: pr.merged,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    body: pr.body,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    mergeCommitSha: pr.mergeCommitSha,
  };
}

function commentObject(repo, comment) {
  return {
    __typename: 'IssueComment',
    repo,
    comment,
    id: comment.nodeId,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function encodeCursor(index) {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

function makeConnection(nodes, args, kind) {
  const after = args.after ? decodeCursor(args.after) : -1;
  const first = typeof args.first === 'number' ? args.first : nodes.length;
  const start = after + 1;
  const page = nodes.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    __typename: `${kind}Connection`,
    nodes: page,
    edges: page.map((node, i) => ({ __typename: `${kind}Edge`, node, cursor: encodeCursor(start + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(start) : null,
      endCursor: page.length > 0 ? encodeCursor(endIndex) : null,
    },
    totalCount: nodes.length,
  };
}

function findRepoById(store, repoId) {
  return [...store.repos.values()].find((r) => r.id === repoId) ?? null;
}

const RESOLVERS = {
  'Query.viewer': (store) => userObject(store.viewer),
  'Query.repository': (store, _obj, args) => {
    const repo = store.getRepo(args.owner, args.name);
    return repo ? repoObject(repo) : null;
  },
  'Query.node': (store, _obj, args) => {
    const parsed = parseGlobalId(args.id);
    if (!parsed) return null;
    if (parsed.kind === 'R') {
      const repo = findRepoById(store, Number(parsed.parts[0]));
      return repo ? repoObject(repo) : null;
    }
    const repo = findRepoById(store, Number(parsed.parts[0]));
    if (!repo) return null;
    if (parsed.kind === 'I') {
      const issue = repo.issues.get(Number(parsed.parts[1]));
      return issue ? issueObject(repo, issue) : null;
    }
    if (parsed.kind === 'P') {
      const pr = repo.pulls.get(Number(parsed.parts[1]));
      return pr ? pullObject(repo, pr) : null;
    }
    if (parsed.kind === 'C') {
      const comment = repo.comments.get(Number(parsed.parts[1]));
      return comment ? commentObject(repo, comment) : null;
    }
    return null;
  },
  'Query.__schema': () => ({ __typename: '__Schema' }),
  'Query.__type': (store, _obj, args) => {
    const type = SCHEMA_TYPES[args.name];
    if (!type) return null;
    return { __typename: '__Type', name: args.name, kind: type.kind, description: null };
  },
  'Repository.owner': (store, repoObj) => userObject(store.viewer),
  'Repository.defaultBranchRef': (store, repoObj) => ({ __typename: 'Ref', name: repoObj.repo.defaultBranch }),
  'Repository.issue': (store, repoObj, args) => {
    const issue = repoObj.repo.issues.get(args.number);
    return issue ? issueObject(repoObj.repo, issue) : null;
  },
  'Repository.issues': (store, repoObj, args) => {
    const repo = repoObj.repo;
    const states = args.states ? args.states.map((s) => String(s).toLowerCase()) : null;
    const direction = String(args.orderBy?.direction ?? 'DESC').toUpperCase();
    let list = [...repo.issues.values()];
    if (states) list = list.filter((i) => states.includes(i.state));
    list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return makeConnection(list.map((i) => issueObject(repo, i)), args, 'Issue');
  },
  'Repository.pullRequest': (store, repoObj, args) => {
    const pr = repoObj.repo.pulls.get(args.number);
    return pr ? pullObject(repoObj.repo, pr) : null;
  },
  'Repository.pullRequests': (store, repoObj, args) => {
    const repo = repoObj.repo;
    const states = args.states ? args.states.map((s) => String(s).toUpperCase()) : null;
    let list = [...repo.pulls.values()];
    if (states) {
      list = list.filter((p) => {
        const state = p.merged ? 'MERGED' : p.state.toUpperCase();
        return states.includes(state);
      });
    }
    list.sort((a, b) => b.number - a.number);
    return makeConnection(list.map((p) => pullObject(repo, p)), args, 'PullRequest');
  },
  'Issue.user': (store, issueObj) => userObject(issueObj.issue.user),
  'PullRequest.user': (store, prObj) => userObject(prObj.pr.user),
  'IssueComment.user': (store, commentObj) => userObject(commentObj.comment.user),
  'PullRequest.mergeable': (store, prObj) => (store.pullConflicts(prObj.repo, prObj.pr) ? 'CONFLICTING' : 'MERGEABLE'),
  'PullRequest.files': (store, prObj, args) => {
    const files = store.pullFiles(prObj.repo, prObj.pr).map((f) => ({
      __typename: 'ChangedFile',
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
    }));
    return makeConnection(files, args, 'ChangedFile');
  },
  'Mutation.createIssue': (store, _obj, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.repositoryId);
    if (!parsed || parsed.kind !== 'R') throw new Error('Invalid repositoryId');
    const repo = findRepoById(store, Number(parsed.parts[0]));
    if (!repo) throw new Error('Repository not found');
    const created = store.createIssue(repo, { title: input.title ?? '', body: input.body ?? '', labels: [] });
    if (created.error) throw new Error(created.error);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, created.issue), clientMutationId: input.clientMutationId ?? null };
  },
  'Mutation.closeIssue': (store, _obj, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.issueId);
    if (!parsed || parsed.kind !== 'I') throw new Error('Invalid issueId');
    const repo = findRepoById(store, Number(parsed.parts[0]));
    if (!repo) throw new Error('Repository not found');
    const patched = store.patchIssue(repo, Number(parsed.parts[1]), { state: 'closed' });
    if (!patched) throw new Error('Issue not found');
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, patched.issue), clientMutationId: input.clientMutationId ?? null };
  },
  'Mutation.createPullRequest': (store, _obj, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.repositoryId);
    if (!parsed || parsed.kind !== 'R') throw new Error('Invalid repositoryId');
    const repo = findRepoById(store, Number(parsed.parts[0]));
    if (!repo) throw new Error('Repository not found');
    const created = store.createPull(repo, {
      title: input.title ?? '',
      body: input.body ?? '',
      head: input.headRefName,
      base: input.baseRefName,
    });
    if (created.error) throw new Error(created.error);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created.pr), clientMutationId: input.clientMutationId ?? null };
  },
  'Mutation.mergePullRequest': (store, _obj, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.pullRequestId);
    if (!parsed || parsed.kind !== 'P') throw new Error('Invalid pullRequestId');
    const repo = findRepoById(store, Number(parsed.parts[0]));
    if (!repo) throw new Error('Repository not found');
    const merged = store.mergePull(repo, Number(parsed.parts[1]));
    if (merged.error) throw new Error(merged.error);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, merged.pr), clientMutationId: input.clientMutationId ?? null };
  },
  'Mutation.addComment': (store, _obj, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.subjectId);
    if (!parsed || parsed.kind !== 'I') throw new Error('Invalid subjectId');
    const repo = findRepoById(store, Number(parsed.parts[0]));
    if (!repo) throw new Error('Repository not found');
    const created = store.createComment(repo, Number(parsed.parts[1]), input.body ?? '');
    if (!created) throw new Error('Issue not found');
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node: commentObject(repo, created.comment), cursor: encodeCursor(created.comment.id) },
      clientMutationId: input.clientMutationId ?? null,
    };
  },
  '__Type.fields': (store, typeObj, args) => {
    const names = FIELD_MAP[typeObj.name] ?? [];
    return names.map((name) => ({
      __typename: '__Field',
      name,
      description: null,
      args: [],
      type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
      isDeprecated: false,
      deprecationReason: null,
    }));
  },
  '__Type.enumValues': (store, typeObj) => {
    const values = SCHEMA_TYPES[typeObj.name]?.enumValues ?? [];
    return values.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
  },
  '__Type.inputFields': () => [],
  '__Type.interfaces': () => [],
  '__Type.possibleTypes': () => [],
  '__Type.ofType': () => null,
  '__Field.args': (store, fieldObj) => fieldObj.args ?? [],
  '__Schema.queryType': () => ({ __typename: '__Type', name: 'Query', kind: 'OBJECT' }),
  '__Schema.mutationType': () => ({ __typename: '__Type', name: 'Mutation', kind: 'OBJECT' }),
  '__Schema.types': () => Object.keys(SCHEMA_TYPES).map((name) => ({ __typename: '__Type', name, kind: SCHEMA_TYPES[name].kind, description: null })),
  '__Schema.directives': () => [],
};

// ---------------------------------------------------------- execution

function resolveField(store, obj, typeName, field, variables, errors, fragments) {
  if (field.name === '__typename') return obj?.__typename ?? typeName;
  const args = {};
  for (const [key, value] of Object.entries(field.arguments ?? {})) args[key] = valueFromAst(value, variables);
  const resolver = RESOLVERS[`${typeName}.${field.name}`];
  let value;
  try {
    if (resolver) value = resolver(store, obj, args);
    else if (obj && field.name in obj) value = obj[field.name];
    else value = null;
  } catch (err) {
    errors.push({ message: String(err?.message ?? err) });
    return null;
  }
  if (value === undefined) value = null;
  if (field.selectionSet) {
    if (value === null) return null;
    const childType = CHILD_TYPE[`${typeName}.${field.name}`] ?? value.__typename ?? typeName;
    if (Array.isArray(value)) return value.map((item) => resolveSelection(store, item, childType, field.selectionSet, variables, errors, fragments));
    return resolveSelection(store, value, childType, field.selectionSet, variables, errors, fragments);
  }
  return value;
}

function resolveSelection(store, obj, typeName, selectionSet, variables, errors, fragments) {
  const out = {};
  for (const selection of selectionSet) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments[selection.name];
      if (!fragment) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition && obj?.__typename && obj.__typename !== fragment.typeCondition) continue;
      Object.assign(out, resolveSelection(store, obj, fragment.typeCondition ?? typeName, fragment.selectionSet, variables, errors, fragments));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && obj?.__typename && obj.__typename !== selection.typeCondition) continue;
      Object.assign(out, resolveSelection(store, obj, selection.typeCondition ?? typeName, selection.selectionSet, variables, errors, fragments));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    out[responseKey] = resolveField(store, obj, typeName, selection, variables, errors, fragments);
  }
  return out;
}

function executeOne(store, operation) {
  const { query, variables: rawVariables, operationName } = operation;
  if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'No query provided' }] };
  let definitions;
  try {
    definitions = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: String(err?.message ?? err) }] };
  }
  const fragments = {};
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments[definition.name] = definition;
  }
  const operations = definitions.filter((d) => d.kind === 'operation');
  let selected = null;
  if (operationName) selected = operations.find((o) => o.name === operationName) ?? null;
  else if (operations.length === 1) selected = operations[0];
  else if (operations.length > 1) return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  if (!selected) return { errors: [{ message: 'No operation found.' }] };
  const variables = { ...(rawVariables ?? {}) };
  for (const [name, definition] of Object.entries(selected.variables ?? {})) {
    if (variables[name] === undefined && definition.defaultValue !== undefined) {
      variables[name] = valueFromAst(definition.defaultValue, {});
    }
  }
  const errors = [];
  const rootType = selected.type === 'mutation' ? 'Mutation' : 'Query';
  validateSelection(rootType, selected.selectionSet, fragments, errors);
  if (errors.length > 0) return { data: null, errors };
  const data = resolveSelection(store, null, rootType, selected.selectionSet, variables, errors, fragments);
  const result = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/** Execute one GraphQL request body (a single operation document, or an array for batching). */
export function handleGraphQL(store, body) {
  let result;
  if (Array.isArray(body)) result = body.map((operation) => executeOne(store, operation));
  else result = executeOne(store, body ?? {});
  return { status: 200, headers: {}, body: JSON.stringify(result) + '\n' };
}
