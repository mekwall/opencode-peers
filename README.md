# @mekwall/opencode-peers

Peer awareness, direct messages, and a shared room for OpenCode V2 sessions working in the same repo or worktree.

Three things, in order of importance:

1. **Awareness.** Before every model call, if other sessions share this project, a short `<peers>` note is injected into the system prompt naming them and telling the agent to ask the user before touching work another agent may be editing. No agent should start rewriting files while a second agent is mid-feature in the same tree.
2. **Direct messages.** `peers_send` types a message into another session, exactly like a user turn.
   Every session also gets a ~90-token `<peers-tools>` block once, explaining the tools and the ask-first rule, so an agent that never sees a peer still knows the feature exists.
3. **A shared room.** `peers_room_send` / `peers_room_read` over an append-only JSONL log per project, and unread room messages are folded into the next model call automatically.

## Tools

Three tools, one-line descriptions, compact output. Alias = 4-char hash of the session id.

| Tool | Args | Returns |
|---|---|---|
| `peers_list` | `all?`, `limit?` | `alias age title` lines; `name#pid (no dm)` for non-OpenCode agents |
| `peers_send` | `to`, `msg`, `steer?` | `sent <alias>`; delivers `[peer <alias>] <msg>` |
| `peers_room` | `msg?` | posting returns `posted` (no fan-out); reading returns `alias> msg` lines or `none` |

Room log lines use one-character keys: `{"i":"<alias>","t":<epoch-s>,"x":"<text>"}`. Agents are told to write terse messages — the protocol is deliberately unfriendly to human readers, because the only consumers are models.

## Loop safety

Agent-to-agent messaging that wakes peers is a loop generator: one post becomes up to N turns, each turn can post again. Three structural guards:

1. **Room posts never create turns.** `peers_room` only appends to the log. Peers see unread messages on their next natural turn through the presence note, or by calling `peers_room`. A broadcast therefore costs zero extra turns and cannot cascade.
2. **No acknowledgements.** The bootstrap says "no acks: answer only if action is needed"; the room tool description repeats it. A peer that sees an informational message does nothing.
3. **The room is pull-only.** Room messages are never injected into the prompt; an agent reads them only when it calls `peers_room`. Nothing to acknowledge, nothing to narrate to the user.
4. **Notes are deduplicated.** The presence note is injected once per distinct content per session, so an unchanged roster or the same unread message is not repeated turn after turn.

DMs (`peers_send`) still deliver as a queued user turn to one session, because they are addressed and expected to prompt work. They queue rather than steer, so they never interrupt a running turn.

## Token budget

Measured on the current build:

| Surface | Size |
|---|---|
| `<peers>` bootstrap, once per session | ~38 tokens |
| three tool schemas, every request | ~177 tokens |
| **always-on total** | **~215 tokens** |
| presence note with two peers | ~25 tokens |

Tests assert the bootstrap stays under 200 chars, each tool description under 100 chars, rosters under 130 chars, and the always-on surface under 250 tokens.

## Install

Published repo: <https://github.com/mekwall/opencode-peers>. Pin a tag so every machine fetches the same code:

```jsonc
{
  "plugin": ["github:mekwall/opencode-peers#v0.1.0"]
}
```

For local development, point at the checkout instead:

```jsonc
{
  "plugin": ["/home/mekwall/repos/github/mekwall/opencode-peers"]
}
```

OpenCode installs Git plugins with Bun and caches them by spec. After changing the tag, clear the cache or the old build keeps loading:

```sh
rm -rf ~/.cache/opencode/npm/git-opencode-peers-*
```

Then restart the service (`opencode service restart`) — a config reload does not re-import plugin modules. Start a new session afterwards. Copying `index.js` into `~/.config/opencode/plugins/peers.js` also works if you prefer a single file.

**Do not use `opencode plugin add` for this.** On OpenCode 2.1.4 it rewrites the whole global config file — it merged the machine-local `opencode.home.json` overrides into `opencode.json` (changed the model, injected a local proxy provider, dropped existing plugins) and still did not add the requested plugin. Edit the `plugin` array by hand.

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

## Platforms

- **Linux:** foreign agents found via `/proc` (cwd, argv, open file descriptors).
- **macOS:** same detection via `ps` + `lsof` (cwd and argv only; no fd scan). State lives in `~/Library/Application Support/opencode-peers` unless `XDG_STATE_HOME` is set.
- **Windows:** OpenCode sessions and the room work; foreign-agent detection returns nothing.
- Core features (presence for OpenCode sessions, DMs, room) are platform-independent.

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
