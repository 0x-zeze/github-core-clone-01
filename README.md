# github-core-clone-01 — a GitHub-compatible git forge

One Node process, no dependencies, no outside service. It serves all four
surfaces from a single in-memory store with its own git object store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs, fetch with shallow/deepen) and v0, receive-pack v0 with
  fast-forward checks and per-ref report-status.
- **REST v3** under `/api/v3` — repos, branches, commits, contents, labels,
  issues (+comments) and pull requests (incl. squash merge with three-way
  conflict detection).
- **GraphQL** at `/api/graphql` — viewer/repository/node, issue and
  pull-request connections with cursor pagination, the five mutations the
  suite uses, and `__type` introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, modern 2026-07-28
  discovery plus legacy `initialize`, eight tools (repo/issue/PR).

## Running

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

`main.ts` (the kit starter, kept as-is) binds an ephemeral port, registers it
with the env, then polls `/done` until the trial ends. Without
`MAKEFUN_ENV_URL` it exits at once. When `MAKEFUN_SHOP_TOKEN` is set, the
API surfaces require `Authorization: Bearer <token>`; git and `/healthz`
never do. The store is deterministic: timestamps come from a logical
counter clock, never the wall clock, so two runs export identical state.

## Files

- `main.ts` — lifecycle (starter, kept as-is)
- `app.ts` — HTTP server, routing, auth, request ids
- `store.ts` — git objects, repos, issues, pull requests, deterministic clock
- `git.ts` — pkt-lines, packfiles, smart HTTP handlers
- `rest.ts` — REST v3
- `graphql.ts` — GraphQL parser, validator and executor
- `mcp.ts` — MCP JSON-RPC dispatch and tools
- `scenario.ts` — the scenario PRNG (study aid; not imported by the server)
