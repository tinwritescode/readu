# vTTS Reader (React Native, iOS first)

An offline text-to-speech reader built from the vTTS use case diagram. The only actor is the user (Người dùng). The read-aloud path works end to end. Every other use case sits behind an interface with a stub and a TODO.

## Status

The app has three screens, built from the approved mockup: **Library**, **Reader** and the **Voice** sheet.

| Use case | Status | Where |
| --- | --- | --- |
| Library with reading progress, kept across launches | **Implemented** (JSON in Application Support) | `src/features/library/library.ts`, `src/ui/LibraryScreen.tsx`, `VttsDocuments.m` (`loadLibrary` / `saveLibrary`) |
| Paste text | **Implemented** | `documentFromPaste` in `src/features/import/DocumentImporter.ts` |
| Import EPUB, PDF, Word (`.docx`), `.txt` | **Implemented** (one Files picker. EPUB and PDF are read by [Readium](https://github.com/readium/swift-toolkit) 3.11.0; Word is unzipped natively and parsed in JS) | `importDocument` in `DocumentImporter.ts`, `src/features/import/extractText.ts`, `VttsDocuments.m`, `VttsReadium.swift`, `VttsZip.m` |
| Read aloud offline | **Implemented** (iOS system voices, `AVSpeechSynthesizer`) | `src/adapters/speech/SystemSpeechEngine.ts`, `ios/VttsReader/Native/VttsSpeech.m` |
| Resume where you stopped | **Implemented** (from the start of the bookmarked sentence) | `resumeOffset` in `src/features/reader/usePlayer.ts` |
| Highlight current word + sentence, dim what was read | **Implemented** | `src/features/reader/textRanges.ts`, `src/ui/ReaderScreen.tsx` |
| Tap a sentence to read from it, skip by sentence, scrub | **Implemented** | `src/ui/ReaderScreen.tsx` |
| Choose voice | **Implemented** (document's language first, preview with the current sentence, one voice remembered per language) | `src/ui/VoicePicker.tsx`, `src/features/voices/voices.ts` |
| Detect document language | **Implemented** (`NLLanguageRecognizer`) | `detectLanguage` in `VttsSpeech.m`, `toEntry` in `library.ts` |
| Choose speed (0.5–2×) | **Implemented** (a change while playing restarts from the current word) | speed chip in `ReaderScreen.tsx` |
| Sleep timer (15–60 min) | **Implemented** (checked on each spoken word, so it also fires in the background) | `usePlayer.ts`, `SleepChip` in `ReaderScreen.tsx` |
| Background playback, mini player | **Implemented** (`UIBackgroundModes: audio`) | `Info.plist`, `MiniPlayer` in `LibraryScreen.tsx` |
| Bundled (in-app) voices | Stub | `src/adapters/speech/BundledSpeechEngine.ts` |
| Optional LAN TTS server | Stub | `src/adapters/speech/LanServerSpeechEngine.ts` |
| Export audio (M4A / MP3 / WAV / M4B) | Stub | `src/features/export/AudioExporter.ts` |
| On-device translation (Apple Translation) | Stub | `src/adapters/translation/Translator.ts` |
| Backup + iCloud sync | Stub | `src/adapters/cloud/LibrarySync.ts` |
| Pronunciation fixes | Stub | `src/features/pronunciation/PronunciationDictionary.ts` |

Stubs show up in the app only where a user would look for them. The reader's "…" menu does the same for export, translation and pronunciation.

## Architecture

```
src/
  domain/types.ts            ReaderDocument, Voice, TextRange, formats
  adapters/                  external systems from the diagram
    speech/SpeechEngine.ts   interface: listVoices() + speak() -> session
    speech/SystemSpeechEngine.ts   iOS voices (offline)    [implemented]
    speech/BundledSpeechEngine.ts  voices shipped in app   [stub]
    speech/LanServerSpeechEngine.ts optional LAN server    [stub]
    translation/Translator.ts      Apple Translation       [stub]
    cloud/LibrarySync.ts           iCloud                  [stub]
  features/                  use cases
    library/library.ts       LibraryEntry list + settings, reducer, load/save
    reader/usePlayer.ts      the one playback session, lives above the screens
    reader/useReadAloud.ts   speak/pause/resume state machine over SpeechEngine
    reader/textRanges.ts     sentences + render blocks
    voices/voices.ts         per-language voice resolution and grouping
    import/extractText.ts    picked content -> {title, text}, pure. Parses DOCX XML; EPUB/PDF arrive as text from Readium
    import/ export/ pronunciation/
  ui/                        LibraryScreen, ReaderScreen, VoicePicker, icons, theme
```

- **One player for the whole app.** `usePlayer` sits in `App.tsx`, above the screens. Leaving the reader keeps the audio going, and the library's mini player controls the same session. Every spoken word writes the reading position into the library, which is saved one second after a change and immediately when the app leaves the foreground.
- **Voices belong to a language, not to the app.** `settings.voiceByLanguage` maps a base language (`en`, `vi`) to a voice id. A new document picks the saved voice for its detected language, else the best installed voice for it, else English. Novelty voices (Albert, Zarvox…) are filtered out natively.
- **Long documents.** The reader renders a `FlatList` of paragraph blocks of at most 600 characters, not one `Text`. Only the block holding the current word re-renders on each word event, and auto-scroll uses `scrollToIndex`. Dragging the text pauses auto-scroll and shows a "Back to current" pill.

- **Speech engines can be swapped.** UI and `useReadAloud` depend only on `SpeechEngine`. To use a different engine, change the one line in `App.tsx`. It is still unconfirmed whether vTTS uses iOS voices or ships its own, so both paths have an adapter.
- **Highlight offsets.** `AVSpeechSynthesizer` reports `willSpeakRangeOfSpeechString` as an `NSRange` in UTF-16 units. JS string indices use the same units, so ranges map 1:1 with no conversion. When playback resumes mid-text (after a speed or voice change), `useReadAloud` adds the start offset back.
- **Stale events.** Each `speak()` returns an `utteranceId`. JS drops native events for any other utterance, and `useReadAloud` ignores callbacks from runs that were replaced.
- **Document reading has two native paths.** `VttsDocuments.m` owns the Files picker. EPUB and PDF go to `VttsReadium.swift`, which opens them with Readium (`ReadiumShared` + `ReadiumStreamer` pods) and returns the text of each paragraph (EPUB) or page (PDF) from Readium's Content API. Word goes through `VttsZip.m` (zlib), and `extractText.ts` parses `word/document.xml`. Readium has no DOCX support. Both paths return the same `PickedDocument` shape, so `DocumentImporter.ts` does not know which one ran.
- **Native modules** are classic ObjC `RCTEventEmitter` / `RCTBridgeModule`. They run through the new-architecture interop layer (RN 0.88, bridgeless). If they are ever converted to TurboModules, the JS interface stays the same.

## Run

```bash
npm install
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 bundle exec pod install && cd ..   # CocoaPods crashes on a non-UTF-8 locale
npx react-native start --port 8088   # 8081 was taken on the dev machine; any free port works
npx react-native run-ios --port 8088
```

If you build from Xcode instead of `run-ios`, point the app at the custom Metro port:

```bash
xcrun simctl spawn booted defaults write org.reactjs.native.example.VttsReader RCT_jsLocation "localhost:8088"
```

Checks: `npx tsc --noEmit`, `npx eslint .`, `npx jest`. The tests cover sentence splitting and render blocks, speed mapping, the library reducer, voice resolution and grouping, time estimates, the read-aloud state machine with a fake engine, and text extraction for EPUB, PDF and Word.

## Verified in the iOS Simulator (iPhone 17, iOS 26)

- Library opens with the welcome document; tapping it opens the reader
- Play highlights the word and sentence and dims what was already read; the scrubber and remaining time move along
- Tapping a sentence reads from it
- Reading progress survives a relaunch, and playback resumes from the bookmarked sentence
- Voice sheet groups English first, previews a voice (stop icon while it speaks), and choosing Samantha updates the chip
- Back to the library keeps playing; the mini player shows title, voice, speed and time left, and shows "Finished" at the end
- "+" › Paste text adds a document and opens it; Vietnamese text was detected and got the Vietnamese voice Linh
- Long-press › Delete removes a document and closes its mini player
- "+" › Open a file imported an EPUB (book title, chapters in spine order), a PDF (heading split from the body, Play highlights) and a Word file (Vietnamese diacritics intact)

Not yet checked by hand: skip buttons, speed chip, sleep timer firing, font size, "Back to current" pill on a long document, background audio with the screen locked, picking a real `.txt` file, a large real-world EPUB, and a scanned PDF.

## Import limits

- **Scanned PDFs** have no text layer. Import fails with "This PDF has no text to read. It may be a scan." No OCR.
- **PDF paragraphs are guessed.** Readium returns each page's text with hard-wrapped lines (it uses PDFKit underneath). Spacing errors in the PDF's own text layer pass through as they are. A line ends its paragraph when it ends a sentence or is under 60% of the page's longest line. Hyphenated line ends are rejoined.
- **DRM EPUBs** (Apple Books, LCP) are detected by Readium (`publication.isRestricted`) and rejected. A damaged EPUB or PDF, or a ZIP64 or encrypted `.docx`, also fails. The import shows "This file could not be opened. It may be damaged or protected."
- **Legacy `.doc`** is not supported, only `.docx`.
- EPUB and DOCX are reduced to plain text. Images, tables and footnote links are dropped.
- Readium adds roughly the size of its pods to the app. The Release size has not been measured.

## Known quirks

- **First speech on a fresh simulator can be silent.** The voice database is still loading ("Using fallback voices"). Range events can still arrive. Tap Play again.
- **Stop sometimes reports `didFinish` instead of `didCancel`** on iOS 26. Both end in `idle`, so the UI behaves the same.
- **Dev reload (`r` / Cmd+R) can crash** with Fabric's "The view must not have any subviews" error in `RCTMountingManager`. This is an RN dev-mode issue. Relaunch the app.
- The simulator ships only compact voices. Install enhanced or premium voices in Settings › Accessibility › Spoken Content › Voices. They show up in the picker automatically.
