// Supabase Edge Function: the shared "brain" for the desktop and mobile apps.
// The Anthropic API key lives only here (as a function secret), never on a device.
//
//   POST { type: "explain", item_id }             -> explains a captured study item
//   POST { type: "mock", session_id, answer? }    -> mock interviewer: feedback + next question
//   POST { type: "audio_qa", prompt }             -> lightning-fast real-time prompt/audio Q&A
//
// Deploy:   supabase functions deploy coach
// Secret:   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

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

const mockSystem = (role: string, cv?: string | null) => `You are a realistic but encouraging interviewer running a practice interview for a "${role}" position.
The candidate speaks first — usually a self-introduction or just saying they're ready.
- For that opening turn: give a brief, warm acknowledgement (no score), then ask your first question.
- For every later answer:
  1. Give brief, specific feedback: what was strong, what was missing, and a stronger way to phrase it (use STAR for behavioural questions).
  2. Score the answer out of 10.
  3. Ask the next question, mixing behavioural, situational and role-specific technical questions.
Run one question at a time.
Format for scored turns: "**Feedback:** ...\n**Score:** x/10\n\n**Next question:** ..." (omit feedback and score for the opening turn).${
  cv
    ? `\n\nThe candidate's CV/resume is below. Tailor your questions to their real background: dig into specific roles, projects and skills they list, and probe any gaps or short tenures. Reference concrete details from it.\n<cv>\n${cv}\n</cv>`
    : ""
}`;

const CV_EXTRACT_SYSTEM = `Extract the full text of this CV/resume as clean, plain text.
Preserve the structure (name, summary, work experience with dates, education, skills).
Output only the extracted text, with no commentary, preamble or Markdown fences.`;

const AUDIO_QA_SYSTEM = `You are a lightning-fast technical and interview copilot. Answer the user's question instantly with precise, concise, and structured bullet points optimized for quick reading or text-to-speech.`;

// Created on first use, so a missing key shows up as a readable error on the item
// instead of crashing the whole function at startup.
let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Add it under Edge Functions > Secrets in Supabase.");
  return (anthropic ??= new Anthropic({ apiKey }));
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function askClaude(system: string, messages: Anthropic.Beta.BetaMessageParam[]): Promise<string> {
  const response = await getAnthropic().beta.messages.create({
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

  try {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (item.image_path) {
      const { data: file, error: dlError } = await db.storage.from("captures").download(item.image_path);
      if (dlError || !file) throw new Error(`Could not load the image: ${dlError?.message ?? "not found"}`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const mediaType = item.image_path.endsWith(".jpg") ? "image/jpeg" : "image/png";
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: btoa(binary) } });
    }
    content.push({ type: "text", text: item.prompt?.trim() || "Explain this so I can learn how to solve it." });

    const answer = await askClaude(EXPLAIN_SYSTEM, [{ role: "user", content }]);
    await db.from("items").update({ answer, status: "done" }).eq("id", itemId);
    return json({ answer });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("explain failed:", message);
    await db.from("items").update({ answer: `Error: ${message}`, status: "error" }).eq("id", itemId);
    return json({ error: message }, 502);
  }
}

type Turn = { role: "user" | "assistant"; content: string };

