# Docker and Portainer

Run LearnHarness in one container with separate website and authenticated API
ports. Its startup script runs the backend on container loopback and a gateway
that forwards both published ports to it. Both use the same container; only the
backend owns the state volume. The image uses Node 24
on Debian Bookworm, runs as the non-root `node` user (UID/GID 1000), and includes
Chromium for generated demo verification. Native PDF/SVG renderers, prompts,
and static assets are included in the standalone application payload.

This setup targets **Docker Standalone with Docker Compose v2**, including
Portainer's Docker Standalone stacks. It does not configure Docker Swarm.

For separate users with their own API keys, sessions, and history, use the
[multiple-user deployment](#multiple-users-with-isolated-history) below. The
original [`compose.yaml`](../compose.yaml) remains the single-user setup.

## Images on GitHub Container Registry

The Docker workflow publishes these **Linux amd64** images after its build and
container smoke checks pass on the `docker/0.3.8` branch:

| Image | Purpose |
| --- | --- |
| `ghcr.io/aki-mizu/learnharness:docker-0.3.8` | Updated on successful branch builds; the Compose default |
| `ghcr.io/aki-mizu/learnharness:sha-<full-commit-sha>` | Identifies the image built from a specific commit |

Push the branch with its Docker changes to GitHub and wait for the **Docker**
workflow to finish before deploying. Adding these files locally does not create
an image in GHCR. Pull requests build and test without publishing; `main` also
only builds and tests. This workflow does not move the existing `v0.3.8` tag or
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
2. Set **`LH_SERVER_API_KEY`** to a random secret. For example, generate one
   locally with `openssl rand -hex 32`, then paste it into Portainer's stack
   environment variables. This is a server access key, separate from OpenRouter
   and custom model-provider keys. The gateway refuses to start without it.

   The website keeps its existing binding: port `3000` on all interfaces by
   default. The API has its own port, `3005` by default. Stack variables are:

   | Variable | Value |
   | --- | --- |
   | `LH_SERVER_API_KEY` | Required: the secret clients send to the API port |
   | `BIND_IP` | Defaults to `0.0.0.0` (all interfaces). Set a LAN/VPN IP to restrict the interface, or `127.0.0.1` for a reverse proxy running on the host |
   | `HOST_PORT` | Website port; defaults to `3000`. Keep your existing value, such as `3004` |
   | `API_BIND_IP` | API interface; defaults to `0.0.0.0` |
   | `API_PORT` | Separate API port; defaults to `3005` |
   | `LEARNHARNESS_IMAGE` | Optional: override the default image, for example to pin `ghcr.io/aki-mizu/learnharness:sha-<full-commit-sha>` |

3. Ensure the image is published and accessible, then deploy the stack.
   Compose pulls from GHCR on deployment by default. For a private package,
   configure Portainer's registry credentials as described above.
4. Open `http://<server-ip>:3000`, or use your existing `HOST_PORT`, for the
   website. LAN access is preserved and no browser sign-in is added. In Settings,
   add provider API keys and configure the strong, cheap, and vision model slots.
5. In Portal's **Settings → LearnHarness**, use `http://<server-ip>:3005` (or your
   chosen `API_PORT`) and enter the **Server API Key**. Portal saves the key in
   the device Keychain. Disconnect removes the saved key.

For the existing website on port `3004`, keep `HOST_PORT=3004` and add
`API_PORT=3005` plus `LH_SERVER_API_KEY`. The named data volume stays the same.

Each port number appears once in Compose. YAML anchors reuse the gateway's
container ports, and the healthcheck reads its process environment. The backend
uses the port already configured in the image. Change the published ports using
`HOST_PORT` and `API_PORT`; container port targets can stay as supplied.

The same Compose file can be used without Portainer:

```bash
export LH_SERVER_API_KEY='<your-random-server-key>'
HOST_PORT=3004 API_PORT=3005 docker compose up -d --wait
```

For private images outside Portainer, run `docker login ghcr.io` first with
your GitHub username and a token with `read:packages`.

To use an image built locally on the target Docker host instead of GHCR, set
both overrides:

```bash
LEARNHARNESS_IMAGE=learnharness:local LEARNHARNESS_PULL_POLICY=never \
  HOST_PORT=3004 API_PORT=3005 docker compose up -d --wait
```

