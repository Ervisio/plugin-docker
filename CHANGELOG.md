# Changelog

## 2.2.0

Draft, 2026-10-03. Needs Ervisio 0.5 or later.

### Containers

* New Attach tab: connect to the main process of a container in the same terminal as Shell. Ctrl+P then Ctrl+Q
  detaches and leaves it running.
* New Files tab: browse any folder of a container (also a stopped one, and images without `ls`), read text files,
  create folders and delete files. Upload a file of any size with progress, download a file under its own name, and
  download a folder as a `.tar`.
* "Save as image" (`docker commit`) with a name, tag, comment, author and optional Dockerfile lines.
* The create and edit wizard has a "Resources and devices" step: memory, CPU, GPU, devices, capabilities, ulimits and
  sysctls, plus the init process and the Interactive and TTY switches.
* Logs, exports and settings now save through the browser. Nothing is written to `~/.config/ervisio/plugins/docker`
  for them any more.

### Images

* Build image page: from a Dockerfile you write, from files, a folder or an archive of any size, or from a Git URL,
  with live output, several tags, build arguments, target stage and platform. Saved registry logins are sent with the
  build.
* Push an image to a registry, and add or remove tags without deleting the image.
* Export one image, several, or all tags of one image as a `.tar`, and import a `.tar` or `.tar.gz` of any size.

### Volumes

* Each volume has a page with a read-only file browser, a backup (download the whole volume as a `.tar`) and a
  restore (upload a `.tar` or `.tar.gz`, optionally empty the volume first, optionally stop the containers that use
  it and start them again).
* One Back up menu on every volume: download now, restore from a file, or schedule.
* Scheduled backups: every hour to week, or at a time of day, keep the newest N, with a notification of your choice.
  Each backup is a tar file in `/var/backups/ervisio-docker/<volume>/`.
* Backups and restores use a short-lived busybox helper container that is removed when the work ends.

### Stacks

* The `.env` tab is an editor for variables: a table with hidden secrets, import by paste or file, checks for
  mistakes, and hints for variables that `compose.yaml` uses but `.env` does not set. An Advanced mode edits the raw
  text. The Diff tab compares `.env` with the last deploy.
* New stack from a Git repository (https, http or ssh; no sign-in, an access token or a deploy key). The stack page
  shows the commit, checks for updates and pulls and redeploys. Tokens and keys stay in your private plugin folder.
  Editing a Git stack warns that the next update replaces the change. Detach from Git keeps the files.
* Automatic updates for Git stacks: pick an interval or a time of day and when to be told. A background job pulls and
  redeploys even when nobody has Ervisio open.
* Redeploy webhooks on every stack and container: a web address that a registry or a CI job can call. Make a new
  address or revoke it any time.
* Compose files in a sub-folder of a Git stack are handled when moving and deleting.

### Templates

* Custom templates: make one from scratch, from a stack or from a container, edit, duplicate, delete, export and
  import (also a Portainer v2 or v3 list). They are shared with everyone who uses Docker on this machine.
* Variables can offer a fixed list of choices as a drop-down.

### Environments

* Work on other Docker hosts: another Ervisio server, a Docker API over TLS, SSH, or a Portainer Agent (add them in
  Settings > Environments of Ervisio). Containers, images, volumes, networks, logs, stats, terminals, files,
  transfers, build and stacks act on the host you opened.
* An Environments page shows one card per host with its status, engine, running and stopped containers, stacks and
  CPU and memory use.
* Stacks of a TLS, SSH or Portainer host keep their files on this server in `/opt/stacks/.envs/<id>/`.
* Git stacks, redeploy webhooks, automatic updates and scheduled backups run on this server only. On another host the
  plugin says so instead of showing them.

### Automation

* Alert rules can also send through the notification channels set up in Ervisio (email, Telegram, ntfy, Gotify,
  webhook), with a test button on the Alerts page.
* Background jobs run as the user who created them, and need no administrator approval for members of `docker`.

### Activity

* New page under Tools: what was done through the plugin, with time, user, action, target, host and result. Filter by
  host, user, action and dates, load older entries, and export to CSV.

### Portainer import

* Tools > Import from Portainer reads the Portainer database through the Docker API and imports stacks (Git stacks
  stay Git stacks), registries and custom templates. Portainer logins are copied only after you say so. It lists what
  each Portainer environment could become in Ervisio. Works on this server only.

### Settings backup

* Settings > Export settings and Import settings: one JSON file with saved registries (passwords optional), custom
  templates, template sources, alert rules, auto-update settings and preferences. An import shows what is new,
  replaced or unchanged before it writes anything.

### Permissions

* New: `GET /images/get` and `POST /images/load`, `PUT` and `GET` on `/containers/<id>/archive`, `POST /commit`, uploads
  up to 1 TiB, the `attach` command, Git and backup commands, background jobs and notifications. The Docker API and its
  commands can now run against another environment.

## 2.1.0

* Stacks started by Portainer now work. Portainer runs `docker compose` inside its own container, so a stack's folder
  (`/data/compose/<id>`) lives in Portainer's volume and not on the host. Ervisio finds the container that mounts that
  folder, reads the compose file and the `stack.env` file through the Docker API and shows them read only, instead of
  an error. The same works for other tools that keep their stacks in a container.
* "Move to /opt/stacks" works for those stacks. It copies the compose file and the env file, and rewrites every relative
  bind mount (`./data:/data`) to the absolute host path the containers use now, so the data stays where it is. The
  dialog lists the files, every rewritten path, and what to do in Portainer afterwards.
* The container page can join and leave networks: it lists the connected networks with address, gateway and aliases,
  and offers an optional IPv4 address and aliases when joining. Containers in host, none or `container:` network mode
  are shown as fixed.
* New permission: `GET /containers/<id>/archive` on the Docker socket, to read files out of a container.

## 2.0.1

First release from its own repository. The features are those of the Docker plugin 2.0.1 that shipped inside
Ervisio 0.3.0: containers, Compose stacks, images, volumes and networks, live stats, logs, shell, templates, private
registries, automatic updates, alerts and clean-up. Settings stay in `~/.config/ervisio/plugins/docker`. The plugin is
now installed from the Ervisio marketplace and signed by the Ervisio team; the permissions are unchanged.
