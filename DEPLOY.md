# Deploying the Fedarisha-enabled Remnawave stack

Four repositories make up this stack, all forks of upstream Remnawave carrying
the Fedarisha downstream changes:

| Repo | Branch | Upstream base | Image |
|---|---|---|---|
| `remnawave-backend` | `fed-3.2.1` | 3.2.1 | `ghcr.io/mikyllyn/remnawave-backend` |
| `remnawave-frontend` | `fed-3.2.1` | 3.2.1 | release zip, bundled into the backend image |
| `remnawave-node` | `fed-3.0.0` | 3.0.0 | `ghcr.io/mikyllyn/remnawave-node` |
| `remnawave-subscription-page` | `fed-8.0.0` | 8.0.0 | `ghcr.io/mikyllyn/remnawave-subscription-page` |

Panel, frontend and node move together — the 3.x panel will not drive a 2.x
node. The subscription page is looser but is on 8.0.0 here regardless.

On top of the Fedarisha changes, the backend also carries a mihomo generator
fix: `XHTTP_FIELD_MAP` now maps `sessionPlacement` / `sessionKey` as well as the
upstream `sessionID*` spelling, so XHTTP configs written against the Fedarisha
core keep those fields when rendered for mihomo. It used to live as a `sed` over
the compiled JS in a layer on top of `voltara13/backend:dev`.

## Build order

The backend image bundles a prebuilt frontend, so the frontend release has to
exist first:

1. **frontend** — tag `3.2.1-fed.1`, or run *Release frontend* manually. Produces
   `remnawave-frontend.zip` on a GitHub release.
2. **backend** — tag `3.2.1-fed.2`. Pulls the frontend release using the
   built-in `GITHUB_TOKEN`; no extra secret is needed while both repos are
   public.
3. **node** — tag `3.0.0-fed.2`.
4. **subscription-page** — tag `8.0.0-fed.1`.

Each workflow also accepts `workflow_dispatch` if you would rather not tag.

To build the backend locally, fetch the frontend zip into the build context
first — the Dockerfile expects it there:

```sh
./scripts/fetch-frontend.sh          # or: ./scripts/fetch-frontend.sh 3.2.1-fed.1
docker build -t remnawave-backend:local .
```

## Pulling the images

All four repos and their GHCR packages are public, so the servers pull
anonymously — no `docker login` required.

If a package is ever flipped back to private, each server needs a one-off login
with a PAT carrying `read:packages`:

```sh
echo "<PAT>" | docker login ghcr.io -u mikyllyn --password-stdin
```

The credential lands in `/root/.docker/config.json` and survives reboots.

## Compose changes

Only the image references change; the rest of your compose files stay as they
are.

```yaml
# panel host
services:
  remnawave:
    image: ghcr.io/mikyllyn/remnawave-backend:3.2.1-fed.2
  remnawave-subscription-page:
    image: ghcr.io/mikyllyn/remnawave-subscription-page:8.0.0-fed.1
  remnanode:
    image: ghcr.io/mikyllyn/remnawave-node:3.0.0-fed.2
```

## Upgrading from the 2.8-based Fedarisha build

Read this before pulling — 3.0.0 is a breaking release.

- **No new environment variables.** `APP_SECRET` became required outright where
  2.8 declared it optional, but the JWT module already read it through
  `getOrThrow` back then, so any working 2.8 install already sets it. Nothing
  else in the env schema gained a requirement. The container entrypoint just
  runs `prisma migrate deploy` and the seeder — there is no acknowledgement flag
  gating startup.
- **Back up the database first.** The migration renames `users.t_id` to
  `users.id` and drops `users.uuid` outright. It is not reversible by
  downgrading the image.
- **Fedarisha PAKs get re-minted.** The node names each per-user S3
  sub-credential `<userUuid>-<sha1(inboundTag)>`. That `userUuid` used to be
  `users.uuid`, which no longer exists, so it is now `users.vlessUuid`. Stored
  PAK payloads in `user_meta` survive, but the handles derived from the old
  column cannot be recomputed: on first probe each user is issued a fresh
  sub-credential, and the superseded keys stay behind on the S3 provider.
  Sweep them manually in the Selectel/VK console once the panel is healthy.
- **Xray core.** The node image pins the Fedarisha core via `XRAY_CORE_REPO` /
  `XRAY_CORE_VERSION`, currently `mikyllyn/Xray-core-fedarisha` at
  `v26.7.28-fed.1` — the Xray version upstream node 3.0.0 expects. That tag was
  cut in our own fork because Fedarisha has published no core release since
  `v26.6.1-fed.2` (17 Jun) despite carrying the newer revision on `main`. When
  they do tag again, point the build args back at their repo.

## CI notes

- Workflows publish to GHCR only, authenticating with the built-in
  `GITHUB_TOKEN`. No Docker Hub account and no extra secrets.
- Images are built for `linux/amd64` and `linux/arm64`. Both runners are free
  on public repositories, so the second architecture costs nothing; drop the
  `linux/arm64` matrix entry if you ever want faster builds.
