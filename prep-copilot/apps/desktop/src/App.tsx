import { useEffect, useState } from "react";
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
          <button className={tab === "mock" ? "active" : ""} onClick={() => setTab("mock")}>Mock interview</button>
        </nav>
        <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      {tab === "study" ? <Study userId={session.user.id} /> : <Mock />}
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
        const row = payload.new as Item;
        if (payload.eventType === "DELETE") return;
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
      {items.map((item) => <ItemCard key={item.id} item={item} />)}
    </main>
  );
}

function ItemCard({ item }: { item: Item }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (item.image_path)
      supabase.storage.from("captures").createSignedUrl(item.image_path, 3600).then(({ data }) => setUrl(data?.signedUrl));
  }, [item.image_path]);

  return (
    <article className="card">
      <div className="meta">{item.source === "mobile" ? "From phone" : "From laptop"} · {new Date(item.created_at).toLocaleString()}</div>
      {url && <img className="thumb" src={url} alt="" />}
      {item.prompt && <p><em>{item.prompt}</em></p>}
      {item.status === "pending" ? <p className="muted">Thinking...</p> : <div className={item.status === "error" ? "error" : ""}><Markdown>{item.answer ?? ""}</Markdown></div>}
    </article>
  );
}

function Mock() {
  const [sessions, setSessions] = useState<MockSession[]>([]);
  const [current, setCurrent] = useState<MockSession | null>(null);
  const [roleTitle, setRoleTitle] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(true);

  useEffect(() => {
    supabase.from("mock_sessions").select("*").order("updated_at", { ascending: false }).limit(20)
      .then(({ data }) => setSessions((data as MockSession[]) ?? []));
  }, [current?.id]);

  const turn = async (session: MockSession, text?: string) => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("coach", { body: { type: "mock", session_id: session.id, answer: text } });
    setBusy(false);
    if (error) return alert(error.message);
    const { data: fresh } = await supabase.from("mock_sessions").select("*").eq("id", session.id).single();
    setCurrent(fresh as MockSession);
    if (speak && data?.reply) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(data.reply.replace(/[*#_`]/g, "")));
    }
  };

  const start = async () => {
    if (!roleTitle.trim()) return;
    const { data, error } = await supabase.from("mock_sessions").insert({ role_title: roleTitle.trim() }).select().single();
    if (error) return alert(error.message);
    setCurrent(data as MockSession);
    await turn(data as MockSession);
  };

  if (!current)
    return (
      <main>
        <section className="composer">
          <h2>Start a practice interview</h2>
          <input placeholder="Role, e.g. Virtual Assistant" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
          <button disabled={busy} onClick={start}>Start</button>
        </section>
        {sessions.map((s) => (
          <article key={s.id} className="card clickable" onClick={() => setCurrent(s)}>
            <strong>{s.role_title}</strong> <span className="muted">· {s.messages.length} turns · {new Date(s.created_at).toLocaleDateString()}</span>
          </article>
        ))}
      </main>
    );

  return (
    <main>
      <div className="row">
        <button className="secondary" onClick={() => setCurrent(null)}>Back</button>
        <label className="muted"><input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> Read questions aloud</label>
      </div>
      <h2>{current.role_title}</h2>
      {current.messages.map((m, i) => (
        <article key={i} className={`card ${m.role}`}>
          <div className="meta">{m.role === "assistant" ? "Interviewer" : "You"}</div>
          <Markdown>{m.content}</Markdown>
        </article>
      ))}
      <section className="composer">
        <textarea placeholder="Type (or dictate) your answer..." value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <button disabled={busy || !answer.trim()} onClick={async () => { const a = answer; setAnswer(""); await turn(current, a); }}>
          {busy ? "Interviewer is thinking..." : "Submit answer"}
        </button>
      </section>
    </main>
  );
}
