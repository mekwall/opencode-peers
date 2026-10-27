# @mekwall/opencode-peers

Peer awareness, direct messages, and a shared room for OpenCode V2 sessions working in the same repo or worktree.

Three things, in order of importance:

1. **Awareness.** Before every model call, if other sessions share this project, a short `<peers>` note is injected into the system prompt naming them and telling the agent to ask the user before touching work another agent may be editing. No agent should start rewriting files while a second agent is mid-feature in the same tree.
2. **Direct messages.** `peers_send` types a message into another session, exactly like a user turn.
3. **A shared room.** `peers_room_send` / `peers_room_read` over an append-only JSONL log per project, and unread room messages are folded into the next model call automatically.

## Tools

| Tool | Purpose |
|---|---|
| `peers_list` | other sessions here (`all: true` spans projects), with age and title |
| `peers_send` | DM one session by `sessionID` or unique title substring; `delivery: queue` (default) or `steer` |
| `peers_room_send` | post to the project room and deliver to every peer session |
| `peers_room_read` | recent room messages; `unread: true` returns only what you have not seen |

## Install

Local plugin, no build step, no runtime dependencies:

```sh
opencode plugin add /home/mekwall/repos/github/mekwall/opencode-peers
```

If `plugin add` rejects a local path, add it to `plugins` in `opencode.json(c)` directly:

```jsonc
{
  "plugins": ["/home/mekwall/repos/github/mekwall/opencode-peers"]
}
```

Or copy `index.js` into `~/.config/opencode/plugins/peers.js` if you prefer a single file.

Note: `opencode plugin list` only reports npm packages and files under the plugins directory, so a config-path plugin loads correctly but does not appear in that listing.

## Toolchain

Bun, pinned with mise:

```sh
mise install      # bun 1.4.0 from mise.toml
mise run test     # bun test test/
mise run test:node
```

Bun is the runtime OpenCode uses to load plugins, so it is the primary test runner; Node's runner is kept as a second opinion.

## State

Room logs live outside any repo:

```
${XDG_STATE_HOME:-~/.local/share}/opencode-peers/rooms/<project>.jsonl
```

One JSON object per line: `{ id, ts, from, fromTitle, text }`. Plain JSONL on purpose — another harness (Codex, Claude Code) can join the room by reading and appending the same file, and the log survives plugin restarts.

## Design notes

- **Transport is native.** OpenCode V2 already exposes session prompting and session listing (`POST /api/session/{id}/prompt`, `GET /api/session`). The plugin is a tool and context surface over `ctx.session.list` / `ctx.session.prompt`, not a new protocol.
- **`queue` by default.** A queued message arrives on the target's next turn and does not interrupt it. `steer` interrupts, so it is opt-in per call.
- **A send is not a reply.** The tool result says so explicitly, so a model does not assume the peer read, agreed, or acted.
- **Peer content is untrusted.** Tool descriptions and the injected note both say peer messages are input from another agent, never instructions from the user.
- **Presence is cached for 30s** and the injected note is deduplicated, so an unchanged roster is not repeated turn after turn.
- **Only recent activity counts.** Presence ignores sessions idle for more than 30 minutes (`activeWithinMs`) and the current session's own children, so a long-dead conversation in the same repo does not trigger a false "another agent is working here". `peers_list` still shows everything, with ages.
- **Non-OpenCode agents are detected too.** On Linux, `/proc` is scanned for known agent binaries (codex, claude, cursor-agent, aider, gemini, omp, pi) whose cwd, argv or open file descriptors touch this repo. They appear in the note as agents that cannot receive DMs, so the advice is "ask the user", not "message them".
- **No auto-wake.** Nothing starts a turn in an idle session; messages wait for the peer's next prompt. Auto-wake needs a wake channel the harness does not expose.

## Limits

- Same machine, same OpenCode background service. Cross-machine is out of scope.
- Only sees sessions the current location can list; a plugin loaded in one project cannot enumerate another project's sessions unless `all: true` is permitted by the server.
- Room delivery loops over peers with a direct prompt each; a session that is removed between listing and delivery is skipped into the `failed` list, and the room log still holds the message.
- Process-level detection cannot see an agent that works through absolute paths without a cwd, argv or open fd inside the repo — notably the ChatGPT desktop Codex app-server. Codex CLI started in the repo is detected; the desktop app is not.
- `/proc` scanning is Linux-only and returns nothing elsewhere.

## Tests

```sh
bun test test/          # host runtime is Bun — this is the primary runner
node --test test/*.test.mjs
```

Covers roster scoping, title resolution and ambiguity, self-send refusal, room append/delivery, unread cursor behaviour, presence-note composition, and tool/hook registration.