async function mock(db: SupabaseClient, sessionId: string, answer?: string) {
  const { data: session, error } = await db.from("mock_sessions").select("*").eq("id", sessionId).single();
  if (error || !session) return json({ error: "Session not found" }, 404);

  const history: Turn[] = session.messages ?? [];
  if (answer?.trim()) history.push({ role: "user", content: answer.trim() });
  // The candidate speaks first, so history already starts with a user turn.
  // Only add a synthetic opener if somehow it doesn't (keeps the API happy).
  const messages: Anthropic.Beta.BetaMessageParam[] =
    history.length && history[0].role === "user"
      ? (history as Anthropic.Beta.BetaMessageParam[])
      : [{ role: "user", content: "I'm ready to start the interview." }, ...history];

  // Load the candidate's CV (if any) so the interviewer can tailor questions.
  const { data: profile } = await db.from("profiles").select("cv_text").maybeSingle();

  try {
    const reply = await askClaude(mockSystem(session.role_title, profile?.cv_text), messages);
    history.push({ role: "assistant", content: reply });
    await db.from("mock_sessions").update({ messages: history, updated_at: new Date().toISOString() }).eq("id", sessionId);
    return json({ reply });
  } catch (e) {
    console.error("mock failed:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

// Read an uploaded CV (PDF or image) from storage, extract it to plain text
// with Claude, and save it on the user's profile for use in mock interviews.
async function setCv(db: SupabaseClient, userId: string, filePath: string, cvName?: string) {
  try {
    const { data: file, error: dlError } = await db.storage.from("captures").download(filePath);
    if (dlError || !file) throw new Error(`Could not load the file: ${dlError?.message ?? "not found"}`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(binary);

    const lower = filePath.toLowerCase();
    const block: Anthropic.Beta.BetaContentBlockParam = lower.endsWith(".pdf")
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: lower.endsWith(".png") ? "image/png" : "image/jpeg", data: b64 } };

    const cvText = await askClaude(CV_EXTRACT_SYSTEM, [
      { role: "user", content: [block, { type: "text", text: "Extract this CV as clean plain text." }] },
    ]);

    const { error: upErr } = await db
      .from("profiles")
      .upsert({ user_id: userId, cv_text: cvText, cv_name: cvName ?? null, updated_at: new Date().toISOString() });
    if (upErr) throw upErr;

    return json({ cv_text: cvText, cv_name: cvName ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("set_cv failed:", message);
    return json({ error: message }, 502);
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Transcribe recorded audio to text via an OpenAI-compatible Whisper endpoint.
// Works with OpenAI (default) or any compatible provider (e.g. Groq) by setting
// STT_BASE_URL / STT_MODEL. Key lives only here as a function secret.
async function transcribe(audioB64: string, mime = "audio/webm") {
  const key = Deno.env.get("STT_API_KEY");
  if (!key) return json({ error: "Voice input isn't set up yet. Add STT_API_KEY in the coach function's secrets." }, 500);
  const baseUrl = Deno.env.get("STT_BASE_URL") ?? "https://api.openai.com/v1";
  const model = Deno.env.get("STT_MODEL") ?? "whisper-1";
  try {
    const bytes = b64ToBytes(audioB64);
    const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), `audio.${ext}`);
    form.append("model", model);
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    return json({ text: data.text ?? "" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("transcribe failed:", message);
    return json({ error: message }, 502);
  }
}

async function audioQa(db: SupabaseClient, prompt: string) {
  try {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    const reply = await askClaude(AUDIO_QA_SYSTEM, messages);
    return json({ reply });
  } catch (e) {
    console.error("audio_qa failed:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // Act as the signed-in user so row-level security applies to every query.
    // The app sends its public key in the "apikey" header; fall back to the project's default.
    const publicKey = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY");
    if (!publicKey) return json({ error: "Missing Supabase public key" }, 500);
    const db = createClient(Deno.env.get("SUPABASE_URL")!, publicKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: auth, error: authError } = await db.auth.getUser();
    if (!auth.user) {
      console.error("auth failed:", authError?.message);
      return json({ error: "Not signed in" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    if (body.type === "explain" && body.item_id) return await explain(db, body.item_id);
    if (body.type === "mock" && body.session_id) return await mock(db, body.session_id, body.answer);
    if (body.type === "set_cv" && body.image_path) return await setCv(db, auth.user.id, body.image_path, body.cv_name);
    if (body.type === "transcribe" && body.audio) return await transcribe(body.audio, body.mime);
    if (body.type === "audio_qa" && body.prompt) return await audioQa(db, body.prompt);
    
    return json({ error: "Unknown request" }, 400);
  } catch (e) {
    console.error("coach crashed:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
