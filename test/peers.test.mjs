import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin, { createPeers, detectForeignAgents, roomFile, stateRoot } from "../index.js";

const SESSIONS = [
  { id: "ses_current", title: "Current work", time: { created: 1, updated: Date.now() } },
  { id: "ses_alpha", title: "Suno generator agent", time: { created: 1, updated: Date.now() } },
  { id: "ses_beta", title: "Suno generator review", time: { created: 1, updated: Date.now() } },
];

async function fakeContext({ data = SESSIONS, withTools = false } = {}) {
  const env = { HOME: await mkdtemp(join(tmpdir(), "peers-test-")) };
  const calls = { list: [], prompt: [], system: [] };
  const ctx = {
    env,
    calls,
    location: { directory: "/repo/a", project: { id: "proj_a", canonical: "/repo/a" } },
    session: {
      list: async (input) => {
        calls.list.push(input);
        return { data, cursor: { next: null } };
      },
      prompt: async (input) => {
        calls.prompt.push(input);
        return {};
      },
      hook: async (_name, callback) => {
        calls.contextHook = callback;
        return { dispose: async () => {} };
      },
    },
  };
  if (withTools) {
    ctx.tool = {
      transform: async (callback) => {
        callback({
          namespace: (value) => {
            calls.namespace = value;
          },
          add: (tool) => calls.tools.push(tool),
        });
        return { dispose: async () => {} };
      },
    };
    calls.tools = [];
  }
  return ctx;
}

const peersOf = (ctx, overrides = {}) => createPeers(ctx, { env: ctx.env, detectForeign: () => [], ...overrides });

test("state lives outside the repo", async () => {
  const ctx = await fakeContext();
  assert.equal(stateRoot(ctx.env), join(ctx.env.HOME, ".local", "share", "opencode-peers"));
  assert.match(roomFile(ctx, ctx.env), /opencode-peers\/rooms\/proj_a\.jsonl$/);
});

test("state root follows platform conventions", async () => {
  const env = { HOME: "/Users/someone" };
  assert.equal(roomFile({ location: { project: { id: "p" } } }, env).startsWith(join(env.HOME, ".local", "share")), true);
  assert.equal(
    stateRoot(env, "darwin"),
    join(env.HOME, "Library", "Application Support", "opencode-peers")
  );
  assert.equal(stateRoot({ ...env, XDG_STATE_HOME: "/custom" }, "darwin"), join("/custom", "opencode-peers"));
});

test("foreign agent detection degrades quietly on other platforms", async () => {
  assert.deepEqual(detectForeignAgents("/repo/a", {}, "win32"), []);
  assert.deepEqual(detectForeignAgents(undefined, {}, "linux"), []);
  assert.deepEqual(detectForeignAgents("/definitely/not/a/repo", {}, "linux"), []);
});

test("list hides the calling session and scopes to the location", async () => {
  const ctx = await fakeContext();
  const result = await peersOf(ctx).list({}, { sessionID: "ses_current" });

  assert.equal(ctx.calls.list[0].directory, "/repo/a");
  assert.ok(!result.content.includes("ses_current"));
  assert.match(result.content, /2 sessions in \/repo\/a/);
});

test("list can span every project", async () => {
  const ctx = await fakeContext();
  await peersOf(ctx).list({ all: true }, { sessionID: "ses_current" });
  assert.equal(ctx.calls.list[0].directory, undefined);
});

test("send resolves a unique title and queues by default", async () => {
  const ctx = await fakeContext();
  const result = await peersOf(ctx).send({ text: "the API changed", title: "generator agent" }, { sessionID: "ses_current" });

  assert.deepEqual(ctx.calls.prompt[0], { sessionID: "ses_alpha", text: "the API changed", delivery: "queue" });
  assert.match(result.content, /delivery=queue/);
});

test("send prefers an explicit session id without listing", async () => {
  const ctx = await fakeContext();
  await peersOf(ctx).send({ text: "hi", sessionID: "ses_alpha" }, { sessionID: "ses_current" });
  assert.equal(ctx.calls.list.length, 0);
});

test("send passes steer through", async () => {
  const ctx = await fakeContext();
  await peersOf(ctx).send({ text: "stop", sessionID: "ses_alpha", delivery: "steer" }, { sessionID: "ses_current" });
  assert.equal(ctx.calls.prompt[0].delivery, "steer");
});

test("ambiguous and unknown titles are rejected", async () => {
  const ctx = await fakeContext();
  const peers = peersOf(ctx);
  await assert.rejects(() => peers.send({ text: "hi", title: "Suno generator" }, { sessionID: "ses_current" }), /ambiguous/i);
  await assert.rejects(() => peers.send({ text: "hi", title: "nope" }, { sessionID: "ses_current" }), /no session title matches/i);
  assert.equal(ctx.calls.prompt.length, 0);
});

test("sending to yourself or with empty text is refused", async () => {
  const ctx = await fakeContext();
  const peers = peersOf(ctx);
  await assert.rejects(() => peers.send({ text: "hi", sessionID: "ses_current" }, { sessionID: "ses_current" }), /current session/i);
  await assert.rejects(() => peers.send({ text: "   " }, { sessionID: "ses_current" }), /text is required/i);
});

