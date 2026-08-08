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

## Build order

The backend image bundles a prebuilt frontend, so the frontend release has to
exist first:

1. **frontend** — tag `3.2.1-fed.1`, or run *Release frontend* manually. Produces
   `remnawave-frontend.zip` on a GitHub release.
2. **backend** — tag `3.2.1-fed.1`. Needs a `FRONTEND_READ_TOKEN` repository
   secret: a PAT with read access to the private frontend repo, because the
   built-in `GITHUB_TOKEN` is scoped to a single repository.
3. **node** — tag `3.0.0-fed.1`.
4. **subscription-page** — tag `8.0.0-fed.1`.

Each workflow also accepts `workflow_dispatch` if you would rather not tag.

To build the backend locally, fetch the frontend zip into the build context
first — the Dockerfile expects it there:

```sh
./scripts/fetch-frontend.sh          # or: ./scripts/fetch-frontend.sh 3.2.1-fed.1
docker build -t remnawave-backend:local .
```

## Pulling private images on the servers

All four repos are private, so their GHCR packages are private too and an
anonymous `docker pull` will 404. On each server, log in once with a PAT that
has `read:packages`:

```sh
echo "<PAT>" | docker login ghcr.io -u mikyllyn --password-stdin
```

The credential lands in `/root/.docker/config.json` and survives reboots. If you
would rather not manage tokens on the hosts, make the packages public in the
GitHub package settings — that is independent of the repositories staying
private.

## Compose changes

Only the image references change; the rest of your compose files stay as they
are.

```yaml
# panel host
services:
  remnawave:
    image: ghcr.io/mikyllyn/remnawave-backend:3.2.1-fed.1
  remnawave-subscription-page:
    image: ghcr.io/mikyllyn/remnawave-subscription-page:8.0.0-fed.1
  remnanode:
    image: ghcr.io/mikyllyn/remnawave-node:3.0.0-fed.1
```

## Upgrading from the 2.8-based Fedarisha build

Read this before pulling — 3.0.0 is a breaking release.

- **Acknowledge the breaking changes.** 3.0.0 refuses to start without the
  acknowledgement environment variable; the panel logs the exact name and value
  on first boot.
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
  `XRAY_CORE_VERSION` build args, currently `v26.6.1-fed.2`. Upstream node 3.0.0
  ships Xray `v26.7.28`; the Fedarisha fork has that revision on `main` but has
  not tagged a release for it. To close the gap, sync `Xray-core-fedarisha`,
  tag it, and repin those build args.

## CI notes

- Workflows publish to GHCR only, authenticating with the built-in
  `GITHUB_TOKEN`. No Docker Hub account or extra secret is needed, except
  `FRONTEND_READ_TOKEN` on the backend.
- Images are built for `linux/amd64` and `linux/arm64`. Private-repo Actions
  minutes are metered, and the ARM runner bills at a higher rate — if every
  server is x86, drop the `linux/arm64` entry from the matrix in each workflow
  and halve the build cost.
