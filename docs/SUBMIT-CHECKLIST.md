# Submit-day checklist (5/27–5/28 PDT 10am)

This file is the minimum user-action sequence to take a green-CI repo + a
finished demo video to a filed Devpost submission. Estimated total user
time: **~15 minutes**.

## 1.  Watch the demo video once (already done 2026-05-17)

File: `c:\Users\hokut\Desktop\マルチ開発\.claude\video\output\aegis-demo.mp4`
JP transcript: `c:\Users\hokut\Desktop\マルチ開発\.claude\video\output\aegis-demo-transcript-jp.md`

Status: **approved**.

## 2.  Upload the video to YouTube (unlisted) — ~5 min

1. Open <https://studio.youtube.com> while logged into the Google account
   that should host the submission video.
2. **CREATE → Upload videos**.
3. Drag in `aegis-demo.mp4`.
4. Title: `Aegis — A Resilient AI Agent Runtime (DevNetwork [AI+ML] Hackathon 2026)`
5. Description: (paste the block below)

   ```text
   Aegis is an OpenAI SDK-compatible chat completion server built on TrueFoundry's
   AI Gateway with seven layers of behavioral resilience wrapping it.

   Hedge first. Fallback second. Continuously chaos-verified.

   Aegis closes the industry-wide gap documented in LiteLLM Issue #24320 — every
   major LLM gateway (LiteLLM, Portkey, OpenRouter, TrueFoundry default) passes
   Anthropic's `400 credit_balance_too_low` straight through. Aegis L4 inspects
   error.type / .code, recognizes the failure class, and re-routes.

   Every response carries a signed Aegis Receipt — a JSON envelope with the
   full layer trace.

   GitHub:    https://github.com/Hokutoman00/aegis-resilient-agents
   Hackathon: https://devnetwork-ai-ml-hack-2026.devpost.com/
   Challenge: TrueFoundry "Resilient Agents"
   ```

6. **Visibility → Unlisted**.
7. SAVE.
8. Copy the share URL (`https://youtu.be/...`).

## 3.  Pin the YouTube URL in SUBMISSION.md — ~1 min

In `c:\Users\hokut\Desktop\aegis-resilient-agents\docs\SUBMISSION.md`, replace
the placeholder line:

```diff
- - **Demo video**: `<YouTube unlisted link>` *(3:11, 1080p H.264 + AAC, EN narration)*
+ - **Demo video**: <YOUR_YOUTUBE_URL_HERE> (3:11, 1080p H.264 + AAC, EN narration)
```

Then `git add docs/SUBMISSION.md && git commit -m "docs: pin demo video URL" && git push`.

(Or, equivalently — paste the URL in the Devpost form below and skip the
SUBMISSION.md edit, since the README itself doesn't reference the YouTube URL.)

## 4.  Devpost submission form — ~10 min

1. Open the challenge page:
   <https://devnetwork-ai-ml-hack-2026.devpost.com/>
2. Click **Submit project**.
3. Fill each field by copying from `docs/SUBMISSION.md` in this order:

   | Devpost field | Source in SUBMISSION.md |
   |---|---|
   | Project name | "## Project name" |
   | Tagline (200 char) | "## Tagline" |
   | Description (long, MD) | Everything under "## Description (long form, Markdown supported)" |
   | Built with (tags) | "## Built with" |
   | Try it out — GitHub | https://github.com/Hokutoman00/aegis-resilient-agents |
   | Try it out — Video | (YouTube URL from step 2) |

4. Tag the **TrueFoundry "Resilient Agents"** challenge in the challenges
   selector.
5. (Optional) Upload screenshots — frames are at
   `c:\Users\hokut\Desktop\マルチ開発\.claude\video\raw\demo\preview\frame_*.png`
   (9 frames, 960×540 each).
6. **Submit for judging**.

Devpost will send a confirmation email. Forward the confirmation to yourself
as proof of submission timestamp.

## 5.  Done

After submitting:
- Judging window: 5/28 onwards (~1–2 weeks)
- Sponsor prize announcement: typically within 30 days
- Overall prize announcement: with DevNetwork final results

Aegis repo + CI continues to run on its own; no maintenance needed pre-judging.

---

## Failure modes to know about (mostly already mitigated)

| Risk | Likelihood | Mitigation in place |
|---|---|---|
| YouTube upload fails partway | low | Try Chrome (not Edge), or split if file > 100 MB (it isn't — 3.7 MB) |
| Devpost form loses state mid-fill | medium | All long fields live in `docs/SUBMISSION.md`; can re-paste any time |
| Tagline > 200 chars | n/a | Current tagline is 187 chars |
| Description > Devpost limit | n/a | ~5 KB markdown, well under any platform limit |
| Forgot to set Unlisted | low | Switch in YouTube Studio → Visibility, instant effect |
| Demo video link 404 in judges' view | very low | Unlisted ≠ private; anyone with link can view |
