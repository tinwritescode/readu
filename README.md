# vTTS Reader (React Native, iOS first)

A reader that speaks text aloud with Vietnamese voices from the vTTS backend (Vbee behind it). The only actor is the user. Login is by email code. Speech needs the network, and the last 500 MB of audio is kept on the device.

## Status

The app has four screens: **Login**, **Library**, **Reader** and the **Voice** sheet.

| Use case | Status | Where |
| --- | --- | --- |
| Log in with an email code | **Implemented** (6-digit code via Resend, token kept in the Keychain (`VttsSpeech.m`), log out from the reader's "…" menu) | `src/ui/LoginScreen.tsx`, `src/adapters/speech/backend.ts`, `src/features/auth/session.ts`, `backend/auth.go`, `VttsSpeech.m` |
| Library with reading progress, kept across launches | **Implemented** (JSON in Application Support) | `src/features/library/library.ts`, `src/ui/LibraryScreen.tsx`, `VttsDocuments.m` (`loadLibrary` / `saveLibrary`) |
| Paste text | **Implemented** | `documentFromPaste` in `src/features/import/DocumentImporter.ts` |
| Import EPUB, PDF, Word (`.docx`), `.txt` | **Implemented** (one Files picker. EPUB and PDF are read by [Readium](https://github.com/readium/swift-toolkit) 3.11.0; Word is unzipped natively and parsed in JS) | `importDocument` in `DocumentImporter.ts`, `src/features/import/extractText.ts`, `VttsDocuments.m`, `VttsReadium.swift`, `VttsZip.m` |
| Read aloud with server voices | **Implemented** (one `POST /v1/speech` per sentence, two sentences fetched ahead, played by react-native-track-player) | `src/adapters/speech/playback.ts`, `src/adapters/speech/audioCache.ts`, `src/adapters/speech/backend.ts`, `src/features/reader/usePlayer.ts` |
| Offline audio cache | **Implemented** (500 MB, least recently used sentences removed first, in Caches) | `src/adapters/speech/audioCache.ts` |
| Lock screen and background playback | **Implemented** (play, pause, next and previous on the lock screen; `UIBackgroundModes: audio`) | `src/adapters/speech/playback.ts`, `Info.plist` |
| Resume where you stopped | **Implemented** (from the start of the bookmarked sentence) | `resumeOffset` in `src/features/reader/usePlayer.ts` |
| Highlight the sentence being read, dim what was read | **Implemented** (sentence level; the server gives no word timing) | `src/features/reader/textRanges.ts`, `src/ui/ReaderScreen.tsx` |
| Tap a sentence to read from it, skip by sentence, scrub | **Implemented** | `src/ui/ReaderScreen.tsx` |
| Choose voice | **Implemented** (all Vbee vi-VN voices from `GET /v1/voices`, preview on each row, default `s_hochiminh_female_hanhanvani_children_vc`) | `src/ui/VoicePicker.tsx`, `src/features/library/library.ts` |
| Choose speed (0.5–2×) | **Implemented** (the server takes up to 1.9, so 2× plays at 1.9; a change while playing restarts from the current sentence) | speed chip in `ReaderScreen.tsx` |
| Sleep timer (15–60 min) | **Implemented** (checked on each sentence) | `usePlayer.ts`, `SleepLabel` in `ReaderScreen.tsx` |
| Export audio (M4A / MP3 / WAV / M4B) | Stub | `src/features/export/AudioExporter.ts` |
| On-device translation (Apple Translation) | Stub | `src/adapters/translation/Translator.ts` |
| Backup + iCloud sync | Stub | `src/adapters/cloud/LibrarySync.ts` |
| Pronunciation fixes | Stub | `src/features/pronunciation/PronunciationDictionary.ts` |

Stubs show up in the app only where a user would look for them. The reader's "…" menu does the same for export, translation and pronunciation.

**To do:** restrict who can log in. Right now anyone with an email address can log in (no allowlist).

## Architecture

```
src/
  domain/types.ts              ReaderDocument, Voice, TextRange, formats
  adapters/
    speech/backend.ts          HTTP client for vtts-backend (auth, voices, speech)
    speech/audioCache.ts       500 MB LRU of MP3 files; SentenceAudio fetches on a miss
    speech/playback.ts         Reader: the track-player queue, prefetch and lock-screen events
    translation/Translator.ts  Apple Translation       [stub]
    cloud/LibrarySync.ts       iCloud                  [stub]
  features/
    auth/session.ts            session token in the Keychain (native, VttsSpeech.m)
    library/library.ts         LibraryEntry list + settings, reducer, load/save
    reader/usePlayer.ts        the one playback session, lives above the screens
    reader/textRanges.ts       sentences + render blocks
    import/extractText.ts      picked content -> {title, text}, pure
  ui/                          LoginScreen, LibraryScreen, ReaderScreen, VoicePicker, icons, theme
backend/                       Go service (see below)
```

- **Server speech only.** The app has no offline voices. Every sentence is requested from `POST /v1/speech` with the session token. The Vbee keys stay on the server.
- **Queue with prefetch.** `Reader` puts the sentence playing and the next two in the track-player queue. Each track is a local MP3 tagged with its sentence index, so the lock screen and the highlight stay in step. When the queue runs dry before a download finishes, playback waits for it and continues.
- **Audio cache.** MP3s live in `Caches/speech`, named by a hash of voice, speed and text. Recency is kept in memory and seeded from file times at launch. Past 500 MB the least recently used files are deleted.
- **One player for the whole app.** `usePlayer` sits in `App.tsx`, above the screens. Leaving the reader keeps the audio going, and the library's mini player controls the same session. Each sentence written as spoken moves the reading position in the library, which is saved one second after a change and immediately when the app leaves the foreground.
- **Login gate.** `Gate` in `App.tsx` reads the token from the Keychain. Without one it shows `LoginScreen`. A 401 from the server clears the token and returns to login.
- **Long documents.** The reader renders a `FlatList` of paragraph blocks of at most 600 characters. Only the block holding the current sentence re-renders on each change, and auto-scroll uses `scrollToIndex`.
- **Native code.** `VttsSpeech.m` keeps only `detectLanguage` (NLLanguageRecognizer). Other modules are classic ObjC `RCTEventEmitter` / `RCTBridgeModule` and run through the new-architecture interop layer (RN 0.88, bridgeless).
- **Document reading has two native paths.** `VttsDocuments.m` owns the Files picker. EPUB and PDF go to `VttsReadium.swift`, which opens them with Readium (`ReadiumShared` + `ReadiumStreamer` pods) and returns the text of each paragraph (EPUB) or page (PDF). Word goes through `VttsZip.m` (zlib), and `extractText.ts` parses `word/document.xml`. Readium has no DOCX support. Both paths return the same `PickedDocument` shape.

### Backend (`backend/`)

Go 1.26, standard library only, deployed on Fly.io as `vtts-backend` (region `sin`).

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/auth/code` | Emails a 6-digit code (Resend). One code per email per minute, valid 10 minutes, five wrong tries |
| `POST /v1/auth/session` | Exchanges the code for a session token (30 days) |
| `DELETE /v1/auth/session` | Ends the session |
| `GET /v1/voices` | Vbee vi-VN voices, cached for an hour |
| `POST /v1/speech` | Text, voice and speed to MP3. Chunks are cached on the server |
| `GET /docs`, `GET /openapi.json`, `GET /healthz`, `GET /` | Swagger UI, the spec, health, and an index |

Secrets are Fly secrets: `VBEE_APP_ID`, `VBEE_ACCESS_TOKEN`, `RESEND_API_KEY`. Login codes are sent from `vTTS Reader <login@thecoupleapp.xyz>` (Fly secret `MAIL_FROM`). The domain is verified in Resend, so any address can receive a code. The default `onboarding@resend.dev` only reaches the account owner.

Checks: `cd backend && gofmt -l . && go vet ./... && go test ./...`.

## Run

```bash
npm install
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 bundle exec pod install && cd ..   # CocoaPods crashes on a non-UTF-8 locale
npx react-native start --port 8088   # 8081 was taken on the dev machine; any free port works
npx react-native run-ios --port 8088
```

After `pod install`, a Debug build needs the Debug Hermes. Copy it over the Release one:

```bash
tar -xzf ios/Pods/hermes-engine-artifacts/hermes-ios-260318099.0.4-debug.tar.gz -C ios/Pods/hermes-engine
```

If you build from Xcode instead of `run-ios`, point the app at the custom Metro port:

```bash
xcrun simctl spawn booted defaults write org.reactjs.native.example.VttsReader RCT_jsLocation "localhost:8088"
```

Checks: `npx tsc --noEmit`, `npx eslint .`, `npx jest`. The tests cover sentence splitting and render blocks, the library reducer, time estimates, the audio cache (eviction order and synthesis once per sentence), and text extraction for EPUB, PDF and Word.

## Verification

Not yet verified on a device. The user tests on iPhone before the commit.

## Import limits

- **Scanned PDFs** have no text layer. Import fails with "This PDF has no text to read. It may be a scan." No OCR.
- **PDF paragraphs are guessed.** Readium returns each page's text with hard-wrapped lines (it uses PDFKit underneath). Spacing errors in the PDF's own text layer pass through as they are. A line ends its paragraph when it ends a sentence or is under 60% of the page's longest line. Hyphenated line ends are rejoined.
- **DRM EPUBs** (Apple Books, LCP) are detected by Readium (`publication.isRestricted`) and rejected. A damaged EPUB or PDF, or a ZIP64 or encrypted `.docx`, also fails. The import shows "This file could not be opened. It may be damaged or protected."
- **Legacy `.doc`** is not supported, only `.docx`.
- EPUB and DOCX are reduced to plain text. Images, tables and footnote links are dropped.
- Readium adds roughly the size of its pods to the app. The Release size has not been measured.

## Known quirks

- **Reading needs the network.** A sentence that is not cached waits for the server. A slow connection shows as a short pause between sentences.
- **Dev reload (`r` / Cmd+R) can crash** with Fabric's "The view must not have any subviews" error in `RCTMountingManager`. This is an RN dev-mode issue. Relaunch the app.
