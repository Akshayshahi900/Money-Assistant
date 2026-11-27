// End-to-end latency over real HTTP/SSE, as a browser sees it.
//   node bench/http-latency.mjs [baseUrl=http://localhost:3000] [N=30]
// Measures per scenario: time to first SSE event (the placeholder = "first visible response") and time to the final
// 'done' event (= complete UI). Prints p50 / p95 and whether the 1 s / 5 s targets were met.
// To measure the LLM-routed tier too, set GROQ_API_KEY/GEMINI_API_KEY on the server and pass LLM=1 (adds vague phrasings).
const base = process.argv[2] ?? "http://localhost:3000",
  N = Number(process.argv[3] ?? 30),
  LLM = process.env.LLM === "1";
const evalSuite = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(new URL("../eval/prompts.json", import.meta.url), "utf8"),
);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function chat(sessionId, message) {
  const t0 = performance.now();
  let first = null,
    ui = null,
    doneAt = null,
    messageId = null,
    via = null,
    buf = "";
  const res = await post("/api/chat", { sessionId, message });
  const rd = res.body.getReader(),
    dec = new TextDecoder();
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    if (first === null) first = performance.now() - t0;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /event: (.*)/.exec(block)?.[1],
        data = JSON.parse(/data: (.*)/.exec(block)?.[1] ?? "null");
      if (ev === "ui") ui = data;
      if (ev === "done") {
        doneAt = performance.now() - t0;
        messageId = data.messageId;
        via = data.via;
      }
    }
  }
  return { first, doneAt, ui, messageId, via };
}
const action = async (sessionId, messageId, payload) => {
  const t = performance.now();
  const r = await (
    await post("/api/action", { sessionId, messageId, payload })
  ).json();
  return { ms: performance.now() - t, r };
};

// setup: one confirmed group so scenario 5 has something to add to
const setup = "bench-setup-" + Date.now();
const g = await chat(
  setup,
  "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.",
);
const p = await action(setup, g.messageId, {
  action: "propose_group",
  name: "Goa trip",
  memberIds: g.ui.members.filter((m) => m.selected).map((m) => m.id),
  txnIds: g.ui.transactions.filter((t) => t.selected).map((t) => t.id),
});
await action(setup, p.r.append.messageId, {
  action: "confirm",
  pendingId: p.r.append.ui.pendingId,
});

const scenarios = [
  ["1 breakdown", "Where did my money go last month?"],
  ["2 food budget", "I want to spend less on food."],
  [
    "3 goa group",
    "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.",
  ],
  ["4 phone plan", "Can I afford an ₹80k phone by March?"],
  ["5 swiggy picker", "Add the Swiggy ones to the group."],
  ["6 stock advice", "Which stock should I buy?"],
];
if (LLM)
  scenarios.push(
    ...evalSuite.prompts
      .filter((x) => x.llmRequired)
      .map((x) => [`LLM ${x.id}`, x.prompt]),
  );

console.log(`HTTP/SSE latency against ${base}, N=${N} per scenario\n`);
console.log(
  "scenario".padEnd(22) +
    "first p50".padStart(11) +
    "first p95".padStart(11) +
    "full p50".padStart(11) +
    "full p95".padStart(11) +
    "  via",
);
let allFirst = [],
  allFull = [],
  llmFirst = [],
  llmFull = [];
for (const [name, msg] of scenarios) {
  const first = [],
    full = [],
    vias = new Set();
  for (let i = 0; i < N; i++) {
    const r = await chat(
      `bench-${name}-${i}-${Date.now()}`.replace(/\s/g, "_"),
      msg,
    );
    if (name.startsWith("5")) {
      /* group is global, so the picker works from any session */
    }
    first.push(r.first);
    full.push(r.doneAt);
    vias.add(r.via);
  }
  allFirst.push(...first);
  allFull.push(...full);
  if (name.startsWith("LLM ")) {
    llmFirst.push(...first);
    llmFull.push(...full);
  }
  console.log(
    name.padEnd(22) +
      pct(first, 50).toFixed(1).padStart(11) +
      pct(first, 95).toFixed(1).padStart(11) +
      pct(full, 50).toFixed(1).padStart(11) +
      pct(full, 95).toFixed(1).padStart(11) +
      "  " +
      [...vias].join(","),
  );
}
console.log(
  `\nALL  first-response p50 ${pct(allFirst, 50).toFixed(1)} ms, p95 ${pct(allFirst, 95).toFixed(1)} ms  (target < 1000 ms: ${pct(allFirst, 95) < 1000 ? "MET" : "MISSED"})`,
);
console.log(
  `ALL  complete-UI    p50 ${pct(allFull, 50).toFixed(1)} ms, p95 ${pct(allFull, 95).toFixed(1)} ms  (target <= 5000 ms: ${pct(allFull, 95) <= 5000 ? "MET" : "MISSED"})`,
);
if (llmFull.length)
  console.log(
    `LLM  first-response p50 ${pct(llmFirst, 50).toFixed(1)} ms, p95 ${pct(llmFirst, 95).toFixed(1)} ms · complete-UI p50 ${pct(llmFull, 50).toFixed(1)} ms, p95 ${pct(llmFull, 95).toFixed(1)} ms`,
  );
