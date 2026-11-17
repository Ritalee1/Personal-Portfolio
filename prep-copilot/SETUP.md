# Prep Copilot — Setup & Install Guide

Prep Copilot helps you prepare for interviews and assessments. It has a
**desktop app** (Windows/Mac) and a **mobile app** (Android/iPhone), which sync
through the same account.

- **Study feed** — capture a screenshot or photo of practice material and get a
  step-by-step explanation.
- **Interview** — a practice interviewer that tailors questions to your CV. You
  lead each turn by voice or text; it replies in text.

---

## Quick guide: which option is for you?

| You have…                     | Best option                        |
| ----------------------------- | ---------------------------------- |
| A **Windows** laptop          | Install the **Windows `.exe`** (easiest) |
| An **Android** phone          | Install the **`.apk`**             |
| An **iPhone**                 | Use **Expo Go** (free) — see notes |
| You're a developer            | Run from source (bottom section)   |

> **Note on iPhone:** Apple does not allow installing a standalone app on an
> iPhone without a paid Apple Developer account ($99/yr). The free way is
> **Expo Go** (a laptop must run the dev server). There is no iPhone equivalent
> of the Android `.apk`.

---

## Option 1 — Windows app (`.exe`)  ✅ easiest

### If someone sent you the installer
1. Double-click the `Prep Copilot Setup x.x.x.exe` file.
2. If Windows SmartScreen warns "unknown publisher", click **More info → Run anyway**
   (the app is safe; it's just not code-signed).
3. Follow the installer, then open **Prep Copilot** from the Start menu.
4. Create an account (or sign in) and you're ready.

### To build the installer yourself
You need **Node.js** (https://nodejs.org, LTS version) installed.

```bash
cd Personal-Portfolio/prep-copilot/apps/desktop
```

Create a file named `.env` in that folder with:

```
VITE_SUPABASE_URL=https://xblvpcmzvnsmzlfnprlg.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_V5DRJu_ROxMPDDXYyBYb9g_5a_HpKzc
```

Then:

```bash
npm install
npm run dist:win
```

The installer appears in `apps/desktop/release/`. Share that `.exe`.

**Desktop shortcuts:** `Ctrl+Shift+S` capture screen · `Ctrl+Shift+H` hide/show
the window · **🎤 Speak answer** button records your voice in an interview.

---

## Option 2 — Android app (`.apk`)

### If someone sent you the APK / build link
1. Open the link on your phone (or tap the downloaded `.apk`).
2. Android will ask to allow **"Install unknown apps"** for your browser/files —
   allow it, then install.
3. Open **Prep Copilot** and sign in.

### To build the APK yourself
You need **Node.js** and a free **Expo account** (https://expo.dev).

```bash
cd Personal-Portfolio/prep-copilot/apps/mobile
npm install
npm install -g eas-cli
eas login
npm run build:apk
```

When it finishes, open the build URL to download/install the `.apk`.

---

## Option 3 — iPhone (Expo Go, free)

A Windows or Mac laptop runs the app; the iPhone connects to it with the free
**Expo Go** app. (The laptop must be running while you use it.)

### One-time on the laptop
Install **Node.js** (https://nodejs.org, LTS) and **Git** (https://git-scm.com).
Then:

```bash
git clone https://github.com/Ritalee1/Personal-Portfolio.git
cd Personal-Portfolio/prep-copilot/apps/mobile
```

Create a file named `.env` in that folder with:

```
EXPO_PUBLIC_SUPABASE_URL=https://xblvpcmzvnsmzlfnprlg.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_V5DRJu_ROxMPDDXYyBYb9g_5a_HpKzc
```

Then install dependencies (once):

```bash
npm install
```

### One-time on the iPhone
Install **Expo Go** from the App Store.

### Each time you want to use it
On the laptop:

```bash
npx expo start --tunnel
```

(The first run may ask to install `@expo/ngrok` — type **y**.) A QR code appears.
On the iPhone, open the **Camera**, point it at the QR code, and tap the banner —
it opens in Expo Go. Sign in with your own account.

On the phone, tap the **microphone on your keyboard** to answer by voice.

---

## Developer setup (run from source)

Requires **Node.js** (LTS).

**Desktop (dev mode):**

```bash
cd Personal-Portfolio/prep-copilot/apps/desktop
npm install
# create .env as shown in Option 1
npm run dev
```

**Mobile (dev mode):**

```bash
cd Personal-Portfolio/prep-copilot/apps/mobile
npm install
# create .env as shown in Option 3
npx expo start        # add --tunnel to use a phone on another network
```

**Backend (Supabase):** the database and the `coach` edge function live under
`prep-copilot/supabase/`. The function needs these secrets set in Supabase:
`ANTHROPIC_API_KEY` (interview/explanation AI) and `STT_API_KEY` (voice-to-text;
set `STT_BASE_URL` and `STT_MODEL` too if using a provider other than OpenAI).

```bash
cd Personal-Portfolio/prep-copilot
supabase functions deploy coach
```

---

## Accounts you may need

- **Supabase** — backend (already configured; keys above are the public ones).
- **Expo** (free) — only to build the Android `.apk`.
- **Groq or OpenAI** (voice-to-text key) — only if you re-deploy the backend.
- **Apple Developer** ($99/yr) — only if you want the app on real iPhones via
  TestFlight / the App Store (not needed for Expo Go).
