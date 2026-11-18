import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Markdown from "react-markdown";
import { supabase, submitItem, type Item, type MockSession } from "./supabase";

type Toast = { kind: "info" | "success" | "error"; text: string } | null;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<"study" | "mock">("study");
  const [toast, setToast] = useState<Toast>(null);

  // Show a toast for a few seconds, then clear it.
  const showToast = (t: Exclude<Toast, null>) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // Listen for remote "Capture PC" taps from the phone. The capture is grabbed
  // by the main process, then uploaded here where we hold the logged-in session.
  useEffect(() => {
    if (!session) return;
    const userId = session.user.id;
    const channel = supabase
      .channel("desktop-commands")
      .on("broadcast", { event: "trigger_capture" }, async () => {
        showToast({ kind: "info", text: "📸 Capturing screen (requested from phone)…" });
        try {
          const png = await window.copilot.captureScreen();
          await submitItem(userId, "Live capture from laptop (triggered from phone).", png);
          showToast({ kind: "success", text: "✅ Screenshot captured and sent to your feed" });
        } catch (e) {
          console.error("Remote capture failed:", e);
          showToast({ kind: "error", text: "⚠️ Capture failed: " + (e instanceof Error ? e.message : String(e)) });
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  if (!session) return <Login />;

  return (
    <div className="app">
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
      <header>
        <strong>Prep Copilot</strong>
        <nav>
          <button className={tab === "study" ? "active" : ""} onClick={() => setTab("study")}>Study</button>
          <button className={tab === "mock" ? "active" : ""} onClick={() => setTab("mock")}>Interview Assistant</button>
        </nav>
        <button className="secondary" onClick={() => window.copilot.hideWindow()} title="Hide the window (bring it back with Ctrl+Shift+H)">Hide</button>
        <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      {tab === "study" ? <Study userId={session.user.id} /> : <Mock userId={session.user.id} />}
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");

  const go = async (mode: "in" | "up") => {
    setMsg("");
    const fn = mode === "in" ? supabase.auth.signInWithPassword : supabase.auth.signUp;
    const { error } = await fn.call(supabase.auth, { email, password });
    setMsg(error ? error.message : mode === "up" ? "Account created. Check your email if confirmation is on." : "");
  };

  return (
    <div className="login">
      <h1>Prep Copilot</h1>
      <p>Sign in with the same account on your laptop and phone to keep them in sync.</p>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="row">
        <button onClick={() => go("in")}>Sign in</button>
        <button className="secondary" onClick={() => go("up")}>Create account</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function Study({ userId }: { userId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<string | undefined>(); // captured PNG waiting to be sent
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase
      .from("items")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => setItems((data as Item[]) ?? []));

    // Live sync: rows added or answered on any device show up here.
    const channel = supabase
      .channel("items")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const oldId = (payload.old as { id?: string }).id;
          if (oldId) setItems((prev) => prev.filter((i) => i.id !== oldId));
          return;
        }
        const row = payload.new as Item;
        setItems((prev) => [row, ...prev.filter((i) => i.id !== row.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      })
      .subscribe();

    const offCap = window.copilot.onCaptured((png) => setPending(png));
    const offErr = window.copilot.onCaptureError((m) => setError(m));
    return () => {
      supabase.removeChannel(channel);
      offCap();
      offErr();
    };
  }, []);

  const send = async () => {
    if (!prompt.trim() && !pending) return;
    setBusy(true);
    setError("");
    try {
      await submitItem(userId, prompt, pending);
      setPrompt("");
      setPending(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (id: string, imagePath?: string | null) => {
    if (!confirm("Delete this item? This can't be undone.")) return;
    try {
      if (imagePath) await supabase.storage.from("captures").remove([imagePath]);
      await supabase.from("items").delete().eq("id", id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main>
      <section className="composer">
        <p className="muted">
          Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> (or the button) to capture practice material on screen, add a note, and get a
          step-by-step explanation.
        </p>
        {pending && <img className="preview" src={`data:image/png;base64,${pending}`} alt="Captured screen" />}
        <textarea
          placeholder="Optional: what do you want to understand about this? Or type a practice question."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="row">
          <button className="secondary" onClick={async () => setPending(await window.copilot.captureScreen())}>Capture screen</button>
          {pending && <button className="secondary" onClick={() => setPending(undefined)}>Discard capture</button>}
          <button disabled={busy} onClick={send}>{busy ? "Sending..." : "Explain"}</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
      {items.map((item) => <ItemCard key={item.id} item={item} onDelete={() => deleteItem(item.id, item.image_path)} />)}
    </main>
  );
}

function ItemCard({ item, onDelete }: { item: Item; onDelete: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (item.image_path)
      supabase.storage.from("captures").createSignedUrl(item.image_path, 3600).then(({ data }) => setUrl(data?.signedUrl));
  }, [item.image_path]);

  return (
    <article className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="meta">{item.source === "mobile" ? "From phone" : "From laptop"} · {new Date(item.created_at).toLocaleString()}</span>
        <button className="link" style={{ color: "var(--error)" }} onClick={onDelete}>Delete</button>
      </div>
      {url && <img className="thumb" src={url} alt="" />}
      {item.prompt && <p><em>{item.prompt}</em></p>}
      {item.status === "pending" ? <p className="muted">Thinking...</p> : <div className={item.status === "error" ? "error" : ""}><Markdown>{item.answer ?? ""}</Markdown></div>}
    </article>
  );
}

function Mock({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<MockSession[]>([]);
  const [current, setCurrent] = useState<MockSession | null>(null);
  const [roleTitle, setRoleTitle] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [cvName, setCvName] = useState<string | null>(null);
  const [cvBusy, setCvBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const toggleMic = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const b64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          const { data, error } = await supabase.functions.invoke("coach", { body: { type: "transcribe", audio: b64, mime: "audio/webm" } });
          if (error) throw error;
          if (data?.text) setAnswer((prev) => (prev ? prev.trim() + " " : "") + data.text.trim());
        } catch (e) {
          alert("Could not transcribe: " + (e instanceof Error ? e.message : String(e)));
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (e) {
      alert("Microphone error: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  useEffect(() => {
    supabase.from("mock_sessions").select("*").order("updated_at", { ascending: false }).limit(20)
      .then(({ data }) => setSessions((data as MockSession[]) ?? []));
  }, [current?.id]);

  useEffect(() => {
    supabase.from("profiles").select("cv_name").maybeSingle().then(({ data }) => setCvName(data?.cv_name ?? null));
  }, []);

  const uploadCv = async (file: File) => {
    setCvBusy(true);
    try {
      const ext = (file.name.split(".").pop() || "pdf").toLowerCase();
      const path = `${userId}/cv-${Date.now()}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { error: upErr } = await supabase.storage.from("captures").upload(path, bytes, { contentType: file.type || undefined, upsert: true });
      if (upErr) throw upErr;
      const { error } = await supabase.functions.invoke("coach", { body: { type: "set_cv", image_path: path, cv_name: file.name } });
      if (error) throw error;
      setCvName(file.name);
    } catch (e) {
      alert("Could not add CV: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCvBusy(false);
    }
  };

  const turn = async (session: MockSession, text?: string) => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("coach", { body: { type: "mock", session_id: session.id, answer: text } });
    setBusy(false);
    if (error) return alert(error.message);
    const { data: fresh } = await supabase.from("mock_sessions").select("*").eq("id", session.id).single();
    setCurrent(fresh as MockSession);
    // Interviewer replies in text only — no speaking aloud.
    void data;
  };

  const start = async () => {
    if (!roleTitle.trim()) return;
    const { data, error } = await supabase.from("mock_sessions").insert({ role_title: roleTitle.trim() }).select().single();
    if (error) return alert(error.message);
    // Don't call the AI yet — the candidate speaks first.
    setCurrent(data as MockSession);
  };

  const deleteSession = async (id: string) => {
    if (!confirm("Delete this practice interview? This can't be undone.")) return;
    const { error } = await supabase.from("mock_sessions").delete().eq("id", id);
    if (error) return alert(error.message);
    setSessions((prev) => prev.filter((m) => m.id !== id));
    if (current?.id === id) setCurrent(null);
  };

  if (!current)
    return (
      <main>
        <section className="composer">
          <h2>Interview Assistant</h2>
          <p className="muted">Enter the role, then tell Maya what you want to work on — she follows your lead.</p>
          <input placeholder="Role, e.g. Virtual Assistant" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
          <div className="row">
            <button disabled={busy} onClick={start}>Start</button>
            <label className="secondary" style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer" }}>
              {cvBusy ? "Reading CV..." : cvName ? "Replace CV" : "Add CV"}
              <input
                type="file"
                accept=".pdf,image/*"
                style={{ display: "none" }}
                disabled={cvBusy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCv(f); e.target.value = ""; }}
              />
            </label>
          </div>
          <p className="muted">
            {cvName ? `CV added: ${cvName} — interviews will use it.` : "Add your CV (PDF or image) so the interviewer asks questions based on your experience."}
          </p>
        </section>
        {sessions.map((m) => (
          <article key={m.id} className="card" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <span className="clickable" style={{ flex: 1 }} onClick={() => setCurrent(m)}>
              <strong>{m.role_title}</strong> <span className="muted">· {m.messages.length} turns · {new Date(m.created_at).toLocaleDateString()}</span>
            </span>
            <button className="link" style={{ color: "var(--error)" }} onClick={() => deleteSession(m.id)}>Delete</button>
          </article>
        ))}
      </main>
    );

  return (
    <main>
      <div className="row">
        <button className="secondary" onClick={() => setCurrent(null)}>Back</button>
      </div>
      <h2>{current.role_title}</h2>
      {current.messages.length === 0 && (
        <article className="card">
          <p className="muted">Hi, I'm Maya 👋 — your assistant for <strong>{current.role_title}</strong> prep. Tell me what you'd like to work on: practise specific questions, polish an answer, quiz you on a topic, or tackle a weak area. Type or use the mic.</p>
        </article>
      )}
      {current.messages.map((m, i) => (
        <article key={i} className={`card ${m.role}`}>
          <div className="meta">{m.role === "assistant" ? "Maya" : "You"}</div>
          <Markdown>{m.content}</Markdown>
        </article>
      ))}
      <section className="composer">
        <textarea placeholder="Type your answer, or tap the mic and speak..." value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <div className="row">
          <button
            className="secondary"
            disabled={transcribing}
            onClick={toggleMic}
            style={recording ? { borderColor: "var(--error)", color: "var(--error)" } : undefined}
          >
            {recording ? "⏹ Stop recording" : transcribing ? "Transcribing..." : "🎤 Speak answer"}
          </button>
          <button disabled={busy || !answer.trim()} onClick={async () => { const a = answer; setAnswer(""); await turn(current, a); }}>
            {busy ? "Interviewer is thinking..." : "Submit answer"}
          </button>
        </div>
      </section>
    </main>
  );
}
