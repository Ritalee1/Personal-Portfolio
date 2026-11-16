# Prep Copilot

A personal interview and assessment **practice** coach that runs on two devices:

| App | Tech | What you get |
|---|---|---|
| `apps/desktop` | Electron + React | Installable Windows `.exe` (also macOS `.dmg` and Linux AppImage) |
| `apps/mobile` | Expo / React Native | Android `.apk` for sideloading, or `.aab` for Google Play |
| `supabase/` | Postgres, Storage, Realtime, Edge Function | Login, sync between devices, and the Claude-powered `coach` function |

**Features**
- **Capture and explain**: press `Ctrl+Shift+S` on the laptop (or use the phone camera) on practice material (a coding problem, an aptitude question, a case study). Claude teaches the concept and walks through the solution, then gives follow-up questions to practise.
- **Mock interviews**: pick a role. The AI interviewer asks one question at a time, scores your answer, and gives specific feedback. You can have the questions read aloud and dictate your answers.
- **Live sync**: anything captured or answered on one device shows up on the other within a second (Supabase Realtime).

The Anthropic API key lives only in the Supabase Edge Function, never inside the apps.

---

## 1. Backend (one-time, about 10 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from `prep-copilot/` run:
   ```bash
   supabase login
   ```
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   ```
   ```bash
   supabase db push
   ```
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```
   ```bash
   supabase functions deploy coach
   ```
3. Get your **Project URL** and **anon key** from *Project Settings → API*. Both apps need them.
4. Optional: turn off *Confirm email* under *Authentication → Providers → Email* so new accounts work straight away.

## 2. Laptop app (.exe)

```bash
cd apps/desktop
```
```bash
cp .env.example .env   # paste your URL and anon key
```
```bash
npm install
```
```bash
npm run dev            # run it locally
```
```bash
npm run dist:win       # builds release/Prep Copilot Setup 0.1.0.exe (run on Windows)
```

**No Windows machine handy?** Push this repo to GitHub, add the repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then run the **Prep Copilot - Windows installer** workflow from the Actions tab. Download the `.exe` from the run's artifacts.

Windows SmartScreen will warn about an unsigned installer. Click *More info → Run anyway*, or buy a code-signing certificate later.

## 3. Phone app (Android)

```bash
cd apps/mobile
```
```bash
cp .env.example .env   # same URL and anon key
```
```bash
npm install
```
```bash
npx expo start         # scan the QR code with the Expo Go app to try it
```

Installable builds use EAS (Expo's build service, with a free tier):

```bash
npm install -g eas-cli
```
```bash
eas login
```
```bash
npm run build:apk          # .apk you can install directly on your phone
```
```bash
npm run build:playstore    # .aab to upload to Google Play Console
```

EAS builds don't read your local `.env`. Add the two `EXPO_PUBLIC_*` values as EAS environment variables (`eas env:create`) or in the Expo dashboard before building. Publishing on Google Play needs a Play Console developer account (one-time $25 fee). Then you create the app listing and upload the `.aab`.

---

## How it fits together

```
 Laptop (Electron)                         Phone (Expo)
  Ctrl+Shift+S → screenshot                 camera / photo / typed question
        │                                          │
        └──► Supabase Storage + items table ◄──────┘
                         │   ▲
           invoke "coach"│   │ answer written back to the row
                         ▼   │
                 Edge Function → Claude API
                         │
          Realtime pushes the update to both devices
```

## Project layout

```
prep-copilot/
├── supabase/migrations/0001_init.sql   tables, row-level security, storage bucket
├── supabase/functions/coach/index.ts   Claude calls (explain + mock interview)
├── apps/desktop/electron/              main process: window, hotkey, screen capture
├── apps/desktop/src/                   React UI
└── apps/mobile/App.tsx                 React Native UI
```
