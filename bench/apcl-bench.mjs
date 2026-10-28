// Static token benchmark for APCL vs minified JSON, compact Markdown and English.
// Tokenizer: gpt-tokenizer (o200k_base) — the only accurate BPE available offline.
// Non-OpenAI models (DeepSeek, GLM, MiniMax) have their own vocabularies; treat
// these numbers as a proxy and re-run with a vendor tokenizer when one exists.
import { encode as tokenize } from "gpt-tokenizer";
import { encode, fileId } from "../apcl.js";

const PATH = "docs/research/suno-v6-prompting.md";
const FID = fileId(PATH);
const FID2 = fileId("packages/core/src/parser.ts");
const REV = "1a2b3c4";

const cases = [
  {
    name: "claim",
    apcl: encode({ op: "claim", agent: "ab12", subject: FID, rev: REV }),
    json: JSON.stringify({ o: "C", a: "ab12", f: PATH, r: REV }),
    md: `- claim: ab12 ${PATH} @${REV}`,
    en: `ab12 claims ${PATH} at ${REV}`,
  },
  {
    name: "conflict",
    apcl: encode({ op: "conflict", agent: "ab12", subject: FID, rev: REV }),
    json: JSON.stringify({ o: "X", a: "ab12", f: PATH, r: REV }),
    md: `- conflict: ab12 ${PATH} @${REV}`,
    en: `ab12 reports a conflict on ${PATH} at ${REV}`,
  },
  {
    name: "yield",
    apcl: encode({ op: "yield", agent: "cd34", subject: FID }),
    json: JSON.stringify({ o: "Y", a: "cd34", f: PATH }),
    md: `- yield: cd34 ${PATH}`,
    en: `cd34 yields ${PATH} to you`,
  },
  {
    name: "release",
    apcl: encode({ op: "release", agent: "cd34", subject: FID2 }),
    json: JSON.stringify({ o: "R", a: "cd34", f: FID2 }),
    md: `- release: cd34 ${FID2}`,
    en: `cd34 released ${FID2}`,
  },
  {
    name: "question",
    apcl: encode({ op: "question", agent: "ef56", subject: FID2 }),
    json: JSON.stringify({ o: "Q", a: "ef56", f: FID2 }),
    md: `- q: ef56 ${FID2}?`,
    en: `ef56 asks: are you editing ${FID2}?`,
  },
  {
    name: "negotiation",
    apcl: encode({ op: "message", agent: "ab12", subject: "parser: I take core, you take cli" }),
    json: JSON.stringify({ o: "M", a: "ab12", t: "parser: I take core, you take cli" }),
    md: `- msg ab12: parser: I take core, you take cli`,
    en: `ab12 says: on the parser, I will take core and you take cli`,
  },
];

const counts = (text) => tokenize(text).length;

const rows = [];
for (const testCase of cases) {
  const apcl = counts(testCase.apcl);
  const json = counts(testCase.json);
  const md = counts(testCase.md);
  const en = counts(testCase.en);
  rows.push({ name: testCase.name, apcl, json, md, en });
}

const totals = rows.reduce(
  (acc, row) => ({
    apcl: acc.apcl + row.apcl,
    json: acc.json + row.json,
    md: acc.md + row.md,
    en: acc.en + row.en,
  }),
  { apcl: 0, json: 0, md: 0, en: 0 }
);

const pad = (value, width) => String(value).padStart(width);
console.log("case          apcl  json  md   en   (tokens, o200k)");
for (const row of rows) {
  console.log(
    `${row.name.padEnd(12)} ${pad(row.apcl, 4)}  ${pad(row.json, 4)}  ${pad(row.md, 3)}  ${pad(row.en, 3)}`
  );
}
console.log(
  `${"TOTAL".padEnd(12)} ${pad(totals.apcl, 4)}  ${pad(totals.json, 4)}  ${pad(totals.md, 3)}  ${pad(totals.en, 3)}`
);
console.log(
  `ratio vs apcl: json x${(totals.json / totals.apcl).toFixed(2)}  md x${(totals.md / totals.apcl).toFixed(2)}  en x${(totals.en / totals.apcl).toFixed(2)}`
);