test("room send writes a log line and delivers to peers, not self", async () => {
  const ctx = await fakeContext();
  const result = await peersOf(ctx).roomSend({ text: "migrating the parser", fromTitle: "generator" }, { sessionID: "ses_current" });

  assert.match(result.content, /Posted to room/);
  const lines = (await readFile(roomFile(ctx, ctx.env), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const message = JSON.parse(lines[0]);
  assert.equal(message.text, "migrating the parser");
  assert.equal(message.from, "ses_current");
  assert.equal(message.fromTitle, "generator");

  const deliveredTo = ctx.calls.prompt.map((call) => call.sessionID).sort();
  assert.deepEqual(deliveredTo, ["ses_alpha", "ses_beta"]);
  assert.ok(ctx.calls.prompt.every((call) => call.text.startsWith("[room] generator:")));
});

test("room read tracks unread messages per session", async () => {
  const ctx = await fakeContext();
  const peers = peersOf(ctx);
  await peers.roomSend({ text: "first", fromTitle: "a" }, { sessionID: "ses_alpha" });
  await peers.roomSend({ text: "second", fromTitle: "a" }, { sessionID: "ses_alpha" });

  const unread = await peers.roomRead({ unread: true }, { sessionID: "ses_current" });
  assert.equal(unread.content.split("\n").length, 2);
  assert.match(unread.content, /first/);

  const again = await peers.roomRead({ unread: true }, { sessionID: "ses_current" });
  assert.equal(again.content, "No messages.");

  const all = await peers.roomRead({}, { sessionID: "ses_current" });
  assert.match(all.content, /second/);
});

test("presence note names active peers and asks the agent to check with the user", async () => {
  const ctx = await fakeContext();
  const note = await peersOf(ctx).presenceNote("ses_current", { force: true });

  assert.match(note, /^<peers>/);
  assert.match(note, /ses_alpha/);
  assert.match(note, /ask the user/i);
});

test("presence note reports non-OpenCode agents that cannot be messaged", async () => {
  const ctx = await fakeContext();
  const peers = peersOf(ctx, { detectForeign: () => [{ name: "codex", pid: 4242, cwd: "/repo/a" }] });

  const note = await peers.presenceNote("ses_current", { force: true });
  assert.match(note, /Non-OpenCode agents/);
  assert.match(note, /codex \(pid 4242\)/);
  assert.match(note, /ask the user/i);

  const roster = await peers.list({}, { sessionID: "ses_current" });
  assert.match(roster.content, /codex \(pid 4242\)/);
});

test("stale sessions do not trigger presence, but still list", async () => {
  const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const ctx = await fakeContext({
    data: [SESSIONS[0], { id: "ses_old", title: "Ancient work", time: { created: old, updated: old } }],
  });
  const peers = peersOf(ctx);

  assert.equal(await peers.presenceNote("ses_current"), "");
  const roster = await peers.list({}, { sessionID: "ses_current" });
  assert.match(roster.content, /ses_old/);
  assert.match(roster.content, /90d ago|89d ago/);
});

test("presence ignores the current session's own children", async () => {
  const child = { id: "ses_mine", title: "My subagent", parentID: "ses_current", time: { created: 1, updated: Date.now() } };
  const ctx = await fakeContext({ data: [SESSIONS[0], child] });
  assert.equal(await peersOf(ctx).presenceNote("ses_current"), "");
});

test("presence note is empty when nothing is happening", async () => {
  const ctx = await fakeContext({ data: [SESSIONS[0]] });
  const note = await peersOf(ctx).presenceNote("ses_current");
  assert.equal(note, "");
});

test("unread room messages are folded into the presence note", async () => {
  const ctx = await fakeContext();
  const peers = peersOf(ctx);
  await peers.roomSend({ text: "don't touch src/cli.ts", fromTitle: "other agent" }, { sessionID: "ses_alpha" });

  const note = await peers.presenceNote("ses_current", { force: true });
  assert.match(note, /Unread room messages/);
  assert.match(note, /don't touch src\/cli\.ts/);
});

test("setup registers a namespace, four tools, and a context hook", async () => {
  const ctx = await fakeContext({ withTools: true });
  await plugin.setup(ctx);

  assert.equal(plugin.id, "peers");
  assert.equal(ctx.calls.namespace, undefined, "tools are named explicitly, not namespaced");
  assert.deepEqual(ctx.calls.tools.map((tool) => tool.name), [
    "peers_list",
    "peers_send",
    "peers_room_send",
    "peers_room_read",
  ]);
  for (const tool of ctx.calls.tools) {
    assert.equal(tool.input.type, "object");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.description.length > 40);
  }
  assert.deepEqual(ctx.calls.tools.find((t) => t.name === "peers_send").input.required, ["text"]);

  const event = { sessionID: "ses_current", system: [] };
  await ctx.calls.contextHook(event);
  assert.equal(event.system.length, 1);
  assert.match(event.system[0].text, /<peers>/);

  await ctx.calls.contextHook(event);
  assert.equal(event.system.length, 1, "identical note is not injected twice");
});
