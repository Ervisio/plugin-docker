# Changes from the containers branch (for CHANGELOG.md)

* New Attach tab on the container page: connects to the main process of the container (`docker attach`), in the same
  terminal as the Shell tab. Ctrl+P then Ctrl+Q detaches and leaves the container running; the page says that Ctrl+C
  goes to the main process and may stop it. A Detach button works for containers without a TTY, where the detach keys
  do not. Containers created without stdin open get an explanation and a shortcut to edit and recreate them.
* New Files tab on the container page: browse any folder inside a container, with size, mode, owner and date. Open a
  text file to read it, download a file (up to 8 MB), upload a file (up to 760 KB for now), create a folder and delete
  files or folders (with a confirm dialog). It also works on stopped containers, and on images without `ls`, such as
  distroless ones, by reading the folder through the Docker archive API. Deleting needs a running container with a shell.
* New "Save as image" action on the container page (`docker commit`): image name and tag, optional comment and author,
  pause while saving (on by default), and optional Dockerfile lines (CMD, ENTRYPOINT, ENV, EXPOSE, LABEL, USER, VOLUME,
  WORKDIR) for the new image. A link opens the new image in the image list.
* The create/edit wizard has a new "Resources and devices" step: memory limit, reservation and swap, CPU limit, CPU
  shares, CPU cores, process limit, shared memory size, ulimits, GPU (all, a number, or chosen devices; the wizard says
  when the engine has no nvidia runtime), devices, capabilities to add and drop, and sysctls. The Network step gained
  the init process and the Interactive and TTY switches. The review step and the summary list all of them, and editing a
  container (recreate) carries them over.
* New permissions: `PUT /containers/<id>/archive` and `POST /commit` on the Docker socket, and the `attach` terminal
  command (`docker attach --sig-proxy=false --detach-keys=ctrl-p,ctrl-q <container>`).