The website port retains its current access boundary, including the same-origin
APIs it needs for browser chat, settings, and downloads. **Expose only the API
port publicly.** Keep the website port on your LAN/VPN; it remains accessible
without a key. The API port accepts only `/api` and `/api/*`, requires
`Authorization: Bearer <LH_SERVER_API_KEY>` for every method and stream, and
returns `404` for website routes. Missing or incorrect keys return `401`.
Keys in query strings or cookies do not authenticate the API port.

For public access, terminate HTTPS at a reverse proxy pointing to the **API
port**. Tailscale clients can use the server's Tailscale address instead. For a
reverse proxy in another container, configure a shared Docker network and its
upstream appropriately; that container's `127.0.0.1` is not the LearnHarness
container or Docker host. The Next.js backend listens only on loopback inside
the LearnHarness container; both published listeners belong to its gateway.

Check API access from a shell with the key in an environment variable:

```bash
curl -fsS -H "Authorization: Bearer $LH_SERVER_API_KEY" \
  http://<server-ip>:3005/api/chats
```

Change `LH_SERVER_API_KEY` in the stack and redeploy to rotate it, then reconnect
Portal with the new key. The gateway does not store this key in the data volume
or expose it through provider-key settings. Plain `npm start` still serves the
combined website/API listener; the split authenticated entry point is provided
by this gateway deployment.

A reverse proxy must pass SSE responses without buffering and allow long-lived
connections. With nginx, use `proxy_buffering off` and a suitable
`proxy_read_timeout` for `/api/` traffic. HTTPS is also needed for browser
microphone access when using dictation from a phone or another remote device.

## Multiple users with isolated history

Use [`compose.multiuser.yaml`](../compose.multiuser.yaml) **instead of**
`compose.yaml`. It runs one shared gateway and one worker container per user.
All API clients use the same API address; the bearer key selects the user's
worker. Each worker has its own sessions, history, knowledge graph, jobs,
settings, provider keys, and subscription connections in a separate volume.

The supplied file configures two users:

| User | API key variable by default | State volume | Initial data |
| --- | --- | --- | --- |
| `primary` | `LH_SERVER_API_KEY` | `learnharness_state` | Existing single-user data when the stack/project name is preserved |
| `secondary` | `LH_SECONDARY_API_KEY` | `secondary_state` | Empty workspace |

Generate a distinct key for each user with `openssl rand -hex 32`. By default,
the two key anchors at the top of the file read the variables in the table.
You can instead paste each key **once** directly into those two lines:

```yaml
x-primary-api-key: &primary_api_key "PASTE_PRIMARY_KEY_HERE"
x-secondary-api-key: &secondary_api_key "PASTE_SECONDARY_KEY_HERE"
```

Replace the placeholder values with your generated keys and keep the anchor
names. The YAML aliases reuse each value for its worker, gateway routing, and
website selection. No other key values need editing, and the two key variables
are unnecessary when using inline values. The `apiKeyEnv` fields in
`LH_SERVER_USERS` name gateway environment variables; the gateway resolves the
keys from those aliases, so the secrets do not need JSON escaping. The keys
grant access to LearnHarness; each user configures their own model provider
keys and model slots separately.

In Portainer, paste `compose.multiuser.yaml` into the stack's Web editor and
either set both key variables or replace the two anchor values as shown above.
Keep your existing `HOST_PORT`, `API_PORT`, interface, image, and stack-name
settings. This version of the file requires an image with `apiKeyEnv` support;
wait for that image to publish, or build locally.

The unauthenticated website opens one configured user's workspace. Choose that
user in the gateway's YAML environment:

```yaml
LH_WEB_API_KEY: *primary_api_key
```

Change the alias to `*secondary_api_key` and redeploy to show secondary instead.
The selected key must match a user resolved from `LH_SERVER_USERS`; an unknown
selection prevents gateway startup. No browser login or user picker is added.
Everyone who can reach the website port can view and change the selected user's
workspace, so keep that port on your LAN/VPN. Changing the website selection
does not move or merge either user's data. Reload open browser tabs after
changing it.

The public API continues to require `Authorization: Bearer <key>` on every
request and stream, and accepts only `/api` and `/api/*`. A request using
primary's key cannot read secondary's chat by its ID: it reaches primary's
worker, where that chat is absent. Each user also has a separate event stream
and independent background work.

