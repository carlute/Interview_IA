import { createFileRoute } from "@tanstack/react-router";
import { GATEWAY_URL, TRANSCRIBE_MODEL } from "@/lib/ai.server";

const MAX_BYTES = 12 * 1024 * 1024;

function json(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env['LOVABLE_API_KEY'];
        if (!apiKey) return json(500, "Serviço de IA não configurado.");
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_BYTES + 64 * 1024) return json(413, "Áudio muito longo.");

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json(400, "Envio de áudio inválido.");
        }
        const file = form.get("file");
        if (!(file instanceof File) || !file.size) return json(400, "Nenhum áudio recebido.");
        if (file.size > MAX_BYTES) return json(413, "Áudio muito longo.");
        const type = (file.type.split(";")[0] ?? "").replace(/^video\//, "audio/");
        if (!type.startsWith("audio/")) return json(400, "Formato de áudio não suportado.");

        const upstream = new FormData();
        upstream.append("model", TRANSCRIBE_MODEL);
        upstream.append("file", new File([await file.arrayBuffer()], file.name, { type }), file.name);
        upstream.append("response_format", "json");
        upstream.append("stream", "true");
        upstream.append("language", "en");

        try {
          const res = await fetch(`${GATEWAY_URL}/v1/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: upstream,
            signal: request.signal,
          });
          if (!res.ok) {
            const body = await res.text();
            console.error(`Transcription failed [${res.status}]: ${body}`);
            const msg =
              res.status === 402
                ? "Créditos de IA esgotados. Adicione créditos para continuar."
                : res.status === 429
                  ? "Muitas solicitações. Aguarde alguns segundos."
                  : res.status === 400
                    ? "Não foi possível entender o áudio. Tente gravar novamente."
                    : "Falha na transcrição. Tente novamente.";
            return json(res.status, msg);
          }
          return new Response(res.body, {
            status: res.status,
            headers: { "Content-Type": res.headers.get("content-type") ?? "text/event-stream" },
          });
        } catch (e) {
          if (request.signal.aborted) return new Response(null, { status: 499 });
          console.error(e);
          return json(502, "Falha na transcrição. Tente novamente.");
        }
      },
    },
  },
});
