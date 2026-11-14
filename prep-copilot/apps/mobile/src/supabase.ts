import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { decode } from "base64-arraybuffer";

export const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

export type Item = {
  id: string;
  source: "desktop" | "mobile";
  prompt: string | null;
  image_path: string | null;
  answer: string | null;
  status: "pending" | "done" | "error";
  created_at: string;
};

export type Turn = { role: "user" | "assistant"; content: string };

export type MockSession = { id: string; role_title: string; messages: Turn[]; created_at: string };

/** Upload a photo (if any), create the item, and ask the coach to explain it. */
export async function submitItem(userId: string, prompt: string, jpegBase64?: string) {
  let image_path: string | null = null;
  if (jpegBase64) {
    image_path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const { error } = await supabase.storage.from("captures").upload(image_path, decode(jpegBase64), { contentType: "image/jpeg" });
    if (error) throw error;
  }
  const { data, error } = await supabase.from("items").insert({ source: "mobile", prompt: prompt || null, image_path }).select().single();
  if (error) throw error;
  supabase.functions.invoke("coach", { body: { type: "explain", item_id: data.id } });
  return data as Item;
}

/** Light Markdown cleanup for plain Text rendering. */
export const plain = (md: string) => md.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/`{3}\w*\n?/g, "");