Only the shared gateway publishes host ports. Each worker keeps Next on
container loopback and exposes a private listener that requires its own key
for **every** path, including pages and static assets. This also prevents one
worker's web tools from reading another worker over the Docker network without
its key. Workers receive only their own key and state volume; the gateway has
the routing map and no application state volume. Keep these boundaries when
customizing the stack: do not mount other users' state into a worker or publish
its raw Next backend.

To deploy from the command line with the default environment-backed anchors:

```bash
export LH_SERVER_API_KEY='<primary-random-hex-key>'
export LH_SECONDARY_API_KEY='<secondary-random-hex-key>'
HOST_PORT=3004 API_PORT=3005 \
  docker compose -f compose.multiuser.yaml up -d --wait
```

Local image overrides (`LEARNHARNESS_IMAGE` and `LEARNHARNESS_PULL_POLICY`)
work the same way as the single-user file. Users connect Portal to the same
API URL with their respective key. To configure secondary through the web UI,
select its key in YAML, redeploy, and open Settings; API clients can also use
the existing settings and provider endpoints with their own bearer key.

### Keep existing data when switching

The primary worker reuses the existing `learnharness_state` volume and its
unchanged `/state/data` and `/state/auth.json` paths. Its existing sessions,
provider keys, and subscription credentials stay together. Secondary gets a
new volume with no copied history or credentials.

Before switching an existing stack, stop its old `learnharness` service and
back up its state volume. Replace the stack YAML while keeping the same stack
name and `LH_SERVER_API_KEY`. Remove the stopped old container so it releases
the published ports; keep the volume. Deploy the new gateway, primary, and
secondary services. Never run the old backend and primary against the same
volume concurrently.

For a CLI deployment, run this while the old `compose.yaml` is still available,
then start the replacement services with the same project name:

```bash
docker compose stop learnharness
docker compose rm -f learnharness
docker compose -f compose.multiuser.yaml up -d --wait
```

If the existing project uses `-p`, `COMPOSE_PROJECT_NAME`, a renamed volume,
or a bind mount, preserve that choice when switching. Removing volumes with
`down --volumes` would delete the saved data.

### Add users and rotate keys

To add another user, add a key anchor, a worker service using `*worker` and
`*worker_environment`, and a new state volume. Pass the key alias to that
worker's `LH_SERVER_API_KEY` and to a separate gateway environment variable.
Add its stable user ID, that gateway variable's name as `apiKeyEnv`, and its
worker URL to `LH_SERVER_USERS`, and add the worker to the gateway's
`depends_on`. Every user must have a distinct key and a separate worker and
volume. Redeploy after changing the configuration.

To rotate a key, change that user's inline anchor value or its default key
variable and redeploy the gateway and worker, then update the user's clients.
Preserve the user ID, service, and volume to retain its history. The YAML key
aliases keep the selected website and worker credentials aligned when the
value changes. User IDs contain
1–64 letters, digits, underscores, or hyphens and start with a letter or digit.
The gateway refuses duplicate keys, user IDs, or upstream origins. Removing a
user from the routing map removes API access; retain their volume if the data
should be kept.

The gateway healthcheck probes every configured user's API route. Each worker
also checks its own authenticated listener and backend. A worker failure
affects that user's requests and health status; the other workers keep their
own state and processes.

## Persistent data

The single-user stack mounts one named volume at `/state`. The multiple-user
stack mounts a separate volume at `/state` in each worker. Each contains:

| Path | Contents |
| --- | --- |
| `/state/data` | Sessions, graph ledgers, jobs, settings, and prompt overrides |
| `/state/auth.json` | Provider API keys saved through Settings; created with mode `0600` |
| `/state/chatgpt-credentials.json` | Server-owned ChatGPT connection credentials; mode `0600` |
| `/state/github-copilot-credentials.json` | Server-owned GitHub Copilot connection credentials; mode `0600` |
| `/state/xai-credentials.json` | Server-owned Grok connection credentials; mode `0600` |

Subscription credential files are created beside the configured `LH_AUTH_FILE`,
so the supplied stack preserves them in the same `/state` volume. Browsers using
the same user's workspace share its saved connections and background-use consent.

