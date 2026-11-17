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

The initial login password must contain at least four characters. After login,
use **Passwort ändern** in the sidebar to choose a new password of at least
12 characters. Changing it requires the current password and signs out other
browser sessions. The current browser receives a fresh session automatically.
Browser sessions expire after 24 hours and are invalidated when the container
restarts. `COOKIE_SECURE=true`
requires HTTPS and adds the Secure cookie flag. `HOST_LABEL` is an optional display
name; `CODEX_PROJECTS` is an optional JSON array of `{ "name", "path" }` entries
referring to directories on the existing Codex machine. The selector combines
configured projects with projects returned by Codex. The upper conversation list
is filtered to the selected project; the independent lower list contains chats
without a project. Each starts with ten conversations and loads five more only
when you scroll. Metadata pages are filtered on the server before they reach the
browser, so older matching chats remain reachable.

The composer offers the models and reasoning efforts reported by the existing
Codex environment. Opening a conversation restores its current model and effort;
your selection applies to the next message. Available speed tiers come from the
selected model. Remaining usage shows the account's reported usage windows and
reset times; unavailable data is not replaced with an estimate. Changing these
controls does not edit the machine's global Codex configuration.

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
temporary storage at `/tmp`, and no host mounts. The `web-auth` volume stores
only the salted password hash in `/data/auth.json`; no plaintext password is
written there. Keep that volume across upgrades. Once initialized, the stored
password takes precedence over the bootstrap environment variable. A changed
password therefore survives a container replacement; the original environment
value no longer signs in. Private deployment notes recording a bootstrap
password do not automatically update after a browser password change.
The backend gateway token stays
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
