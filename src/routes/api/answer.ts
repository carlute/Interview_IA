import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { streamAnswer } from "@/lib/ai.server";

const Body = z.object({
  question: z.string().trim().min(1).max(4000),
  resume: z.string().max(30000).default(""),
  job: z.string().max(30000).default(""),
  history: z
    .array(z.object({ q: z.string().max(4000), a: z.string().max(4000) }))
    .max(6)
    .default([]),
});

const SYSTEM = `You help a Brazilian candidate in a live job interview held in English. You write the answer the candidate will read out loud.

STRICT LANGUAGE RULES for the English answer:
- Use only simple, common, everyday English words (about CEFR A2–B1 level).
- Short sentences, max 15 words each. Active voice. Contractions are fine.
- No idioms, slang, archaic or formal words, and no words that are hard to pronounce for Portuguese speakers (avoid words like "thoroughly", "rural", "entrepreneurial", "particularly", "specifically", "hierarchy", "worcestershire").
- Prefer: "help" over "facilitate", "use" over "utilize", "about" over "approximately", "big" over "substantial".

CONTENT RULES:
- Answer as the candidate, in first person, using real facts from the resume and linking them to the job description. Never invent employers, dates or numbers that are not in the resume.
- If a fact is missing, give an honest, general answer.
- Length: 3 to 6 sentences. Start with a direct answer, then one short example, then a short link to the job.
- If the text is not a question (noise, greeting, small talk), give a short, friendly reply.

OUTPUT FORMAT (exactly, plain text, no markdown):
<the English answer>
<<<PT>>>
<a natural Brazilian Portuguese translation of the English answer>`;

export const Route = createFileRoute("/api/answer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env['LOVABLE_API_KEY'];
        if (!apiKey) return new Response("Serviço de IA não configurado.", { status: 500 });
        let data: z.infer<typeof Body>;
        try {
          data = Body.parse(await request.json());
        } catch {
          return new Response("Pergunta inválida.", { status: 400 });
        }
        const context = `RESUME:\n${data.resume || "(not provided)"}\n\nJOB DESCRIPTION:\n${data.job || "(not provided)"}`;
        const history = data.history
          .map((h, i) => `Earlier question ${i + 1}: ${h.q}\nCandidate said: ${h.a}`)
          .join("\n\n");
        const { result, getFailure } = streamAnswer(request, apiKey, SYSTEM, [
          {
            role: "user",
            content: `${context}\n\n${history ? `EARLIER IN THIS INTERVIEW:\n${history}\n\n` : ""}INTERVIEWER JUST SAID:\n"${data.question}"`,
          },
        ]);

        const encoder = new TextEncoder();
        const body = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of result.textStream) controller.enqueue(encoder.encode(chunk));
              const err = getFailure() as { statusCode?: number } | undefined;
              if (err) {
                const code = err.statusCode;
                const msg =
                  code === 402
                    ? "Créditos de IA esgotados. Adicione créditos para continuar."
                    : code === 429
                      ? "Muitas solicitações. Aguarde alguns segundos."
                      : "Falha ao gerar a resposta. Tente novamente.";
                controller.enqueue(encoder.encode(`\n<<<ERROR>>>${msg}`));
              }
              controller.close();
            } catch (e) {
              if (!request.signal.aborted) {
                console.error(e);
                controller.enqueue(encoder.encode("\n<<<ERROR>>>Falha ao gerar a resposta. Tente novamente."));
              }
              controller.close();
            }
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      },
    },
  },
});
