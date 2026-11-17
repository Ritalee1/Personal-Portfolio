import { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Platform, Pressable,
  SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, View, useColorScheme,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import * as Speech from "expo-speech";
import type { Session } from "@supabase/supabase-js";
import { plain, submitItem, supabase, type Item, type MockSession } from "./src/supabase";

const light = { bg: "#f6f7fb", card: "#fff", text: "#1b1d24", muted: "#6b7080", border: "#e3e5ee", accent: "#4f46e5", error: "#c0392b" };
const dark = { bg: "#14151a", card: "#1e2028", text: "#e8e9ef", muted: "#9a9fb0", border: "#2e313c", accent: "#6d66f0", error: "#e57368" };
type Theme = typeof light;

export default function App() {
  const t = useColorScheme() === "dark" ? dark : light;
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<"feed" | "mock">("feed");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style="auto" />
      {!session ? (
        <Login t={t} />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={[s.header, { borderColor: t.border, backgroundColor: t.card }]}>
            <Tab t={t} label="Study feed" active={tab === "feed"} onPress={() => setTab("feed")} />
            <Tab t={t} label="Mock interview" active={tab === "mock"} onPress={() => setTab("mock")} />
            <Pressable onPress={() => supabase.auth.signOut()}><Text style={{ color: t.muted }}>Sign out</Text></Pressable>
          </View>
          {tab === "feed" ? <Feed t={t} userId={session.user.id} /> : <Mock t={t} />}
        </View>
      )}
    </SafeAreaView>
  );
}

