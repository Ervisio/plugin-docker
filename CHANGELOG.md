# Changelog

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
