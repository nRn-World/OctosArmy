# Security Policy

## Supported Versions

Currently, the following versions of OctosArmy are supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| < 1.1.0 | :x:                |

## Reporting a Vulnerability

If you find a security vulnerability, please do NOT open a public issue. Instead, send an email to nrnworld@gmail.com

We will acknowledge your report within 48 hours and provide a timeline for a fix. Please keep information confidential until a patch is released.

---

## Security Model

OctosArmy grants an AI agent the ability to read, move and delete files inside folders you
explicitly approve, and to run a small allowlist of shell commands. The data is never sent
to a cloud service, but the local API is a real attack surface, so it is locked down in
four layers.

### 1. Only this machine, only pages we serve

The backend binds to `127.0.0.1` and rejects any request whose `Host` header is not a
loopback address. That defeats DNS rebinding, where a page on `evil.com` re-resolves its
own hostname to `127.0.0.1`. Requests carrying a foreign `Origin` are rejected too. There is
no CORS header at all, so a foreign page cannot read any response.

### 2. A per-start session token

Every state-changing call and every file operation needs the `x-octos-token` header. The
token is generated fresh on each start and injected into the HTML the backend serves (and,
in Vite dev mode, into the dev-server HTML). A page from another origin can never read that
HTML, so it can never learn the token. Health checks are the only unauthenticated endpoint.

Mutating endpoints additionally require `Content-Type: application/json`, which browsers can
only send after a preflight that is never approved.

The folder picker in the web UI is served by `GET /api/fs/dirs`, behind the same token. The
native dialog only exists in the Electron shell, so in a browser tab the UI lists folder
*names* through the backend instead of telling the user to type a path. It reads no file
contents, and it grants nothing — the folder still has to be added to the workspace roots
explicitly, which is what narrows the sandbox.

### 3. A sandbox that survives symlinks

Paths are resolved with `fs.realpathSync.native()` on both the granted root and the target
before they are compared, so a symlink or NTFS junction placed inside an approved folder can
no longer be used to step outside it. On case-insensitive filesystems (Windows) the
comparison folds case; on case-sensitive filesystems a mismatch fails closed. Granting a
folder still grants everything beneath it — approve folders deliberately.

### 4. A human decides before anything destructive

`delete_path`, `empty_dir`, `move_path`, `bulk_move` and `run_terminal` are always gated,
no matter what `risk_level` the model claims. In the desktop UI the gate is the single
up-front confirmation: accepting it sets `approvedDestructive` on that one run, and every
destructive step in that run then proceeds and is logged. The run is bounded by `maxSteps`,
by the sandbox roots you granted, and by NÖDSTOPP, which aborts it immediately.

A client that calls `/api/agents/run-ollama` without `approvedDestructive: true` gets the
old behaviour: each destructive action parks the run until a human answers
`/api/approvals/respond`, and 180 seconds without an answer counts as a denial. Denying an
action stops that action for the rest of the run instead of asking about it again.

Scheduled (cron) runs have no UI attached to approve anything, so **destructive intents are
refused outright during scheduled missions** — they may only read, list, search and copy.
`empty_dir` and `delete_path` refuse to act on the sandbox root itself.

`python -m pytest` is on the terminal allowlist, and pytest imports a `conftest.py` from the
working directory by design. That is why `run_terminal` is always gated behind the approval
prompt rather than trusted.

## Known Residual Risks

- **Updates are not signature-verified.** `electron-updater` only checks an update's
  Authenticode signature when `build.win.publisherName` is configured, and this build does
  not declare one. Updates are still checked against the SHA-512 in `latest.yml` fetched
  over HTTPS from GitHub, but a compromised release would be installed. Sign the build, set
  `publisherName`, and rebuild to close this.
- **A local process on your machine is trusted.** The session token protects against remote
  pages, not against software already running on the same account: anything that can read
  `%APPDATA%\OctosArmy\config\session.token` can drive the API.
- **The dependency tree carries advisories.** Run `npm audit` before releases; most are in
  build tooling (`electron-builder`, `app-builder-lib`), but `builder-util-runtime` (used by
  `electron-updater`) and `proxy-addr` (used by `express`) are on the runtime path.
- **Never keep publish credentials in the repository folder.** A `GH_TOKEN` sitting in a
  project-level `.env` is readable by anything that can reach the API; pass it in the shell
  environment when running `npm run dist` instead, and rotate it if it has ever been shared.