function Tab({ t, label, active, onPress }: { t: Theme; label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.tab, { borderColor: active ? t.accent : t.border, backgroundColor: active ? t.accent : "transparent" }]}>
      <Text style={{ color: active ? "#fff" : t.text, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Button({ t, label, onPress, disabled, secondary }: { t: Theme; label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[s.button, secondary ? { borderWidth: 1, borderColor: t.border } : { backgroundColor: t.accent }, disabled && { opacity: 0.6 }]}
    >
      <Text style={{ color: secondary ? t.text : "#fff", fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Login({ t }: { t: Theme }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const go = async (mode: "in" | "up") => {
    const { error } =
      mode === "in" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });
    setMsg(error ? error.message : mode === "up" ? "Account created. Check your email if confirmation is on." : "");
  };
  const input = [s.input, { color: t.text, borderColor: t.border, backgroundColor: t.card }];
  return (
    <View style={{ padding: 24, gap: 12, marginTop: 60 }}>
      <Text style={[s.h1, { color: t.text }]}>Prep Copilot</Text>
      <Text style={{ color: t.muted }}>Use the same account as on your laptop to sync.</Text>
      <TextInput style={input} placeholder="Email" placeholderTextColor={t.muted} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <TextInput style={input} placeholder="Password" placeholderTextColor={t.muted} secureTextEntry value={password} onChangeText={setPassword} />
      <Button t={t} label="Sign in" onPress={() => go("in")} />
      <Button t={t} label="Create account" secondary onPress={() => go("up")} />
      {!!msg && <Text style={{ color: t.muted }}>{msg}</Text>}
    </View>
  );
}

function Feed({ t, userId }: { t: Theme; userId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from("items").select("*").order("created_at", { ascending: false }).limit(50).then(({ data }) => setItems((data as Item[]) ?? []));
    
    // Live sync with the laptop: captures and answers appear here as they happen.
    const channel = supabase
      .channel("items-mobile")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, (payload) => {
        if (payload.eventType === "DELETE") {
          setItems((prev) => prev.filter((i) => i.id !== (payload.old as any).id));
          return;
        }
        const row = payload.new as Item;
        setItems((prev) => [row, ...prev.filter((i) => i.id !== row.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const send = async (fromCamera?: boolean) => {
    let image: string | undefined;
    if (fromCamera !== undefined) {
      const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return Alert.alert("Permission needed");
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.7 };
      const res = fromCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (res.canceled || !res.assets[0]?.base64) return;
      image = res.assets[0].base64;
    } else if (!prompt.trim()) return;
    setBusy(true);
    try {
      await submitItem(userId, prompt, image);
      setPrompt("");
    } catch (e) {
      Alert.alert("Could not send", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Remote desktop capture trigger via Supabase Realtime Broadcast.
  // A channel must be SUBSCRIBED before .send() will actually deliver.
  const triggerRemoteCapture = async () => {
    const channel = supabase.channel("desktop-commands");
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out reaching the laptop. Is the laptop app open and signed in?")), 8000);
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timeout);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(new Error("Could not connect to realtime."));
          }
        });
      });
      const res = await channel.send({
        type: "broadcast",
        event: "trigger_capture",
        payload: { timestamp: Date.now() },
      });
      if (res !== "ok") throw new Error("The laptop did not acknowledge the request.");
      Alert.alert("Capture triggered", "The laptop is taking a screenshot. It will appear in your feed in a moment.");
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? String(e));
    } finally {
      supabase.removeChannel(channel);
    }
  };

  // Delete item and remove its image from storage if present
  const deleteItem = async (itemId: string, imagePath?: string | null) => {
    try {
      if (imagePath) {
        await supabase.storage.from("captures").remove([imagePath]);
      }
      await supabase.from("items").delete().eq("id", itemId);
      setItems((prev) => prev.filter((i) => i.id !== itemId));
    } catch (e: any) {
      Alert.alert("Delete failed", e.message);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 100 }}
          ListHeaderComponent={
            <View style={[s.card, { backgroundColor: t.card, borderColor: t.border }]}>
              <TextInput
                style={[s.input, { color: t.text, borderColor: t.border, minHeight: 60 }]}
                placeholder="Ask a practice question, or add a note to a photo"
                placeholderTextColor={t.muted}
                multiline
                value={prompt}
                onChangeText={setPrompt}
              />
              <View style={s.row}>
                <Button t={t} label="Explain" disabled={busy} onPress={() => send()} />
                <Button t={t} label="Camera" secondary disabled={busy} onPress={() => send(true)} />
                <Button t={t} label="Photo" secondary disabled={busy} onPress={() => send(false)} />
              </View>
            </View>
          }
          renderItem={({ item }) => <ItemCard t={t} item={item} onDelete={() => deleteItem(item.id, item.image_path)} />}
        />
      </KeyboardAvoidingView>

      {/* Floating Action Button (FAB) to snap laptop screen in stealth mode */}
      <Pressable style={[s.fab, { backgroundColor: t.accent }]} onPress={triggerRemoteCapture}>
        <Text style={s.fabText}>📸 Capture PC</Text>
      </Pressable>
    </View>
  );
}

function ItemCard({ t, item, onDelete }: { t: Theme; item: Item; onDelete: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (item.image_path) supabase.storage.from("captures").createSignedUrl(item.image_path, 3600).then(({ data }) => setUrl(data?.signedUrl));
  }, [item.image_path]);
  return (
    <View style={[s.card, { backgroundColor: t.card, borderColor: t.border }]}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {item.source === "desktop" ? "From laptop" : "From phone"} · {new Date(item.created_at).toLocaleString()}
        </Text>
        <Pressable onPress={onDelete}>
          <Text style={{ color: t.error, fontSize: 12, fontWeight: "600" }}>Delete</Text>
        </Pressable>
      </View>
      {url && <Image source={{ uri: url }} style={s.thumb} resizeMode="contain" />}
      {!!item.prompt && <Text style={{ color: t.text, fontStyle: "italic" }}>{item.prompt}</Text>}
      {item.status === "pending" ? (
        <ActivityIndicator color={t.accent} />
      ) : (
        <Text selectable style={{ color: item.status === "error" ? t.error : t.text, lineHeight: 21 }}>{plain(item.answer ?? "")}</Text>
      )}
    </View>
  );
}

