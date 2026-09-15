# Renewing autonomous delivery credentials without restarting agents

The autonomous delivery hook uses `PAPERCLIP_DELIVERY_BOT_TOKEN` as `GH_TOKEN`
for its GitHub commands. A successful interactive `docker exec ... gh api` can
therefore test a different credential: the container's operator PAT.
Updating an env file or a systemd unit does not update a running container's
environment. The previous refresh script renewed the installation token on
disk while the hook could keep using the startup value.

This change adds the opt-in `PAPERCLIP_DELIVERY_BOT_TOKEN_FILE`. When configured,
the hook opens this JSON file before each delivery command, including the
mandatory Quantum PR wrapper after quality gates. Missing, unsafe, invalid,
wrong-repository or expired files block delivery; there is no fallback to the
startup token or operator PAT. Manual delivery and disabled hooks keep their
existing behavior. Without the file setting, the legacy environment setting
still works, with its existing rotation limitation.

```json
{
  "token": "<installation-token>",
  "expires_at": "<UTC-expiry-from-GitHub>",
  "repository": "Beyn-SOLIDUS/quantum"
}
```

GitHub installation tokens expire after one hour. The publisher scopes each
token to the requested repository and retains the App's granted permissions;
it does not grant new permissions. Both legacy tokens and the longer stateless
`ghs_APPID_JWT` format are accepted. See the
[GitHub installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

The file is bounded to 16 KiB. It must be a regular file at an absolute path,
with no executable, group-write or other-user permissions (use `0640` with the
container reader's group). The hook requires more than five minutes of validity
at command launch. Current local adapter delivery subprocesses time out after
120 seconds; a custom runner with longer timeouts must account for this margin.
Already-running subprocesses retain their launch token. Quality scripts do not
receive the new token. Adapters register each command's actual environment with
their streaming log redactor; returned command buffers are also redacted.

## Publisher

`scripts/refresh-delivery-token.py` uses Python 3 and OpenSSL. It signs the App
JWT through stdin, calls GitHub over HTTPS, validates the expiry, stages files
with their final owner/group/mode, and atomically replaces them. Concurrent
refresh attempts are excluded with a file lock. Errors exit nonzero without
logging tokens, JWTs, response bodies or tracebacks. Only repository and expiry
are logged on success. It never edits units, updates the database or restarts
Paperclip.

An optional `--git-credentials` preserves the existing installation-only Git
store workflow. It replaces the whole file, using `x-access-token` as the HTTPS
username, and sets owner to the refresh process with mode `0640` and the selected
reader group. Before minting and again before publication, it rejects existing
stores containing a PAT, multiple entries, another host or a repository-specific
URL. It accepts one `ghs_` entry for `github.com`, using `x-oauth-basic` (legacy)
or `x-access-token`, and may create an explicitly requested missing store. This
is a format check, not proof of the old token's installation identity. Confirm
the store belongs to this installation and its helpers actually select it.
Local repository helpers,
embedded remote credentials and other stored credentials can still take
precedence. A refreshed file alone does not prove which identity Git uses.
The publisher's lock coordinates its own refresh processes. Stop the old
publisher before migration and give this store a single credential writer;
other programs do not automatically participate in that lock.

Both outputs are staged before either is published. Each rename is atomic; the
pair is not a filesystem transaction. If publication fails between renames, the
service fails and must be retried. Existing readers can finish using the previous
still-valid token. A minting or staging failure preserves both published files.

Mount the containing directory, as the existing `/mnt/data/quantum-dev:/paperclip`
mount does. A bind mount of an individual file can keep pointing to the replaced
inode; see [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).
Keep this credential directory outside agent worktrees and writable only by the
publisher. Do not mount the App private key into agent execution environments.

## Migration for the reported Quantum DEV deployment

This is an operator runbook, not an automatic deployment. The source baseline is
`061911c10950dec858a7d816b00c90280f44b18d`. Build and validate an image containing
the complete patch first. Updating only the host script will not teach the old
image to read a file. Record the current image, unit/drop-ins and file metadata
in a root-only backup; do not paste secrets or full unit/env-file contents into
logs or tickets.

The `Docker` workflow publishes to GHCR on a push to `main`; the PR's `Build`
check alone does not publish that deployment image. After an authorized merge,
wait for that merge commit's Docker workflow, record its image tag and digest,
and verify the image revision matches the merged source before changing the unit.

1. Confirm the running `node` user's numeric group and the Git helper selection.
   Keep the valid operator `GH_TOKEN` / `GITHUB_TOKEN` separate from this App
   delivery migration. The supplied root-shell and container PAT checks already
   succeed; they are not evidence of App-token freshness.
2. Pause the refresh timer and let any current oneshot refresh finish before
   replacing the publisher. Install the
   reviewed script and create a dedicated directory with root ownership and the
   actual reader group. These commands run on the server from a reviewed checkout:

   ```sh
   PAPERCLIP_READER_GID=$(docker exec --user node paperclip-quantum-dev id -g)
   systemctl stop paperclip-token-refresh.timer
   install -d -o root -g root -m 0755 /usr/local/libexec/paperclip
   install -o root -g root -m 0755 scripts/refresh-delivery-token.py /usr/local/libexec/paperclip/refresh-delivery-token.py
   install -d -o root -g "$PAPERCLIP_READER_GID" -m 0750 /mnt/data/quantum-dev/delivery-credentials
   install -d -o root -g root -m 0755 /etc/systemd/system/paperclip-token-refresh.service.d
   ```

3. Replace the refresh service's command with this drop-in, substituting the
   numeric group from step 2 for `READER_GID`. The App ID/key path below come from
   the reported installation. Confirm them locally. Include the final Git-store
   option only after the compatibility check above. No token value goes in it.

   ```ini
   [Service]
   ExecStart=
   ExecStart=/usr/bin/python3 /usr/local/libexec/paperclip/refresh-delivery-token.py --app-id 3994787 --pem-file /mnt/data/quantum-dev/secrets/paperclip-bot.pem --repository Beyn-SOLIDUS/quantum --output /mnt/data/quantum-dev/delivery-credentials/github.json --reader-gid READER_GID --git-credentials /mnt/data/quantum-dev/git-credentials
   ExecStartPost=
   ```

   Save it as `paperclip-token-refresh.service.d/rotation-file.conf` under
   `/etc/systemd/system`. Run `systemctl daemon-reload`, then
   `systemctl start paperclip-token-refresh.service`. Require success and a
   readable, unexpired JSON file from inside the existing container before the
   next step. Restart the existing refresh timer, whose observed cadence is
   50 minutes. Monitor failed refreshes and expiry; retry a failed refresh before
   the five-minute consumer margin. An inactive successful oneshot service is
   normal; inspect its exit status and timestamps.
4. For the new image, replace the unit's inline
   `-e PAPERCLIP_DELIVERY_BOT_TOKEN=...` with:

   ```sh
   -e PAPERCLIP_DELIVERY_BOT_TOKEN_FILE=/paperclip/delivery-credentials/github.json \
   ```

   Remove any competing delivery-token setting in the two `--env-file` inputs
   for this instance. Retain the other environment settings and the directory
   mount. Do not enable previously disabled hooks, modify agent identities,
   weaken signature requirements or change production gate labels.
5. Drain active agent runs and pause new scheduling through the deployment's
   normal controls. Deploy the validated image with one planned container
   recreation, then resume scheduling. Do not restore the old periodic
   `ExecStartPost=... restart paperclip-quantum-dev.service` workaround.

This is one planned recreation for this migration. Subsequent application
upgrades may still require a recreation; token renewal itself no longer does.

## Retiring old credentials and scripts

- The new refresh command stops writing `delivery-bot.env`, rewriting the
  container unit and logging token prefixes to `paperclip-token-refresh.log`.
  Confirm no timer, cron job or other unit still invokes the old script. After
  acceptance, archive the old script and unused env file in a root-only backup
  outside their active paths. Keep historical logs under the host's restricted
  access and retention policy.
- `paperclip-token-sync.sh` expects a missing token file and a missing trigger
  service; its own script and unit still exist. Check reverse dependencies and
  other references, then retire both from their active paths after acceptance.
  Do not reactivate its plaintext `adapter_config` updates. Reload systemd after
  removing a retired unit.
- The container's operator PAT, `quantum.service.d/github-pat.conf` and the PAT
  in `quantum-runners.service` are separate consumers. This hook change does not
  give those clients or agent sessions a rotating credential source. Keep their
  removal as a separate migration: identify each consumer, provide and test its
  replacement over an expiry boundary, then remove the static setting and
  revoke that PAT only when no consumer still depends on it. Preserve distinct
  operator and agent identities throughout.

## Acceptance checks on the server

- Verify the file is readable as the actual container user, has more than five
  minutes remaining, and names exactly the intended repository. Do not print
  the token, even a prefix.
- Test the App credential explicitly, rather than the container's default PAT.
  This read-only check exposes only the installed repository list:

  ```sh
  docker exec --user node paperclip-quantum-dev node -e '
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const c = JSON.parse(fs.readFileSync("/paperclip/delivery-credentials/github.json", "utf8"));
  if (c.repository !== "Beyn-SOLIDUS/quantum" || Date.parse(c.expires_at) - Date.now() <= 300000) process.exit(1);
  const p = spawnSync("gh", ["api", "installation/repositories", "--jq", "[.repositories[].full_name]"], {
    env: { ...process.env, GH_TOKEN: c.token, GITHUB_TOKEN: c.token }, encoding: "utf8"
  });
  if (p.status !== 0) { console.error("App credential verification failed"); process.exit(1); }
  const repos = JSON.parse(p.stdout);
  if (repos.length !== 1 || repos[0] !== c.repository) process.exit(1);
  console.log(JSON.stringify({ repository: c.repository, installation_access: true, expires_at: c.expires_at }));
  '
  ```

- Run an already-authorized delivery task with its real registered identity and
  signed commit through `scripts/agent-pr-create.sh`. Retain its structured
  result and PR link. A standalone `gh api` success does not validate delivery
  policy, App write permissions, the Git helper or wrapper admission.
- Observe at least two renewals and a delivery after the original token's
  one-hour lifetime. The container start timestamp must stay unchanged during
  those renewals. Confirm no token prefixes are added to refresh logs.
- Simulate renewal failure in a test environment: the last file is retained,
  and delivery blocks once it reaches the validity margin. Restore renewal and
  verify recovery without restarting the container.

## Rollback and verification scope

If the image needs rollback, pause autonomous delivery through its existing
enablement setting, drain active runs and restore the previous image/configuration
using the normal deployment process. Do not substitute an operator PAT as the
bot or resume an expired startup token. The publisher may keep renewing the
file while delivery is paused. Resume only after the selected consumer has a
verified working credential path.

Focused tests from the repository root:

```sh
pnpm --filter @paperclipai/adapter-utils exec vitest run src/delivery-token.test.ts src/delivery-hook.quantum-wrapper.test.ts src/delivery-hook.test.ts src/delivery-hook.issue-link.test.ts
python3 scripts/refresh-delivery-token.test.py
```

Before deployment, also run the repository's complete typecheck, test and build
gates and verify the exact resulting image. Offline token fixtures and mocked
process/HTTP tests do not establish live GitHub permissions or server rollout.
