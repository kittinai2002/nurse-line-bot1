# Vercel runtime

Node.js 24 functions in `api/` receive signed LINE webhooks and authenticated cron calls. There is no UI, no infinite server process and no in-memory account cache shared across requests.

Neon PostgreSQL is the durable source of truth. `nurse_cloud_accounts.snapshot` holds a versioned per-user logical SQLite snapshot (configuration, roster, drafts, event inbox and outbox). A temporary `:memory:` SQLite database runs the existing command/validation code inside each invocation; no persistent file is expected on Vercel. SQL identifiers are fixed, values are parameterized. `nurse_meta` pins the original owner. Use a separate Neon database/branch for each OA and for non-production testing.

A PostgreSQL row lease admits only one worker per account. Every snapshot write checks owner, unexpired lease and revision atomically, and renews the lease. Persisted changes and LINE retry keys are checkpointed before every external LINE call and again after processing. If a request dies after an accepted push, the next request retries with the same durable retry key. A stale worker cannot commit after another worker acquires the account. Reply-token reuse follows existing LINE semantics. No code claims exactly-once network delivery or that an accepted message was read.

Webhook handlers await processing and return 503 if work cannot complete. Enable LINE webhook redelivery; processed event IDs remain deduplicated. Unknown/group/old/unsigned events do not register users. Unknown unfollow events do not register users either. Errors never expose SQL, DB URLs or tokens.

`next_due` is indexed in Postgres. The external minute scheduler reads only accounts with due work, not every account every minute. Each invocation selects up to 20 due accounts, processes 3 at a time and respects a bounded request budget. Unprocessed work remains due for the next call. This initial setup targets a small OA; benchmark and expand the dispatcher before large simultaneous reminder bursts. Each account retains the existing limit of 5 outgoing jobs per tick and 10 minutes of reminder grace. Scale, free-tier quotas, pauses, cold starts, cron outages and LINE quotas can delay or prevent a reminder. Enable cron-job.org failure notifications and inspect platform logs/usage.

A 90-second lease exceeds the configured 60-second Vercel function duration. DB requests and LINE fetches time out after 10 seconds. Failed workers release their lease where possible; killed workers recover after lease expiry. A 40-second dispatch budget leaves room for final persistence. A single pathological account can still exceed a budget via upstream timeouts; persistence protects later retries, it does not promise deadline punctuality.

`/api/cron` accepts a private Authorization Bearer header of at least 32 characters. There is no URL token, public command endpoint, migration endpoint, or data export endpoint. Keep production routing reachable by LINE/cron while exposing only the signed webhook, bearer-protected cron and non-sensitive health endpoint. Store secrets only in Vercel Environment Variables; never commit data or .env files.

Migration reads local files read-only, pins the original owner, refuses a running local bot where detectable, skips already populated online accounts, clears unsaved drafts/inbound reply tokens and pauses alerts. Preserve outbox keys/history; resume only after reviewing the roster in LINE. Take a Neon backup/export per your account's capabilities before subsequent production maintenance.

Validation: run `npm ci`, `npm test`, `npm run check:vercel`. Tests include real PostgreSQL SQL execution via PGlite for leases, revision fencing and scheduling, plus mock LINE calls for crash recovery and raw-body signature checks. Live Neon/Vercel/LINE and cron-job.org delivery require deployment smoke testing; a source check is not a successful production deploy.

Official references checked 10 November 2026:
- https://vercel.com/docs/functions/runtimes/node-js
- https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing
- https://neon.com/docs/serverless/serverless-driver
- https://cron-job.org/en/faq/
