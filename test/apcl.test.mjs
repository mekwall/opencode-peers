import assert from "node:assert/strict";
import test from "node:test";

import { agentId, decode, encode, fileId, humanize, isApcl } from "../apcl.js";

test("ids are short, stable and distinct", () => {
  assert.match(agentId("ses_abc123"), /^[0-9a-z]{4}$/);
  assert.equal(agentId("ses_abc123"), agentId("ses_abc123"));
  assert.notEqual(agentId("ses_abc123"), agentId("ses_abc124"));
  assert.match(fileId("docs/x.md"), /^f[0-9a-z]{4}$/);
});

test("round-trips every op with positional args", () => {
  for (const [op, subject] of [
    ["claim", fileId("docs/x.md")],
    ["release", fileId("docs/x.md")],
    ["conflict", fileId("docs/x.md")],
    ["yield", fileId("docs/x.md")],
    ["question", fileId("docs/x.md")],
    ["answer", fileId("docs/x.md")],
    ["broadcast", fileId("docs/x.md")],
    ["note", fileId("docs/x.md")],
  ]) {
    const wire = encode({ op, agent: "ab12", subject, rev: "1a2b3c4" });
    const parsed = decode(wire);
    assert.equal(parsed.ok, true, `${op}: ${wire}`);
    assert.equal(parsed.op, op);
    assert.equal(parsed.agent, "ab12");
    assert.equal(parsed.subject, subject);
    assert.equal(parsed.rev, "1a2b3c4");
  }
});

test("free text is only allowed for message", () => {
  const wire = encode({ op: "message", agent: "ab12", subject: "parser conflict, take core" });
  const parsed = decode(wire);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.op, "message");
});

test("invalid input fails closed", () => {
  assert.equal(decode("hello there").ok, false);
  assert.equal(decode("~").ok, false);
  assert.equal(decode("~ Z ab12 f1234").ok, false, "unknown op");
  assert.equal(decode("~ C AB12 f1234").ok, false, "agent is lowercase base36");
  assert.equal(decode("~ C ab12 docs/x.md").ok, false, "path must be a file id");
  assert.equal(decode("~ C ab12").ok, false, "missing args");
  assert.equal(decode("~ C ab12 f1234 1a2b3c4").ok, true);
  assert.equal(decode("~ C ab12 f1234 nope").ok, false, "bad rev");
});

test("apcl is detectable and humanizable for diagnostics", () => {
  const wire = encode({ op: "claim", agent: "ab12", subject: fileId("docs/x.md"), rev: "1a2b3c4" });
  assert.equal(isApcl(wire), true);
  assert.equal(isApcl("ab12> hello"), false);
  assert.equal(
    humanize(wire, { [fileId("docs/x.md")]: "docs/x.md" }),
    "ab12 claim docs/x.md@1a2b3c4"
  );
  assert.match(humanize("~ Z ab12 f1234"), /^invalid\(/);
});
