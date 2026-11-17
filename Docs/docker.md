# remodex-web in Docker

This fork adds a browser interface to an existing Codex environment:

```text
Browser → remodex-web container → existing Codex gateway → original Codex daemon
```

The web container connects to the configured WebSocket gateway. Projects,
authentication, history, and execution stay in the original Codex environment.
The original mobile app and bridge remain available in the source tree.

## Local setup

Create a private `.env` beside `compose.yaml` containing:

- `CODEX_WEB_PASSWORD`: a strong password for browser login.
- `CODEX_WS_URL`: the WebSocket URL of the existing Codex gateway.
- `CODEX_API_TOKEN`: the existing gateway's authentication token.

The login password must contain at least 12 characters. Browser sessions expire
after 24 hours and are invalidated when the container restarts. `COOKIE_SECURE=true`
requires HTTPS and adds the Secure cookie flag. `HOST_LABEL` is an optional display
name; `CODEX_PROJECTS` is an optional JSON array of `{ "name", "path" }` entries
referring to directories on the existing Codex machine. Paths observed in thread
history are also offered automatically; project selection does not filter history.

These values belong in the private runtime environment, never in Git or in an
image. Then run:

```sh
docker compose up --build -d
```

Open `http://localhost:7878`. The default bind address is loopback. For access
from a private network, set `WEB_BIND` to an address on that network;
`WEB_PORT` changes the host port. Use a trusted TLS reverse proxy or a
private tunnel when the browser and server are on different machines.

The container runs as the unprivileged `node` user, with a read-only filesystem,
temporary storage at `/tmp`, and no host mounts. The backend gateway token stays
on the server side. No second Codex runtime or separate Codex login is created.

## Dockhand

Create a Git stack pointing to this fork with `compose.yaml` as its Compose
path. Set `CODEX_WEB_PASSWORD` and `CODEX_API_TOKEN` as secret stack environment
variables and set `CODEX_WS_URL` for the existing gateway. Set
`WEB_BIND` and `WEB_PORT` for the private access path, enable
the build, and deploy.

The Docker health check uses `/health` to check the web server. Authenticated
`/api/status` reports the backend connection separately. Replacing the web
container leaves projects and history on the existing Codex environment.

## License

The original Apache 2.0 license and attribution remain in `LICENSE`, which is
also included at `/app/LICENSE` in the image. The browser and Docker additions
are changes made in this fork, not an official upstream release.
