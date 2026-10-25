# PC Port — implementation and compatibility contract

This fork adds a separate, independently authenticated PC API under \`/api/pc/v1\`.
It intentionally coexists with the legacy ROS-shaped routes instead of changing their
authentication semantics.

## What is implemented in this fork

- Independent account registration and login, with bcrypt password hashes (10-character minimum; bcrypt’s 72-byte input ceiling is enforced).
- Random opaque bearer tokens; only SHA-256 token hashes are stored in PostgreSQL.
- Token expiry and explicit logout/revocation.
- A session directory with public/private listings, hashed private join codes, host
  heartbeats, membership joins/leaves, player limits, and expiry leases.
- A status endpoint that explicitly describes what's implemented and what's not.
- Unit tests for input validation and token-hash helpers.

## What is *not* implemented

This API does not emulate Rockstar/Social Club login, mint Rockstar credentials, bypass
Rockstar authentication/licensing, or claim to authenticate a stock GTA V executable.
It also does not provide GTA world simulation, peer packet transport, voice, authoritative
physics, or in-game session hooking. A launcher or client adapter must deliberately use
this independent API, and game transport must be implemented/tested as a separate layer.

PC protocol compatibility with GTA V PC 1.61 is **unverified**. Existing files under
\`src/endpoints/auth/PC\` implement legacy ROS-shaped behavior; they are not the account
system defined here and must not be confused with this API.

## Local run

The normal Compose startup initializes the schema with \`prisma db push\`. From PowerShell:

\`\`\`powershell
Copy-Item .env.example .env
# Fill the required settings in .env; do not commit it.
docker compose up --build -d
curl http://localhost/api/pc/v1/status
\`\`\`

The status response should include \`"accountApi":"enabled"\` and \`"sessionDirectory":"enabled"\`.
It intentionally reports transport and GTA V 1.61 compatibility as not implemented/unverified.

## End-to-end API smoke test

After starting the stack and confirming the health check, run this from PowerShell in
the repository root:

```powershell
.\examples\pc-port-smoke-test.ps1
```

The script creates uniquely named temporary accounts, creates a test-only session,
checks discovery and join/leave counts, verifies a heartbeat, and revokes the tokens.
It does not touch the legacy LSO accounts. Use it against a local or private test
deployment only. A passing result validates these backend routes, not GTA V 1.61
client compatibility or in-game networking.

## API

All protected routes use \`Authorization: Bearer <token>\`. The independent token is not a
Rockstar Social Club token.

- \`GET /api/pc/v1/status\` — public capability/status report.
- \`POST /api/pc/v1/auth/register\` — JSON \`{ "email", "displayName", "password" }\`.
- \`POST /api/pc/v1/auth/login\` — JSON \`{ "email", "password" }\`.
- \`GET /api/pc/v1/auth/me\` — current independent account.
- \`POST /api/pc/v1/auth/logout\` — revoke the current token.
- \`GET /api/pc/v1/sessions?gameVersion=...&region=...\` — list active public sessions and the caller's own sessions.
- \`POST /api/pc/v1/sessions\` — create a session advertisement. JSON fields: \`label\`,
  \`gameVersion\`, \`region\` (default \`auto\`), \`maxPlayers\` (2–32), and \`private\` (boolean).
  The host is added as the first member. Private join codes are returned once at creation.
- \`POST /api/pc/v1/sessions/:id/heartbeat\` — host renews its 90-second listing lease;
  call about every 30 seconds.
- \`POST /api/pc/v1/sessions/:id/join\` — join a listing; private sessions require JSON
  \`{ "joinCode": "..." }\`.
- \`POST /api/pc/v1/sessions/:id/leave\` — leave; if the host leaves, its listing expires.

All successful session-directory actions are *metadata only*. The API does not return
peer addresses, connect clients, or relay gameplay traffic.

## Validation, operations, and remaining port work

1. Run \`npm test\` and \`npm run validate\` in the project environment.
2. Start the Compose stack, verify the status endpoint, and exercise account/session flows.
3. Add HTTPS at deployment time; never expose login or bearer tokens over an untrusted
   network. Configure a real reverse-proxy/WAF rate limit for auth routes—the in-process
   limiter is only a development safety net and does not coordinate across replicas.
4. Decide the intended PC client integration contract using a client you own or are
   authorized to modify. Verify exact game build compatibility experimentally before
   advertising support for 1.61.
5. Implement gameplay transport and replication separately, with packet framing, identity,
   authorization, timeout handling, abuse limits, and integration tests.

Because this is an AGPL-3.0 fork, retain copyright/license notices and make corresponding
source available to users interacting with a modified version over a network as required
by the license.