The named volume is initialized with ownership for UID/GID 1000. If you replace
it with a bind mount or restore files, make that directory writable by UID/GID
1000. Mount the directory, not just `auth.json`: key updates use atomic file
replacement in the same directory.

Run **one LearnHarness container per data volume**. The container has one
backend process; its gateway does not read or write application data. Storage
and running-turn registries are single-process; multiple replicas must not share the volume.
Back up the entire volume while the container is stopped for a consistent
copy. Backups contain provider credentials as well as learning records.

Data survives container replacement and `docker compose down`. Removing the
volume, including `docker compose down --volumes`, deletes the saved data.
Keep the Portainer stack name unchanged when updating so its volume is reused.

## Update and verify

After the branch's updated image is published, redeploy the Portainer stack
and pull the image again. Preserve its named volume. Updates require a
redeployment; running containers do not update automatically when a tag changes.

For a multiple-user stack, keep `compose.multiuser.yaml`, its gateway and worker
services, key settings, and all user volumes. Update every service to the same
image version and redeploy. From the CLI, keep the existing project name and
run `docker compose -f compose.multiuser.yaml up -d --force-recreate --wait`.

The older-stack migration instructions below apply to the **single-user**
deployment. When updating an older two-container single-user stack, replace
its Compose configuration with the current single-service `compose.yaml`.
Before deploying, stop and remove the old
`<stack-name>-gateway-1` container in Portainer so it releases the website and
API ports. Keep the stack name, existing port variables, API key, and named data
volume. Do not remove the volume. The updated stack starts only
`<stack-name>-learnharness-1`, which serves both ports.

Without Portainer, use the same `BIND_IP` and `HOST_PORT` values as the first
deployment. If migrating the single-user stack from the old two-service file,
stop its `gateway` service before replacing the file, then run:

```bash
HOST_PORT=3004 API_PORT=3005 docker compose up -d --remove-orphans --force-recreate --wait
```

If you pinned a commit image, change `LEARNHARNESS_IMAGE` to the desired commit
tag before redeploying. For local builds, rebuild `learnharness:local` first and
keep `LEARNHARNESS_IMAGE=learnharness:local` and
`LEARNHARNESS_PULL_POLICY=never` set during recreation.

The container healthcheck probes the gateway's API listener with the configured
server key and reaches the backend's `/api/graph`, checking both components.
The startup script waits for backend readiness before opening the published
listeners and stops both components when the container stops or either fails.
The complete container smoke test uses a separate project and temporary named
volume; it checks the published port,
non-root startup, both published ports, missing/wrong-key rejection, website
route isolation on the API port, static assets, API writes, SSE, native PDF/SVG rendering,
Chromium, and persistence after replacing the container:

```bash
docker build -t learnharness:local .
node scripts/smoke-docker.mjs
```

The smoke test uses a dummy key, makes no model/provider requests, and removes
only its own temporary containers and volume. It explicitly uses the local
image and never pulls from GHCR. The Docker GitHub Actions workflow runs this
test before tagging and pushing that same image to GHCR on the Docker branch.

The multiple-user smoke test runs after that image check in CI. To run both
locally after building the image:

```bash
node scripts/smoke-docker.mjs
node scripts/smoke-docker-multiuser.mjs
```

The additional test uses a separate temporary project with dummy keys. It
first verifies that switching from the single-user stack preserves primary's
existing session and leaves secondary empty. It checks separate histories, graphs, jobs, settings,
and provider keys; authenticated worker ingress with no raw Next or
unauthenticated worker web port; each user's SSE events; persistence after
recreating containers; switching the website's selected user through YAML; and
rotating secondary's key while preserving its volume. It makes no model or
provider requests and removes only its own temporary containers and volumes.
Native renderer and Chromium checks remain in the original image smoke test.

## Differences from the desktop app

Provider API keys and server-owned subscription connections are available in
Settings → Providers. GitHub Copilot and Grok use device-code sign-in in your
browser. ChatGPT sign-in requires its browser callback to reach `127.0.0.1` in
the server's network namespace. In Docker that is the container's loopback;
the supplied stack does not route this callback from a host or remote browser.
See [subscription connections in web/dev](development.md#subscription-connections-in-webdev)
for the upstream sign-in and shared-server limitations.

Desktop menus and in-app application updates require Electron. Update the
container by pulling or building its replacement image and redeploying.
