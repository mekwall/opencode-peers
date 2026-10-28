// Internal coordination protocol, independent of how it is serialized to a model.
//
// Internally an event is a typed record: integer op, aliases, subject, payload.
// The LLM-facing form is a rendering decision, chosen by expected resolution cost,
// not by message length. Nothing here knows about the TUI, the registry or git.

export const OPS = { claim: 1, bcast: 2, dm: 3 };
export const OP_NAMES = { 1: "claim", 2: "bcast", 3: "dm" };

// Internal wire form: fixed-width array, no keys. JSON only for persistence.
/**
 * Normalizes a loose event object into the internal, typed form. This is the
 * only place that maps operation names to integer opcodes.
 */
export function pack(event) {
  return {
    op: OPS[event.op] ?? event.op,
    from: event.from,
    to: event.to,
    subject: event.subject,
    text: event.text,
  };
}

// LLM-facing renderings. `text` is terse natural language; `code` is ordinal
// tokens requiring a decode table. Both carry identical information.
/**
 * Renders an internal event for a model.
 *
 * @param event - Packed event.
 * @param encoding - `text` is self-describing; `code` is ordinal and needs a
 *                   decode table in the receiver's context.
 * @returns The wire string, with no trailing whitespace.
 */
export function render(event, encoding = "text") {
  const op = OP_NAMES[event.op] ?? String(event.op);
  if (encoding === "code") {
    return `p1 ${event.op} ${event.from} ${event.subject ?? ""}`.trim();
  }
  if (op === "claim") return `p1 claim ${event.from}: ${event.subject}`;
  if (op === "bcast")
    return `p1 bcast ${event.from}: ${event.text} (act only if relevant; never ack)`;
  if (op === "dm") return `${event.from}> ${event.text}`;
  return `p1 ${event.from}: ${event.text ?? event.subject ?? ""}`;
}

/**
 * Deterministic parser for both renderings. Never guesses: an unrecognized
 * shape returns `undefined` so callers can treat it as prose.
 */
export function parse(message) {
  const text = String(message ?? "");
  const code = text.match(/^p1 (\d) (\S+) (.*)$/);
  if (code) return pack({ op: Number(code[1]), from: code[2], subject: code[3] || undefined });
  const verbose = text.match(/^p1 (claim|bcast) (\S+): (.*)$/);
  if (verbose) {
    const op = verbose[1];
    return op === "claim"
      ? pack({ op: "claim", from: verbose[2], subject: verbose[3] })
      : pack({
          op: "bcast",
          from: verbose[2],
          text: verbose[3].replace(/ \(act only if relevant; never ack\)$/, ""),
        });
  }
  const dm = text.match(/^(\S+)> (.*)$/);
  if (dm) return pack({ op: "dm", from: dm[1], text: dm[2] });
  return undefined;
}

// Rough, deliberately simple cost model, in tokens.
//   message   : what the sender pays to emit the rendering
//   resolution: what the receiver pays to understand it and decide
// A decode table is a fixed overhead on every code-encoded message, and it is
// only worth paying when the receiver has little to decide. That is the whole
// reason to keep both renderings.
const DECODE_OVERHEAD = 120; // tokens of instructions needed to interpret ordinal ops
const AMBIGUITY_PENALTY = 900; // cost of a wrong or failed reconciliation

/**
 * Scores both renderings by *expected resolution cost*: message tokens plus what
 * the receiver spends understanding it, plus an ambiguity penalty when the wire
 * form carries no semantics the receiver can check.
 *
 * @param event - Packed event.
 * @param options.deterministicTransitions - True when the plugin has already
 *        decided the outcome, so the receiver only has to comply.
 * @returns Per-encoding cost breakdown, the chosen encoding, and totals.
 */
export function costModel(event, { deterministicTransitions = false } = {}) {
  const subject = event.subject ?? event.text ?? "";
  const textTokens = Math.ceil(render(event, "text").length / 4);
  const codeTokens = Math.ceil(render(event, "code").length / 4);

  const text = {
    message: textTokens,
    // Prose is self-describing, so the receiver rarely needs extra context.
    resolution: deterministicTransitions ? 40 : 60,
    ambiguity: 0,
  };
  // A deterministic transition needs no decode table: the plugin has already
  // decided, and the receiver only has to comply. Negotiation does need one.
  const code = {
    message: codeTokens,
    resolution: deterministicTransitions ? 10 : 80 + DECODE_OVERHEAD,
    // Ordinal ops carry no semantics for the receiver to check against.
    ambiguity: deterministicTransitions ? 0 : AMBIGUITY_PENALTY,
  };

  const total = (entry) => entry.message + entry.resolution + entry.ambiguity;
  const chosen = total(code) < total(text) ? "code" : "text";
  return { subject, text, code, chosen, totals: { text: total(text), code: total(code) } };
}

/**
 * Packs and renders in one step.
 *
 * @param options.encoding - Force `text` or `code`; defaults to the cost model.
 * @returns `{ encoding, message }` so callers can log which form went out.
 */
export function encode(event, options = {}) {
  const encoding = options.encoding ?? costModel(event, options).chosen;
  return { encoding, message: render(pack(event), encoding) };
}
