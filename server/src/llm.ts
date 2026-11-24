/** Thin OpenAI-compatible tool-calling client (works with Groq and Gemini's OpenAI endpoint). */
export interface LlmRoute {
  tool: string;
  args: any;
  usage?: { in: number; out: number };
}

function provider() {
  if (process.env.GROQ_API_KEY)
    return {
      key: process.env.GROQ_API_KEY,
      base: "https://api.groq.com/openai/v1",
      // The 20B variant is a fast tool-calling model. Override with LLM_MODEL if needed.
      model: process.env.LLM_MODEL ?? "openai/gpt-oss-20b",
    };
  if (process.env.GEMINI_API_KEY)
    return {
      key: process.env.GEMINI_API_KEY,
      base: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: process.env.LLM_MODEL ?? "gemini-2.0-flash",
    };
  return null;
}

const PERIODS = ["yesterday", "today", "this_week", "this_month", "last_month", "last_30_days", "last_3_months", "last_6_months"];

export async function llmRoute(
  msg: string,
  ctx: { today: string; categories: string[] },
): Promise<LlmRoute | null> {
  const p = provider();
  if (!p) {
    console.warn("LLM routing skipped: set GROQ_API_KEY or GEMINI_API_KEY in the server environment.");
    return null;
  }
  const tools = [
    {
      type: "function",
      function: {
        name: "show_spending_breakdown",
        description:
          "Show where the user's money went, by category, for a period.",
        parameters: {
          type: "object",
          properties: {
            period: {
              type: "string",
              enum: [
                "yesterday",
                "today",
                "this_week",
                "this_month",
                "last_month",
                "last_30_days",
                "last_3_months",
                "last_6_months",
              ],
            },
          },
          required: ["period"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "suggest_budget",
        description:
          "User wants to reduce or budget spending in one category; propose an adjustable monthly limit.",
        parameters: {
          type: "object",
          properties: { category: { type: "string", enum: ctx.categories } },
          required: ["category"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_group",
        description: "User wants to create a shared expense group (e.g. a trip) with named people, optionally adding specific past transactions (hotel, cab, flight, food).",
        parameters: {
          type: "object",
          properties: {
            groupName: { type: "string", description: "e.g. Goa trip" },
            memberNames: { type: "array", items: { type: "string" }, description: "first names of friends, as written" },
            items: { type: "array", items: { type: "string", enum: ["hotel", "cab", "flight", "food"] } },
            period: { type: "string", enum: PERIODS },
          },
          required: ["groupName", "memberNames", "items", "period"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_to_group",
        description: "User wants to add existing transactions (matched by merchant or keyword, e.g. 'Swiggy') to their existing group.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "merchant or keyword as written" }, period: { type: "string", enum: PERIODS } },
          required: ["query", "period"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "plan_purchase",
        description: "User asks whether they can afford or how to save for a purchase by a date. Do NOT extract the price.",
        parameters: {
          type: "object",
          properties: {
            item: { type: "string", description: "what they want to buy, e.g. phone" },
            month: { type: "integer", description: "target calendar month 1-12 if named" },
            inMonths: { type: "integer", description: "months from now if given relatively" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "investment_question",
        description: "User asks what to invest in, which stock/fund/crypto to buy or sell, or for market tips.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const ac = new AbortController();
  const timeoutMs = Math.max(1000, Number(process.env.LLM_TIMEOUT_MS ?? 10000));
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.key}`,
      },
      body: JSON.stringify({
        model: p.model,
        temperature: 0,
        tools,
        tool_choice: "auto",
        max_tokens: 150,
        messages: [
          {
            role: "system",
            content: `You route a personal-finance assistant. Today is ${ctx.today}. Choose a tool whenever the request matches one of the available capabilities, even if phrased informally. For spending questions, select show_spending_breakdown and infer the requested period. For queries about a specific theme that is not a supported category, do not pretend a category exists. Never answer with numbers or prose.`,
          },
          { role: "user", content: msg },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`LLM routing provider returned HTTP ${res.status}. Check the Groq model/API configuration.`);
      return null;
    }
    const j: any = await res.json();
    const call = j.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) {
      console.warn("LLM routing returned no tool call.");
      return null;
    }
    return {
      tool: call.function.name,
      args: JSON.parse(call.function.arguments || "{}"),
      usage: {
        in: j.usage?.prompt_tokens ?? 0,
        out: j.usage?.completion_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`LLM routing timed out after ${timeoutMs} ms (set LLM_TIMEOUT_MS to adjust).`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}
