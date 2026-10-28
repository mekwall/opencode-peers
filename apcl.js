// APCL — Agent Peer Communication Language, v1.
//
// Designed for LLM-to-LLM coordination: fixed vocabulary, positional args,
// deterministic parsing, compact ids, and a natural-language escape hatch.
// The internal event model is separate from the wire form (see protocol.js).
//
// Wire:  ~ <OP> <arg>...
// Ops:   C claim   R release   X conflict   Y yield
//        Q question A answer   B broadcast  N note   M message (free text)
//
// Ids:   agent  = 4-char base36 hash of session id
//        file   = "f" + 4-char base36 hash of path
//        rev    = 7-char git sha
//        "*"    = the subject established by the previous message in this turn
//
// A leading "~" is deliberate: it lets a receiver tell protocol traffic from
// prose with one token, and gives the parser a hard failure mode for anything
// that only looks like a message.

export const OPS = {
  C: "claim",
  R: "release",
  X: "conflict",
  Y: "yield",
  Q: "question",
  A: "answer",
  B: "broadcast",
  N: "note",
  M: "message",
};

export const REQUIRED_ARGS = {
  C: 2,
  R: 2,
  X: 2,
  Y: 2,
  Q: 2,
  A: 2,
  B: 2,
  N: 2,
  M: 2,
};

const AGENT = /^[0-9a-z]{4}$/;
const FILE = /^f[0-9a-z]{4}$/;
const REV = /^[0-9a-f]{7}$/;

function hash36(value, length = 4) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(length, "0").slice(-length);
}

/**
 * Compact agent id: 4 base36 chars derived from the full session id.
 *
 * @param sessionID - Full session id.
 */
export function agentId(sessionID) {
  return hash36(sessionID);
}

/**
 * Compact file id: `f` + 4 base36 chars of the path. Deterministic on both
 * sides, so no negotiation is needed to agree on it.
 *
 * @param path - Repository-relative path.
 */
export function fileId(path) {
  return `f${hash36(path)}`;
}

export function encode(event) {
  const op = Object.keys(OPS).find((key) => OPS[key] === event.op) ?? event.op;
  const args = [event.agent, event.file ?? event.subject ?? ""].filter(Boolean);
  if (event.rev) args.push(event.rev);
  return `~ ${op} ${args.join(" ")}`.trim();
}

/**
 * Deterministic APCL parser with schema validation. Fails closed: an unknown
 * opcode, a malformed agent or file id, or a bad revision all return
 * `{ ok: false, error }` rather than a partially understood event.
 *
 * @param message - Candidate wire string.
 */
export function decode(message) {
  const text = String(message ?? "").trim();
  if (!text.startsWith("~")) return { ok: false, error: "not-apcl" };
  const parts = text.slice(1).trim().split(/\s+/);
  if (parts.length < 2) return { ok: false, error: "too-short" };
  const [op, agent, ...rest] = parts;
  if (!OPS[op]) return { ok: false, error: "unknown-op" };
  if (!AGENT.test(agent)) return { ok: false, error: "bad-agent" };
  const required = REQUIRED_ARGS[op];
  if (rest.length < required - 1) return { ok: false, error: "missing-args" };
  if (op === "M") {
    return { ok: true, op: OPS.M, code: "M", agent, text: rest.join(" "), fields: rest };
  }
  const [subject, rev] = rest;
  if (!FILE.test(subject)) return { ok: false, error: "bad-file" };
  if (rev && !REV.test(rev)) return { ok: false, error: "bad-rev" };
  return {
    ok: true,
    op: OPS[op],
    code: op,
    agent,
    subject,
    rev,
    text: undefined,
    fields: rest,
  };
}

// Diagnostic, human-facing rendering. Never sent on the wire.
/**
 * Diagnostic rendering for humans and logs. Never sent on the wire.
 *
 * @param message - APCL wire string.
 * @param files - Optional `fileId -> path` table to resolve compact ids.
 */
export function humanize(message, files = {}) {
  const parsed = decode(message);
  if (!parsed.ok) return `invalid(${parsed.error})`;
  const file = parsed.subject?.startsWith("f")
    ? (files[parsed.subject] ?? parsed.subject)
    : parsed.subject;
  const rev = parsed.rev ? `@${parsed.rev}` : "";
  return `${parsed.agent} ${parsed.op} ${file ?? ""}${rev}`.trim();
}

/**
 * Cheap protocol detection: the leading `~` is the only marker, so prose that
 * happens to start with an opcode is never mistaken for a message.
 */
export function isApcl(message) {
  return String(message ?? "")
    .trim()
    .startsWith("~");
}
