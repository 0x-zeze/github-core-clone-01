// Entry <-> trial-env lifecycle. The scored server lives in app.ts; this file only
// wires this process to the env that runs the trial: bind an ephemeral port, tell
// the env that port, then poll for the env's done signal and exit cleanly.
//
// Protocol (must stay exact, it is the harness's contract, not the contest's):
//   - MAKEFUN_ENV_URL is the env origin (e.g. http://store:8080 in a trial).
//     Without it there is nothing to talk to, so exit 1 at once.
//   - listen(0): the kernel picks a free port. Never bind 8080, the env owns it.
//   - POST {env}/register {"port": N}. The first register wins; a 409 means some
//     other entry already registered and this process just keeps waiting.
//   - GET {env}/done until the body reads {"done": true}. The env answers at
//     once ({"done": false} while the suite runs), so this is a poll with a
//     short exponential backoff, never a long-held request. Never exit early.
//   - On done: close the server and exit 0. The harness then stops the env.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT = 30000;
const BACKOFF_FIRST = 250;
const BACKOFF_CAP = 2000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function backoff(attempt: number): number {
  const step = attempt > 8 ? 8 : attempt;
  const wait = BACKOFF_FIRST * 2 ** step;
  return wait > BACKOFF_CAP ? BACKOFF_CAP : wait;
}

async function postRegister(port: number): Promise<Response> {
  return fetch(`${envOrigin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
}

// POST the bound port until the env accepts it. 200 is the normal answer and
// 409 means a first register already won, which is not ours to fix. 400 and
// 405 are contract errors and end the program; a network error or any other
// status is retried, since the env may still be starting.
async function register(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await postRegister(port);
      const accepted = res.status === 200 || res.status === 409;
      if (accepted) return;
      const contractError = res.status === 400 || res.status === 405;
      if (contractError) {
        const detail = await res.text();
        throw new Error(`register answered HTTP ${res.status}: ${detail}`);
      }
    } catch (err) {
      const fatal = err instanceof Error && err.message.startsWith('register answered HTTP ');
      if (fatal) throw err;
    }
    await pause(backoff(attempt));
    attempt += 1;
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await pause(backoff(attempt));
    attempt += 1;
  }
}

// Bind the port, register it, then wait for the env: the whole life of the process.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const bound = address !== null && typeof address !== 'string';
  if (!bound) throw new Error('the server did not bind an ephemeral TCP port');
  const port = (address as { port: number }).port;
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
