# Publishing the GHCR image

The release image is `ghcr.io/robdeflop/7tv-discord-sync` (Linux/AMD64). The GitHub repository stays private. Publish only commits approved for release: the **image** contains the runtime source and can be inspected by anyone once public.

## Release gate

Push a new `v`-prefixed SemVer tag on the reviewed commit when ready to release. A tag push runs the suite and checks database migration and emote conversion inside the built image. Only after those checks pass does the publishing job log in with its package-write `GITHUB_TOKEN` and push that same image. Pull requests test only; ordinary branch pushes and merges cannot publish.

| Git tag | GHCR image tags |
| --- | --- |
| `v1.2.0` | `1.2.0`, `latest` |
| `v1.3.0-beta.1` | `1.3.0-beta.1` only |

`latest` tracks stable publications, not prereleases. Use a new version per release; don't move existing Git tags. Docker tags have a 128-character limit and don't support SemVer build metadata (`+...`). Invalid release refs are not published. To preview the policy locally (no tag creation, login or upload):

```sh
bash .github/scripts/release-tags.sh refs/tags/v1.3.0-beta.1
```

## One-time GHCR package setup

After the first successful publish, open the **7tv-discord-sync package** under RobDeFlop's GitHub profile → **Packages** → **Package settings**. Under **Danger Zone → Change visibility**, select **Public** and confirm. This makes only the container package public, not the repository. Public package visibility cannot be changed back to private. If the package already existed and the workflow cannot write to it, grant the source repository **Write** under the package's **Manage Actions access**; don't use a personal access token.

## Verify anonymous access

On a clean Linux Docker host without a GHCR login or credential helper, pull the exact released version. For example, after `v1.2.0`:

```sh
config=$(mktemp -d)
docker --config "$config" pull --platform linux/amd64 ghcr.io/robdeflop/7tv-discord-sync:1.2.0
rmdir "$config"
```

A successful pull reports the image digest and requires neither source access nor `docker login`. If denied, check **package** visibility and the exact image name and tag; do not change repository visibility.
