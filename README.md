# Docker plugin for Ervisio

Manage Docker from [Ervisio](https://github.com/Ervisio/ervisio): containers, Compose stacks, images, volumes and
networks, with live stats, logs, a shell in containers, a create/edit wizard, templates, private registries,
automatic updates, alerts and clean-up.

Until Ervisio 0.3.0 this plugin shipped inside Ervisio. It now lives here and is installed from the Ervisio
marketplace; the build published there is signed by the Ervisio team.

## Install

In Ervisio, open Plugins › Browse, find Docker and choose Install. The dialog lists the permissions below; the plugin
is signed with the Ervisio team key and Ervisio verifies the signature before installing. Updates appear in
Plugins › Updates.

## Permissions

The manifest is [plugin/manifest.json](plugin/manifest.json). In short:

* **Docker Engine API** on `/var/run/docker.sock` (`capabilities.http`, named `docker`): only the methods and paths
  listed in its rules (containers, exec, images, volumes, networks, system information, events, prune, registry
  login and image digest lookups). It is an `admin` entry: members
  of the `docker` group use it as themselves, other administrators unlock administrator rights. Access to the Docker
  API is equivalent to root on the machine.
* **Commands**, all `admin` with `adminUnlessGroup: docker`: `docker compose` (up, pull, down, restart, stop, start,
  config, ls) for stacks, `install -d -m 2775 -g docker /opt/stacks` to create the stacks folder, and `shell`, a terminal (`pty`) running
  `docker exec -it <container> <shell>`. Every command talks to `unix:///var/run/docker.sock`.
* **Folders**: `/opt/stacks` (read and write, `admin`, for Compose stacks) and `~/.config/ervisio/plugins/docker`
  (created on first use; settings, registries, alerts, template sources).
* **Network**: the plugin frame may fetch template lists from `raw.githubusercontent.com` and
  `gist.githubusercontent.com`.
* **Visible to** members of `docker`, `wheel` and `sudo` (administrators always see it).

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run build       # typecheck, bundle to dist/docker/index.js, copy plugin/* next to it
npm run dev         # rebuild on change
npm run pack        # dist/docker-<version>.tar.gz and .sha256 (what a release publishes)
```

Turn on developer mode in Ervisio (`plugins.dev = true`, or a daemon started with `--dev`) and load `dist/docker` from
Plugins › Developer; after a rebuild use "Reload" there. A dev folder runs unsigned while developer mode is on. If
the marketplace Docker plugin is installed, uninstall it first (the ids would clash).

The SDK types, the React shim and the Vite preset come from
[@ervisio/plugin-sdk](https://github.com/Ervisio/plugin-sdk) (a git dependency for now; `.npmrc` allows it for npm
12). Its [documentation](https://github.com/Ervisio/plugin-sdk/blob/main/docs/sdk.md) describes the SDK object.

## Releasing

1. Set the version in `plugin/manifest.json` and `package.json`, add a `## X.Y.Z` section to `CHANGELOG.md` (say
   when a release asks for new permissions, and why).
2. Commit, then `git tag -a vX.Y.Z -m "X.Y.Z" && git push origin vX.Y.Z`.
3. The release workflow builds, validates the manifest with Ervisio's own validator and publishes
   `docker-X.Y.Z.tar.gz` and its `.sha256` (unsigned).
4. The Ervisio plugin registry, [Ervisio/plugins](https://github.com/Ervisio/plugins), picks the release up within a
   few hours and opens a pull request with the permission changes; a maintainer can run its "Sync" workflow by hand
   for a faster pickup. After review and merge the registry signs the plugin and publishes it in the catalog.

This repository holds no secrets and never signs anything.

## How it fits together

React is not bundled. The preset in `vite.config.ts` aliases `react` and the JSX runtime to the SDK's shim
(`@ervisio/plugin-sdk/react`), which forwards to `sdk.react`. The SDK exists only inside `activate()`
(`src/index.ts`), so:

* Never call a React API at module top level (`createContext`, `memo`, `forwardRef`, `lazy`). Hooks and JSX inside
  components are fine.
* Read the SDK with `getSdk()` (`src/sdk.ts`) inside functions, never at import time.
* Use the kit through `src/kit.ts` (`Button`, `Dialog`, `ConfirmDialog`, `toast`, ...), not `sdk.ui` directly.

```
plugin/manifest.json  the manifest (unsigned; the registry adds "files" and signs)
plugin/templates.json the curated template catalog, shipped and signed with the plugin
src/index.ts          activate: sets SDK and React, strings, styles, icons; registers the page and the widget
src/sdk.ts            SDK v3 types and getSdk() (re-exported from @ervisio/plugin-sdk)
src/kit.ts            typed wrappers for the app's UI kit
src/router.ts         in-plugin router (Route type, navigate, back, useRoute, search box state)
src/api/              Docker Engine client and data layer
  engine.ts           docker.get/post/delete/stream, version negotiation, DockerError, classify()
  streams.ts          JsonLines, LogDemuxer, LogLines
  stats.ts            CPU/memory math and shared per-container stats streams
  events.ts           one shared /events stream
  store.ts            createResource(): polled + event-refreshed shared store
  resources.ts        containers, images, volumes, networks, info, diskUsage stores
  hooks.ts            useStats, useDockerEvents, useAsync
  actions.ts          start/stop/restart/remove, runBulk
  model.ts            stack grouping, health, ports, filters
  format.ts           bytes, percent, durations, relative time
src/settings.ts       JSON files in ~/.config/ervisio/plugins/docker (settings, registries, alerts, templates-sources)
src/i18n/areas/*.ts   strings, one file per area, merged automatically
src/styles/*.css      CSS, every file is injected automatically
src/ui/               shared pieces: PageHeader, DataTable, DiskBar, StatusDot, Charts, ErrorState, ComingSoon
src/shell/App.tsx     inner sidebar, search box, error gate
src/views/            one component per route, ViewHost in registry.tsx
```

## Add or fill a view

1. The route exists in `src/router.ts` (`Route`). For a new one, add it there, add its nav section in `sectionOf`,
   and render it in `src/views/registry.tsx`.
2. Edit the view file in `src/views/`. Its props are the route fields: `RouteProps<'container'>` is `{ id, tab? }`.
   Start with `<PageHeader icon title subtitle actions back />`.
3. Strings: create `src/i18n/areas/<area>.ts` exporting `{ en, it }` with keys `<area>.something`. Use `t('key')`.
4. Styles: create `src/styles/<area>.css`. Prefix classes with `dk-`, use theme variables only (`--surface`, `--sunk`,
   `--ink*`, `--acc`, `--ok`, `--warn`, `--err`, `--h`/`--s` inside a `hue-*` element, radii `--r-*`). No grey lines.
5. Data: `const { data, error, loading } = containers.use()` for shared lists; `docker.get/post/delete` for the rest;
   `docker.stream` for logs, stats and pulls. Tell the user about failures with `toast.err(title, errorText(e))`.
6. Go to another view with `navigate({ view: 'container', id })`; `navigate(route, { root: true })` starts a fresh history.
   `back()` goes back.

Every Engine path a view uses must be allowed by a rule in `plugin/manifest.json` (`capabilities.http`).

## License

MIT, see [LICENSE](LICENSE).
