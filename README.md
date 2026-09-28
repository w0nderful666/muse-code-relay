[中文](README.zh-CN.md)

# muse-code-relay

An invite-code relay where every draw is decided by a **provably fair, weighted-random algorithm**. No manual picks, no favoritism, no hidden controls — the source code below is the entire proof.

Anyone can draw a code, share their own, and watch its progress in real time. The operator cannot rig who gets what: the draw query treats every eligible code identically, and identities never leave the database in plaintext.

## How a draw works

One atomic SQL statement picks the code. Nothing else decides:

```sql
INSERT INTO claims (id, invite_id, actor_hash, receipt_hash, created_at, copied_at)
SELECT ?, i.id, ?, ?, ?, ? FROM invites i
WHERE i.platform = ?
  AND i.status = 'ACTIVE'          -- paused or removed codes never enter the draw
  AND i.milestone_at IS NULL       -- completed codes never enter the draw
  AND i.copy_count < 30            -- each code stops circulating at 30 draws
  AND i.claim_count < 60
  AND NOT EXISTS (                 -- you can never draw the same code twice
    SELECT 1 FROM claims c WHERE c.invite_id = i.id AND c.actor_hash = ?)
ORDER BY i.success_count DESC,     -- codes people rated "works" go first
         i.failure_count ASC,      -- codes people rated "broken" sink
         random()                  -- everything else is uniform random
LIMIT 1;
```

Why this is fair:

- **Same rule for every code.** There is no allowlist, no priority flag, no admin override in the draw path. A code submitted by the operator goes through the exact same query.
- **Merit is earned, not assigned.** `success_count` only grows when a real drawer clicks "copy" and then reports "works". One draw = one vote max.
- **Bad codes remove themselves.** Three "broken" reports from three different drawers automatically pause a code (`ACTIVE` → `PAUSED`). Pause is reversible by the admin; it never deletes data.
- **Atomic.** The pick, the claim, and the counter increments happen inside single statements and triggers, so two simultaneous draws cannot double-count the 30th copy.
- **Anonymous.** IPs are HMAC-hashed with a server-side secret before storage. The operator sees tallies, not people.

## Verify it yourself

```bash
npm install
npm test   # 7 tests: distribution, concurrency, quotas, expiry, feedback gating
```

The suite runs the real production SQL (migrations + triggers) against an in-memory database, including a race for the 30th copy and the three-strikes auto-pause.

## How the relay works

1. **Share** — submit a 6-character code (5/day per network).
2. **Draw** — take a code (3/day per network). The draw counts as a copy immediately, so manual copies are never undercounted.
3. **Confirm & feedback** — click "copy", then report whether the code works. Feedback unlocks only after the copy button is clicked.
4. **Progress** — query live progress with just the code. At 30 draws the code retires and the submitter gets a final report.

## Project layout

```
src/index.js          Worker: API, draw logic, rate limits
public/               Static frontend (no build step)
  index.html          Main page
  admin.html          Admin console (rename to something unguessable before deploying)
  admin.js / app.js   Frontend logic
migrations/           D1 schema + triggers (0001–0005)
tests/                Node test suite, runs production SQL
wrangler.jsonc        Worker config (D1 id intentionally left as a placeholder)
```

## Deploy your own

```bash
npx wrangler d1 create <db-name>
# put the database id into wrangler.jsonc
npx wrangler d1 migrations apply <db-name> --remote
npx wrangler secret put HASH_SECRET
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Rename `public/admin.html` to a long random filename first — the admin console is protected only by the token, and obscurity helps. Optional: set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` for bot protection.

## License

MIT — do what you want, keep the notice.
