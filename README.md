# Meeting Notes

A local companion for meetings on macOS. Open a Google Meet link in your browser, record system audio and microphone with a visible consent confirmation, then transcribe the recording and generate meeting notes after you stop. Recordings and results are stored in the app's local data folder and SQLite library.

## Requirements

- macOS 15 or later (ScreenCaptureKit system audio plus microphone capture)
- Node.js 20+
- Rust 1.90+
- Xcode Command Line Tools
- API credentials for the selected transcription and notes providers

## Run

```sh
npm install
npm run tauri dev
```

For a packaged macOS app with a stable local code identity, run:

```sh
npm run package:macos
```

The package script applies a stable designated code requirement to the local app bundle so macOS can retain Screen Capture and Microphone permission approvals across rebuilds. Developer builds run with `tauri dev` may receive a new ad-hoc code hash when rebuilt and can require permission again.

Choose providers and paste API tokens in Settings. Tokens are stored in macOS Keychain. The current transcription options are OpenAI, OpenRouter, Gemini, or a custom OpenAI-compatible transcription endpoint; meeting notes support OpenAI-compatible endpoints, Gemini, OpenRouter, and Ollama. Processing begins after you stop recording. Live transcript streaming, speaker diarization, and retry after restarting the app are not implemented yet.

Grant Screen Recording / System Audio Recording and Microphone permissions when macOS asks. Audio is uploaded to the selected transcription service after recording; the transcript is then sent to the selected notes service. Tell participants that the meeting is being recorded and obtain their consent before starting.

Completed meetings, minutes, transcripts, and open action items are loaded from SQLite on the Dashboard and in their library views. Successful processing stores the transcript segments and structured minutes, then removes the raw audio recording.

## GitHub releases and Homebrew

Push a tag such as `v0.1.0` to build Apple Silicon and Intel DMGs and publish a GitHub release. The tag must match the app version in `src-tauri/tauri.conf.json`. The release workflow updates the [Homebrew tap](https://github.com/f71uday/homebrew-meeting-notes) when its publishing credentials are configured.

Add these GitHub Actions repository secrets under **Settings → Secrets and variables → Actions**:

- `HOMEBREW_TAP_TOKEN`: a fine-grained token with **Contents: read and write** access to `f71uday/homebrew-meeting-notes` only.
- `APPLE_CERTIFICATE`: base64 encoded `.p12` Developer ID Application certificate.
- `APPLE_CERTIFICATE_PASSWORD`: password for the exported certificate.
- `APPLE_SIGNING_IDENTITY`: exact `Developer ID Application` identity name.
- `KEYCHAIN_PASSWORD`: temporary CI keychain password.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_PASSWORD`: Apple app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

The Cask is published only when all of these secrets are present, so Homebrew releases are signed and notarized for Gatekeeper. Without them, the workflow can still publish the DMGs as a GitHub release but skips the Homebrew update. After the first Cask is published, install it with:

```sh
brew install --cask f71uday/meeting-notes/meeting-notes
```
