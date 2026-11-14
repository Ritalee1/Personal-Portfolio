import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

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

export type MockSession = {
  id: string;
  role_title: string;
  messages: Turn[];
  created_at: string;
};

declare global {
  interface Window {
    copilot: {
      captureScreen(): Promise<string>;
      onCaptured(cb: (pngBase64: string) => void): () => void;
      onCaptureError(cb: (message: string) => void): () => void;
    };
  }
}

/** Upload an image (if any), create the item, and ask the coach to explain it. */
export async function submitItem(userId: string, prompt: string, pngBase64?: string) {
  let image_path: string | null = null;
  if (pngBase64) {
    const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    image_path = `${userId}/${crypto.randomUUID()}.png`;
    const { error } = await supabase.storage.from("captures").upload(image_path, bytes, { contentType: "image/png" });
    if (error) throw error;
  }
  const { data, error } = await supabase
    .from("items")
    .insert({ source: "desktop", prompt: prompt || null, image_path })
    .select()
    .single();
  if (error) throw error;
  // Fire and forget: the answer arrives through Realtime on every device.
  supabase.functions.invoke("coach", { body: { type: "explain", item_id: data.id } });
  return data as Item;
}
