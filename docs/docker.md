# Docker and Portainer

Run the web UI and HTTP API together in one container. The image uses Node 24
on Debian Bookworm, runs as the non-root `node` user (UID/GID 1000), and includes
Chromium for generated demo verification. Native PDF/SVG renderers, prompts,
and static assets are included in the standalone application payload.

This setup targets **Docker Standalone with Docker Compose v2**, including
Portainer's Docker Standalone stacks. It does not configure Docker Swarm.

## Images on GitHub Container Registry

The Docker workflow publishes these **Linux amd64** images after its build and
container smoke checks pass on the `docker/0.3.7` branch:

| Image | Purpose |
| --- | --- |
| `ghcr.io/aki-mizu/learnharness:docker-0.3.7` | Updated on successful branch builds; the Compose default |
| `ghcr.io/aki-mizu/learnharness:sha-<full-commit-sha>` | Identifies the image built from a specific commit |

Push the branch with its Docker changes to GitHub and wait for the **Docker**
workflow to finish before deploying. Adding these files locally does not create
an image in GHCR. Pull requests build and test without publishing; `main` also
only builds and tests. This workflow does not move the existing `v0.3.7` tag or
publish a `latest` tag.

Publishing uses the repository's `GITHUB_TOKEN` with `packages: write`, so no
separate registry secret is needed. The OCI source label connects the package
to its repository. The namespace is derived from the repository running the
workflow; if you use another fork, set `LEARNHARNESS_IMAGE` to its GHCR path.

New GHCR packages are private by default, even for public repositories. Choose
one of these ways to let Portainer pull the image:

- **Public package:** after the first successful publish, open the package's
  settings on GitHub and change its visibility to public. Anonymous pulls then
  work without configuring registry credentials in Portainer.
- **Private package:** in Portainer's **Registries**, add `ghcr.io` using your
  GitHub username and a personal access token (classic) with `read:packages`.
  That GitHub account must have read access to the package. Make the registry
  available to the Portainer environment deploying the stack.

If an existing package denies workflow pushes, grant the repository write
access under the package's **Manage Actions access** settings.

## Build locally instead

On the Docker host managed by Portainer, run these commands from this checkout:

```bash
docker build -t learnharness:local .
```

The build installs dependencies from the lockfile, creates the production
standalone server, and runs its existing offline dependency and HTTP smoke
checks. Electron's binary download is skipped and Electron is removed from the
runtime payload. Local sessions, keys, `.env` files, and build outputs are
excluded from the Docker context.

Build for the server's CPU architecture. Native modules must be installed and
built for the target Linux architecture; do not copy a macOS `node_modules` or
`.next` directory into the image. CI currently exercises Linux x64.

The build needs access to npm, the container registry, Debian package mirrors,
and Google Fonts, which the existing application downloads during `next build`.
Provider API keys are not needed for building or smoke checks.

## Deploy with Portainer

1. Open **Stacks → Add stack → Web editor** and paste the repository's
   [`compose.yaml`](../compose.yaml).
2. Set these stack environment variables:

   | Variable | Value |
   | --- | --- |
   | `BIND_IP` | The server's LAN/VPN IP address, or `127.0.0.1` for a reverse proxy running on the host |
   | `HOST_PORT` | An unused host port, for example `3000` |
   | `LEARNHARNESS_IMAGE` | Optional: override the default image, for example to pin `ghcr.io/aki-mizu/learnharness:sha-<full-commit-sha>` |

3. Ensure the image is published and accessible, then deploy the stack.
   Compose pulls from GHCR on deployment by default. For a private package,
   configure Portainer's registry credentials as described above.
4. Open `http://<BIND_IP>:<HOST_PORT>`. In Settings, add provider API keys and
   configure the strong, cheap, and vision model slots needed by your workflow.

The same Compose file can be used without Portainer:

```bash
BIND_IP=127.0.0.1 HOST_PORT=3000 docker compose up -d --wait
```

For private images outside Portainer, run `docker login ghcr.io` first with
your GitHub username and a token with `read:packages`.

To use an image built locally on the target Docker host instead of GHCR, set
both overrides:

```bash
LEARNHARNESS_IMAGE=learnharness:local LEARNHARNESS_PULL_POLICY=never \
  BIND_IP=127.0.0.1 HOST_PORT=3000 docker compose up -d --wait
```

Web mode has no built-in user login. Bind it to a trusted LAN/VPN, or place it
behind an authenticated HTTPS reverse proxy. For a reverse proxy in another
container, configure a shared Docker network and its upstream appropriately;
that container's `127.0.0.1` is not the LearnHarness container or Docker host.
The web UI and `/api/*` endpoints share the same port and access boundary.

A reverse proxy must pass SSE responses without buffering and allow long-lived
connections. With nginx, use `proxy_buffering off` and a suitable
`proxy_read_timeout` for `/api/` traffic. HTTPS is also needed for browser
microphone access when using dictation from a phone or another remote device.

## Persistent data

The stack mounts one named volume at `/state`:

| Path | Contents |
| --- | --- |
| `/state/data` | Sessions, graph ledgers, jobs, settings, and prompt overrides |
| `/state/auth.json` | Provider API keys saved through Settings; created with mode `0600` |

The named volume is initialized with ownership for UID/GID 1000. If you replace
it with a bind mount or restore files, make that directory writable by UID/GID
1000. Mount the directory, not just `auth.json`: key updates use atomic file
replacement in the same directory.

Run **one container/process per data volume**. Storage and running-turn
registries are single-process; multiple replicas must not share the volume.
Back up the entire volume while the container is stopped for a consistent
copy. Backups contain provider credentials as well as learning records.

Data survives container replacement and `docker compose down`. Removing the
volume, including `docker compose down --volumes`, deletes the saved data.
Keep the Portainer stack name unchanged when updating so its volume is reused.

## Update and verify

After the branch's updated image is published, redeploy the Portainer stack
and pull the image again. Preserve its named volume. Updates require a
redeployment; running containers do not update automatically when a tag changes.
Without Portainer, use the same `BIND_IP` and `HOST_PORT` values as the first
deployment:

```bash
BIND_IP=127.0.0.1 HOST_PORT=3000 docker compose up -d --force-recreate --wait
```

If you pinned a commit image, change `LEARNHARNESS_IMAGE` to the desired commit
tag before redeploying. For local builds, rebuild `learnharness:local` first and
keep `LEARNHARNESS_IMAGE=learnharness:local` and
`LEARNHARNESS_PULL_POLICY=never` set during recreation.

The health check probes `/api/graph`. The complete container smoke test uses a
separate project and temporary named volume; it checks the published port,
non-root startup, static assets, API writes, SSE, native PDF/SVG rendering,
Chromium, and persistence after replacing the container:

```bash
docker build -t learnharness:local .
node scripts/smoke-docker.mjs
```

The smoke test uses a dummy key, makes no model/provider requests, and removes
only its own temporary containers and volume. It explicitly uses the local
image and never pulls from GHCR. The Docker GitHub Actions workflow runs this
test before tagging and pushing that same image to GHCR on the Docker branch.

## Differences from the desktop app

Provider API keys work in the container. ChatGPT, GitHub Copilot, and Grok
subscription sign-in depend on Electron's private IPC connection and are
unavailable in web-only deployments. Desktop menus and in-app application
updates are also Electron features; update the container by pulling or building
its replacement image and redeploying.
