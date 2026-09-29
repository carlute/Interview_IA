<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

# Project rules

- AI calls live in server routes `src/routes/api/answer.ts` (text stream) and `src/routes/api/transcribe.ts` (SSE), sharing `src/lib/ai.server.ts` — keeps the AI key on the server.
- Resume and job description are stored in the browser's localStorage only — no login needed, data stays on the device.