function Mock({ t }: { t: Theme }) {
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
    if (error) return Alert.alert("Error", error.message);
    const { data: fresh } = await supabase.from("mock_sessions").select("*").eq("id", session.id).single();
    setCurrent(fresh as MockSession);
    if (speak && data?.reply) {
      Speech.stop();
      Speech.speak(plain(data.reply));
    }
  };

  const start = async () => {
    if (!roleTitle.trim()) return;
    const { data, error } = await supabase.from("mock_sessions").insert({ role_title: roleTitle.trim() }).select().single();
    if (error) return Alert.alert("Error", error.message);
    setCurrent(data as MockSession);
    await turn(data as MockSession);
  };

  const deleteSession = async (sessionId: string) => {
    const { error } = await supabase.from("mock_sessions").delete().eq("id", sessionId);
    if (error) return Alert.alert("Error", error.message);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (current?.id === sessionId) setCurrent(null);
  };

  const card = [s.card, { backgroundColor: t.card, borderColor: t.border }];

  if (!current)
    return (
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={card}>
          <Text style={[s.h2, { color: t.text }]}>Start a practice interview</Text>
          <TextInput
            style={[s.input, { color: t.text, borderColor: t.border }]}
            placeholder="Role, e.g. Virtual Assistant"
            placeholderTextColor={t.muted}
            value={roleTitle}
            onChangeText={setRoleTitle}
          />
          <Button t={t} label="Start" disabled={busy} onPress={start} />
        </View>
        {sessions.map((m) => (
          <View key={m.id} style={[card, { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }]}>
            <Pressable style={{ flex: 1 }} onPress={() => setCurrent(m)}>
              <Text style={{ color: t.text, fontWeight: "600" }}>{m.role_title}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{m.messages.length} turns · {new Date(m.created_at).toLocaleDateString()}</Text>
            </Pressable>
            <Pressable onPress={() => deleteSession(m.id)}>
              <Text style={{ color: t.error, fontWeight: "600", fontSize: 12 }}>Delete</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Button t={t} label="Back" secondary onPress={() => { Speech.stop(); setCurrent(null); }} />
          <View style={s.row}>
            <Text style={{ color: t.muted }}>Read aloud</Text>
            <Switch value={speak} onValueChange={setSpeak} />
          </View>
        </View>
        <Text style={[s.h2, { color: t.text }]}>{current.role_title}</Text>
        {current.messages.map((m, i) => (
          <View key={i} style={[...card, m.role === "user" && { borderLeftWidth: 3, borderLeftColor: t.accent }]}>
            <Text style={{ color: t.muted, fontSize: 12 }}>{m.role === "assistant" ? "Interviewer" : "You"}</Text>
            <Text selectable style={{ color: t.text, lineHeight: 21 }}>{plain(m.content)}</Text>
          </View>
        ))}
        <TextInput
          style={[s.input, { color: t.text, borderColor: t.border, minHeight: 90 }]}
          placeholder="Type your answer, or tap the mic on your keyboard to dictate"
          placeholderTextColor={t.muted}
          multiline
          value={answer}
          onChangeText={setAnswer}
        />
        <Button
          t={t}
          label={busy ? "Interviewer is thinking..." : "Submit answer"}
          disabled={busy || !answer.trim()}
          onPress={async () => { const a = answer; setAnswer(""); await turn(current, a); }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderBottomWidth: 1 },
  tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: `8` as any, borderWidth: 1 },
  button: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: "center" },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 16, textAlignVertical: "top" },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  thumb: { width: "100%", height: 200, borderRadius: 8 },
  h1: { fontSize: 28, fontWeight: "700" },
  h2: { fontSize: 20, fontWeight: "700" },
  fab: { position: "absolute", right: 25, bottom: 25, width: 120, height: 48, borderRadius: 24, justifyContent: "center", alignItems: "center", elevation: 6, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3 },
  fabText: { color: "#fff", fontWeight: "bold", fontSize: 14 },
});
