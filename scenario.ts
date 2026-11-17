// scenario.ts — derive the trial's fixed identities from the contest's one constant
// seed. The suite builds every name it sends from this seed (wire.ts's SCENARIO_SEED), so
// the token owner's login is the same in every trial, practice or scored. This file
// reimplements that derivation from scratch (FNV-1a + splitmix64 seeding, xorshift64*
// stream, deterministic user generation) so the forge can answer `viewer { login }`
// and enforce repository ownership without ever seeing the scenario itself.
//
// Only the user list is needed: the first user is the viewer (the token owner), the
// second a teammate, the third a stranger whose name must never resolve to the viewer's
// repositories.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value) {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function seedFor(label) {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  constructor(seed) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64() {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32() {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive) {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick(items) {
    return items[this.nextInt(items.length)];
  }
}

function generateUsers(count) {
  const rng = new Rng(seedFor('users'));
  const used = new Set();
  const users = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(12);

/** The token owner: the login every repository belongs to. */
export const VIEWER = USERS[0];
/** A teammate login (never owns a repository in this forge). */
export const TEAMMATE = USERS[1];
/** A stranger login: the same repository name under this owner is always 404. */
export const STRANGER = USERS[2];
export const ALL_USERS = USERS;
