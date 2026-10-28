// Live coordination benchmark: same two tasks, four encodings, one cheap model.
// Measures answer correctness, wall time, tokens (input/output/reasoning) and cost
// from OpenCode's own step-finish telemetry.
//
// Small sample by design: this is a sanity benchmark, not a publishable study.
import { execFileSync } from "node:child_process";
import { encode, fileId } from "../apcl.js";

const MODEL = process.env.BENCH_MODEL ?? "neuralwatt/deepseek-v4.1-flash";
const PATH = "docs/research/suno-v6-prompting.md";
const FID = fileId(PATH);
const REV = "1a2b3c4";

const wire = {
  apcl: encode({ op: "conflict", agent: "ab12", subject: FID, rev: REV }),
  json: JSON.stringify({ o: "X", a: "ab12", f: FID, r: REV }),
  md: `- conflict: ab12 ${FID} @${REV}`,
  en: `ab12 reports a conflict on ${PATH} at ${REV}`,
};

const decodePrompt = (message) =>
  `Message: ${message}\nMapping: ${FID}=${PATH}\nReply with exactly one line: "<op> <agent> <path>" using op=conflict. No other text.`;

const decidePrompt = (message) =>
  `Message: ${message}\nMapping: ${FID}=${PATH}\nYou are agent cd34. Rule: on a conflict, the lexicographically later agent yields and the earlier one keeps.\nReply with exactly one word: YIELD or KEEP.`;

const tasks = {
  decode: {
    prompt: decodePrompt,
    expect: (answer) => /^conflict ab12 docs\/research\/suno-v6-prompting\.md$/.test(answer.trim()),
  },
  decide: { prompt: decidePrompt, expect: (answer) => /^YIELD$/.test(answer.trim()) },
};

function run(prompt) {
  const started = Date.now();
  const raw = execFileSync(
    "opencode",
    ["run", "--standalone", "--model", MODEL, "--format", "json", prompt],
    { encoding: "utf8", timeout: 120_000 }
  );
  const elapsedMs = Date.now() - started;
  let text = "";
  let usage;
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "text" && event.part?.text) text = event.part.text;
    if (event.type === "step_finish" && event.part?.tokens) usage = event.part;
  }
  // Some stdout paths truncate the final event; fall back to scanning the raw
  // stream for the token block so the numbers survive that.
  let tokensFromRaw;
  const tokenBlocks = [...raw.matchAll(/"tokens":\s*\{([^}]*)\}/g)];
  if (!usage?.tokens && tokenBlocks.length > 0) {
    const body = tokenBlocks.at(-1)[1];
    const num = (key) => Number(body.match(new RegExp(`"${key}":(\\d+)`))?.[1] ?? 0);
    tokensFromRaw = { input: num("input"), output: num("output"), reasoning: num("reasoning") };
  }
  const tokens = usage?.tokens ?? tokensFromRaw;

  return {
    answer: text.trim(),
    elapsedMs,
    cost: usage?.cost ?? null,
    input: tokens?.input ?? null,
    output: tokens?.output ?? null,
    reasoning: tokens?.reasoning ?? null,
  };
}

const rows = [];
for (const [encoding, message] of Object.entries(wire)) {
  for (const [taskName, task] of Object.entries(tasks)) {
    try {
      const result = run(task.prompt(message));
      rows.push({ encoding, task: taskName, ok: task.expect(result.answer), ...result });
    } catch (error) {
      rows.push({
        encoding,
        task: taskName,
        ok: false,
        answer: `ERROR ${error.message}`,
        elapsedMs: null,
      });
    }
  }
}

console.log("enc     task    ok   secs   in    out   reason  cost");
for (const row of rows) {
  console.log(
    [
      row.encoding.padEnd(7),
      row.task.padEnd(7),
      String(row.ok).padEnd(5),
      (row.elapsedMs ? (row.elapsedMs / 1000).toFixed(1) : "-").padStart(4),
      String(row.input ?? "-").padStart(5),
      String(row.output ?? "-").padStart(5),
      String(row.reasoning ?? "-").padStart(6),
      row.cost != null ? row.cost.toFixed(5) : "-",
    ].join("  ")
  );
}

const summary = {};
for (const row of rows) {
  if (!summary[row.encoding]) summary[row.encoding] = { ok: 0, n: 0, tokens: 0, cost: 0, secs: 0 };
  const entry = summary[row.encoding];
  entry.n += 1;
  entry.ok += row.ok ? 1 : 0;
  entry.tokens += (row.input ?? 0) + (row.output ?? 0) + (row.reasoning ?? 0);
  entry.cost += row.cost ?? 0;
  entry.secs += (row.elapsedMs ?? 0) / 1000;
}
console.log("\nencoding  success  avg tokens  avg secs  cost/task");
for (const [encoding, entry] of Object.entries(summary)) {
  console.log(
    [
      encoding.padEnd(8),
      `${entry.ok}/${entry.n}`.padEnd(7),
      String(Math.round(entry.tokens / entry.n)).padStart(10),
      (entry.secs / entry.n).toFixed(1).padStart(9),
      (entry.cost / entry.n).toFixed(5).padStart(9),
    ].join("  ")
  );
}
