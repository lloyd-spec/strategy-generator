import { timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  if (A.length !== B.length) { timingSafeEqual(A, A); return false; }
  return timingSafeEqual(A, B);
}

async function rateLimited(request, context, name, cap) {
  // Shared bump_rate limiter - fails open so a database blip never blocks work.
  const ip = (context && context.ip) || request.headers.get("x-nf-client-connection-ip") || "unknown";
  const base = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !sk) return false;
  try {
    const r = await fetch(base + "/rest/v1/rpc/bump_rate", {
      method: "POST",
      headers: { "apikey": sk, "Authorization": "Bearer " + sk, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: name + ":" + ip, p_window_seconds: 600 })
    });
    if (!r.ok) return false;
    return (await r.json()) > cap;
  } catch { return false; }
}

// Guard rails on what the page can send. The prompts are assembled by the
// page from confirmed inputs (screenshots the team has approved, figures they
// have confirmed), so they are dynamic by design - but nothing pathological
// should ever reach the API, and a leaked password should not buy unlimited
// tokens. Rotating the password plus these caps plus per-provider spend
// limits in each console keep the blast radius small.
const MAX_PROMPT_CHARS = 60000;
const MAX_SYSTEM_CHARS = 12000;
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 8000000; // ~6MB per image once decoded

// netlify/functions/strategy.mjs
// The engine room of the Strategy Generator. The page never holds an API key
// or a database key - everything sensitive lives in Netlify's environment.
//
// The tool works in tiers, each on the cheapest model that does the job well:
//   reader     - Sonnet with vision. Reads Experian / Power BI screenshots and
//                extracts figures as structured data for the team to CONFIRM
//                before anything is written. Nothing unconfirmed is ever used.
//   writer     - Sonnet. Drafts the supporting sections from confirmed inputs.
//   strategist - Opus. ONE call for the strategic core (objectives, approach,
//                hierarchy, pillars, campaign starters) - the thinking a
//                client actually pays for. Switch to "claude-sonnet-4-6" below
//                to cut cost further at some loss of depth.
//   auditor    - Haiku. A cheap final pass that checks every number in the
//                draft against the confirmed figures and flags strays.
//
// HARD RULE enforced throughout: the model must never invent a statistic.
// Only figures from the confirmed list may appear, and the auditor checks.
//
// Env needed: ANTHROPIC_API_KEY, SITE_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY

const TIERS = {
  reader:     { model: "claude-sonnet-4-6",           maxTokens: 2500 },
  writer:     { model: "claude-sonnet-4-6",           maxTokens: 2000 },
  strategist: { model: "claude-opus-4-8",             maxTokens: 4600 }, // the one Opus call - set to "claude-sonnet-4-6" to run cheaper
  auditor:    { model: "claude-haiku-4-5-20251001",   maxTokens: 1200 }
};

export default async (request, context) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  if (await rateLimited(request, context, "gen-auth", 300)) return json({ error: "Too many requests. Try again shortly." }, 429);

  const sitePassword = process.env.SITE_PASSWORD;
  const sent = request.headers.get("x-password") || body.password;
  if (!sitePassword || !safeEqual(sent, sitePassword)) return json({ error: "Unauthorised" }, 401);

  if (body.ping) return json({ ok: true });

  // ---- Document storage (Supabase, service key, table strategy_docs) ----
  if (body.action === "save" || body.action === "list" || body.action === "get") {
    return storage(body, "strategy_docs");
  }

  // ---- AI calls (streamed back as plain text the page assembles) ----
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set in Netlify" }, 500);

  const tier = TIERS[body.tier] || TIERS.writer;

  // Guard rails on the inputs before anything reaches the API.
  const promptText = String(body.prompt || "").slice(0, MAX_PROMPT_CHARS);
  const systemText = String(body.system || "").slice(0, MAX_SYSTEM_CHARS);
  const messages = [];

  if (body.images && Array.isArray(body.images) && body.images.length) {
    // Screenshot reading: images plus the extraction instruction.
    const imgs = body.images.slice(0, MAX_IMAGES).filter(img => img && typeof img.data === "string" && img.data.length <= MAX_IMAGE_B64);
    const content = imgs.map(img => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type || "image/png", data: img.data }
    }));
    content.push({ type: "text", text: promptText });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: promptText });
  }

  const payload = {
    model: tier.model,
    max_tokens: tier.maxTokens,
    stream: true,
    // The system prompt is the long house-style block, identical on every
    // call in a sitting - marking it cacheable cuts its input cost by 90%
    // on repeats within the cache window.
    system: systemText ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }] : "",
    messages
  };

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return json({ error: "AI request failed (" + upstream.status + "): " + errText.slice(0, 300) }, 502);
  }

  // Re-stream just the text deltas so the page can show live progress.
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                controller.enqueue(new TextEncoder().encode(evt.delta.text));
              }
            } catch {}
          }
        }
      } catch {}
      controller.close();
    }
  });

  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
};

async function storage(body, table) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) return json({ error: "Document storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify settings." }, 500);
  const sb = (path, opts = {}) => fetch(base + "/rest/v1/" + path, {
    ...opts,
    headers: { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  try {
    if (body.action === "save") {
      if (!body.client || !body.html) return json({ error: "Need a client and the document" }, 400);
      const r = await sb(table, {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify({ client: String(body.client).trim(), html: body.html, meta: body.meta || {} })
      });
      if (!r.ok) return json({ error: "Could not save (" + r.status + ")" }, 502);
      const rows = await r.json();
      return json({ ok: true, id: rows[0] && rows[0].id });
    }
    if (body.action === "list") {
      const q = table + "?select=id,client,created_at,meta" +
        (body.client ? "&client=eq." + encodeURIComponent(String(body.client).trim()) : "") +
        "&order=created_at.desc&limit=15";
      const r = await sb(q);
      if (!r.ok) return json({ error: "Could not list (" + r.status + ")" }, 502);
      return json({ ok: true, docs: await r.json() });
    }
    if (body.action === "get") {
      if (!body.id) return json({ error: "Need an id" }, 400);
      const r = await sb(table + "?select=*&id=eq." + encodeURIComponent(body.id) + "&limit=1");
      if (!r.ok) return json({ error: "Could not load (" + r.status + ")" }, 502);
      const rows = await r.json();
      if (!rows.length) return json({ error: "Not found" }, 404);
      return json({ ok: true, doc: rows[0] });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: "Server error: " + (e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
