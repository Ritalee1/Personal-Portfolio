// Supabase Edge Function: the shared "brain" for the desktop and mobile apps.
// The Anthropic API key lives only here (as a function secret), never on a device.
//
//   POST { type: "explain", item_id }            -> explains a captured study item
//   POST { type: "mock", session_id, answer? }   -> mock interviewer: feedback + next question
//
// Deploy:  supabase functions deploy coach
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";

const EXPLAIN_SYSTEM = `You are a patient study tutor helping someone prepare for job interviews and skills assessments.
The user shares a screenshot or a question from their practice material.
- Identify what the question or problem is asking.
- Teach the underlying concept first, then walk through the solution step by step.
- For code, give a clean solution with complexity analysis and one alternative approach.
- End with 2-3 short follow-up questions an interviewer might ask, so the user can practise.
Use Markdown. Keep it focused and readable on a phone screen.`;

const mockSystem = (role: string) => `You are a realistic but encouraging interviewer running a practice interview for a "${role}" position.
Run one question at a time. When the candidate answers:
1. Give brief, specific feedback: what was strong, what was missing, and a stronger way to phrase it (use STAR for behavioural questions).
2. Score the answer out of 10.
3. Ask the next question, mixing behavioural, situational and role-specific technical questions.
If there is no answer yet, briefly introduce yourself and ask the first question.
Format: "**Feedback:** ...\\n**Score:** x/10\\n\\n**Next question:** ..." (omit feedback and score for the first question).`;

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function askClaude(system: string, messages: Anthropic.Beta.BetaMessageParam[]): Promise<string> {
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If the primary model declines, the API retries on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages,
  });
  if (response.stop_reason === "refusal") {
    throw new Error(response.stop_details?.explanation ?? "The model declined this request.");
  }
  return response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

async function explain(db: SupabaseClient, itemId: string) {
  const { data: item, error } = await db.from("items").select("*").eq("id", itemId).single();
  if (error || !item) return json({ error: "Item not found" }, 404);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (item.image_path) {
    const { data: file, error: dlError } = await db.storage.from("captures").download(item.image_path);
    if (dlError || !file) return json({ error: "Could not load image" }, 500);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const mediaType = item.image_path.endsWith(".jpg") ? "image/jpeg" : "image/png";
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: btoa(binary) } });
  }
  content.push({ type: "text", text: item.prompt?.trim() || "Explain this so I can learn how to solve it." });

  try {
    const answer = await askClaude(EXPLAIN_SYSTEM, [{ role: "user", content }]);
    await db.from("items").update({ answer, status: "done" }).eq("id", itemId);
    return json({ answer });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("items").update({ answer: message, status: "error" }).eq("id", itemId);
    return json({ error: message }, 502);
  }
}

type Turn = { role: "user" | "assistant"; content: string };

async function mock(db: SupabaseClient, sessionId: string, answer?: string) {
  const { data: session, error } = await db.from("mock_sessions").select("*").eq("id", sessionId).single();
  if (error || !session) return json({ error: "Session not found" }, 404);

  const history: Turn[] = session.messages ?? [];
  if (answer?.trim()) history.push({ role: "user", content: answer.trim() });
  // The API needs the conversation to start with a user turn.
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: "I'm ready to start the practice interview." },
    ...history,
  ];

  try {
    const reply = await askClaude(mockSystem(session.role_title), messages);
    history.push({ role: "assistant", content: reply });
    await db.from("mock_sessions").update({ messages: history, updated_at: new Date().toISOString() }).eq("id", sessionId);
    return json({ reply });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Act as the signed-in user so row-level security applies to every query.
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return json({ error: "Not signed in" }, 401);

  const body = await req.json().catch(() => ({}));
  if (body.type === "explain" && body.item_id) return explain(db, body.item_id);
  if (body.type === "mock" && body.session_id) return mock(db, body.session_id, body.answer);
  return json({ error: "Unknown request" }, 400);
});
