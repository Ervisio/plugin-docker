# Changes from the envs branch (feat/envs)

Needs Ervisio 0.5 (environments) and plugin SDK 0.2. On an older console the plugin works as before, on this server only.

- Environments: the plugin works on other Docker hosts: another Ervisio server, a Docker API over TLS, SSH, or a Portainer Agent (add them in Settings > Environments of Ervisio). Containers, images, volumes, networks, logs, stats, the terminal, attach, the file browser, build and stacks all act on the host you opened.
- Environments home: with more than this server, the plugin opens on an Environments page, one card per host: kind, engine, status (Online, Online but limited, Offline), running and stopped containers, stacks, CPU and memory in use, a note about what is limited or why the host is offline, and Open (or Try again and Edit when it is offline). Numbers refresh every 30 seconds while the page is visible. "Add a Docker host" opens Settings > Environments in a new tab.
- Inside a host the left menu starts with the host's name and "All environments" to go back, and page subtitles name the host. With only this server nothing changes, plus a small "Add a Docker host" entry in the menu.
- Stacks on a TLS, SSH or Portainer host keep their files on this server in `/opt/stacks/.envs/<id>/<name>/`, and compose runs here against that host. Stack pages say so, and that bind mounts such as `./data` name folders on the host.
- Stacks on a paired Ervisio server: the pairing carries calls and commands but not files, so those stacks cannot be created or edited from here. You can start, stop, restart and remove the ones the server already runs, and the page says where to edit them.
- Portainer Agent hosts: the agent cannot carry terminals, so Shell and Attach explain that instead of failing, and the file browser reads through the archive API.
- Activity: a new page under Tools lists what was done through the plugin (time, user, action, target, host, result), with filters for host, user, action and dates, "Load older entries", and Export CSV.
- Alerts name the host when you watch a remote one. Alerts, update checks and live stats follow the host you opened.
- The manifest declares `remote: "docker"` on the Docker API and on every docker command (`{env}` replaces the hard-coded socket). The stack commands take the folder prefix as a second argument (`""` here, `.envs/<id>/` for a tunnel host).
- Not yet: background jobs (core 0.6 features) cannot target a host; they always run on this server.
