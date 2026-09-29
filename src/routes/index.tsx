import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { createParser } from "eventsource-parser";
import { Mic, Square, Loader2, UserRound, Languages, Minus, Plus, Send, RotateCcw } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Entrevista Pro — Assistente de IA para entrevistas em inglês" },
      {
        name: "description",
        content: "Ouve a pergunta do entrevistador, transcreve e sugere uma resposta simples em inglês, com tradução.",
      },
      { property: "og:title", content: "Entrevista Pro — Assistente de IA para entrevistas em inglês" },
      {
        property: "og:description",
        content: "Respostas em inglês simples, em letras grandes, durante a sua entrevista.",
      },
    ],
  }),
  component: App,
});

type Phase = "idle" | "listening" | "transcribing" | "answering";
type QA = { q: string; en: string; pt: string };

const STORAGE = "entrevista-pro-perfil";

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function App() {
  const [tab, setTab] = useState<"entrevista" | "perfil">("entrevista");
  const [resume, setResume] = useState("");
  const [job, setJob] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}");
      setResume(saved.resume ?? "");
      setJob(saved.job ?? "");
      if (!saved.resume && !saved.job) setTab("perfil");
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE, JSON.stringify({ resume, job }));
  }, [resume, job, loaded]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
        <div className="flex items-center gap-2">
          <img src="/icon-192.png" alt="" width={32} height={32} className="rounded-lg" />
          <span className="font-display text-lg font-bold tracking-tight">Entrevista Pro</span>
        </div>
        <nav className="flex rounded-full bg-secondary p-1 text-sm font-medium">
          {(["entrevista", "perfil"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-1.5 transition-colors ${
                tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {t === "entrevista" ? "Entrevista" : "Perfil"}
            </button>
          ))}
        </nav>
      </header>

      {tab === "perfil" ? (
        <Profile resume={resume} job={job} setResume={setResume} setJob={setJob} onDone={() => setTab("entrevista")} />
      ) : (
        <Interview resume={resume} job={job} onOpenProfile={() => setTab("perfil")} />
      )}
    </div>
  );
}

function Profile(props: {
  resume: string;
  job: string;
  setResume: (v: string) => void;
  setJob: (v: string) => void;
  onDone: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col gap-5 px-4 pb-6">
      <p className="text-sm text-muted-foreground">
        Cole seu currículo e a descrição da vaga. Tudo fica salvo apenas neste aparelho.
      </p>
      <label className="flex flex-col gap-2">
        <span className="font-display font-bold">Seu currículo</span>
        <textarea
          value={props.resume}
          onChange={(e) => props.setResume(e.target.value)}
          placeholder="Cole aqui seu currículo (português ou inglês)…"
          className="min-h-48 rounded-xl border border-input bg-card p-3 text-base outline-none focus:border-ring"
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="font-display font-bold">Descrição da vaga</span>
        <textarea
          value={props.job}
          onChange={(e) => props.setJob(e.target.value)}
          placeholder="Cole aqui a descrição completa da vaga…"
          className="min-h-48 rounded-xl border border-input bg-card p-3 text-base outline-none focus:border-ring"
        />
      </label>
      <button
        onClick={props.onDone}
        className="mt-auto rounded-2xl bg-primary py-4 font-display text-lg font-bold text-primary-foreground"
      >
        Salvar e ir para a entrevista
      </button>
    </main>
  );
}

function Interview({ resume, job, onOpenProfile }: { resume: string; job: string; onOpenProfile: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [question, setQuestion] = useState("");
  const [en, setEn] = useState("");
  const [pt, setPt] = useState("");
  const [error, setError] = useState("");
  const [showPt, setShowPt] = useState(true);
  const [size, setSize] = useState(30);
  const [level, setLevel] = useState(0);
  const [typed, setTyped] = useState("");
  const history = useRef<QA[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const s = localStorage.getItem("entrevista-pro-ui");
    if (s) {
      try {
        const v = JSON.parse(s);
        setSize(v.size ?? 30);
        setShowPt(v.showPt ?? true);
      } catch {
        /* ignore */
      }
    }
  }, []);
  useEffect(() => {
    localStorage.setItem("entrevista-pro-ui", JSON.stringify({ size, showPt }));
  }, [size, showPt]);

  const cleanupAudio = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => {
    cleanupAudio();
    abortRef.current?.abort();
  }, [cleanupAudio]);

  const answer = useCallback(
    async (q: string) => {
      setQuestion(q);
      setEn("");
      setPt("");
      setPhase("answering");
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, resume, job, history: history.current.slice(-4).map((h) => ({ q: h.q, a: h.en })) }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error((await res.text()) || "Falha ao gerar a resposta.");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let full = "";
        let e = "";
        let p = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += dec.decode(value, { stream: true });
          const [main = "", err] = full.split("<<<ERROR>>>");
          if (err) setError(err.trim());
          const [a = "", b = ""] = main.split("<<<PT>>>");
          e = a.replace(/<+P?T?$/, "").trim();
          p = b.trim();
          setEn(e);
          setPt(p);
        }
        if (e) history.current.push({ q, en: e, pt: p });
      } catch (err) {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Falha ao gerar a resposta.");
      } finally {
        setPhase("idle");
      }
    },
    [resume, job],
  );

  const transcribe = useCallback(
    async (blob: Blob, ext: string) => {
      setPhase("transcribing");
      const form = new FormData();
      form.append("file", new File([blob], `pergunta.${ext}`, { type: blob.type }));
      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? "Falha na transcrição.");
        }
        let text = "";
        let final = "";
        const parser = createParser({
          onEvent(ev) {
            try {
              const d = JSON.parse(ev.data);
              if (d.type === "transcript.text.delta" && d.delta) {
                text += d.delta;
                setQuestion(text);
              } else if (d.type === "transcript.text.done") {
                final = d.text ?? text;
              } else if (d.error) {
                throw new Error(d.error.message ?? "Falha na transcrição.");
              }
            } catch (e) {
              if (e instanceof SyntaxError) return;
              throw e;
            }
          },
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(dec.decode(value, { stream: true }));
        }
        const q = (final || text).trim();
        if (!q) {
          setError("Não ouvi nenhuma fala. Aproxime o celular do alto-falante e tente de novo.");
          setPhase("idle");
          return;
        }
        await answer(q);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Falha na transcrição.");
        setPhase("idle");
      }
    },
    [answer],
  );

  const stop = useCallback(() => {
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError("");
    abortRef.current?.abort();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError("Permita o acesso ao microfone para ouvir o entrevistador.");
      return;
    }
    streamRef.current = stream;
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      cleanupAudio();
      const base = ((rec.mimeType || mime || "audio/webm").split(";")[0] ?? "audio/webm").replace(/^video\//, "audio/");
      const blob = new Blob(chunks, { type: base });
      const ext = base.includes("mp4") ? "m4a" : base.includes("ogg") ? "ogg" : "webm";
      if (blob.size < 2000) {
        setPhase("idle");
        setError("Gravação muito curta. Tente novamente.");
        return;
      }
      void transcribe(blob, ext);
    };
    rec.start(250);
    setPhase("listening");
    setQuestion("");

    // Auto-stop after the interviewer finishes speaking.
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const startedAt = performance.now();
    let heard = false;
    let lastVoice = performance.now();
    let noise = 0.01;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (now - startedAt < 600) noise = Math.max(noise, rms * 1.5);
      const threshold = Math.max(0.02, noise * 2);
      setLevel(Math.min(1, rms / 0.15));
      if (rms > threshold) {
        heard = true;
        lastVoice = now;
      }
      if ((heard && now - lastVoice > 1800 && now - startedAt > 1500) || now - startedAt > 120000) {
        stop();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [cleanupAudio, stop, transcribe]);

  const busy = phase === "transcribing" || phase === "answering";
  const hasProfile = resume.trim() || job.trim();

  return (
    <main className="flex flex-1 flex-col gap-4 px-4 pb-4">
      {!hasProfile && (
        <button onClick={onOpenProfile} className="flex items-center gap-2 rounded-xl border border-border bg-card p-3 text-left text-sm">
          <UserRound className="size-4 shrink-0 text-primary" />
          Adicione seu currículo e a vaga para respostas personalizadas.
        </button>
      )}

      <section className="min-h-16">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Pergunta</p>
        <p className="text-base leading-snug text-muted-foreground">
          {question || (phase === "listening" ? "Ouvindo…" : "Toque no microfone quando o entrevistador começar a falar.")}
        </p>
      </section>

      <section className="flex flex-1 flex-col rounded-3xl bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">Sua resposta</p>
          <div className="flex items-center gap-1">
            <button aria-label="Diminuir texto" onClick={() => setSize((s) => Math.max(20, s - 3))} className="rounded-full bg-secondary p-2">
              <Minus className="size-4" />
            </button>
            <button aria-label="Aumentar texto" onClick={() => setSize((s) => Math.min(48, s + 3))} className="rounded-full bg-secondary p-2">
              <Plus className="size-4" />
            </button>
            <button
              aria-label="Mostrar tradução"
              aria-pressed={showPt}
              onClick={() => setShowPt((v) => !v)}
              className={`rounded-full p-2 ${showPt ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
            >
              <Languages className="size-4" />
            </button>
          </div>
        </div>
        {en ? (
          <>
            <p lang="en" className="font-display font-bold leading-tight text-foreground" style={{ fontSize: size }}>
              {en}
            </p>
            {showPt && pt && (
              <p className="mt-4 border-t border-border pt-4 leading-snug text-muted-foreground" style={{ fontSize: Math.round(size * 0.6) }}>
                {pt}
              </p>
            )}
          </>
        ) : (
          <p className="my-auto text-center text-muted-foreground">
            {phase === "transcribing" ? "Transcrevendo a pergunta…" : phase === "answering" ? "Preparando sua resposta…" : "A resposta sugerida aparece aqui em letras grandes."}
          </p>
        )}
      </section>

      {error && <p role="alert" className="rounded-xl bg-destructive/15 p-3 text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-3">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed.trim() && !busy) {
              void answer(typed.trim());
              setTyped("");
            }
          }}
          placeholder="Ou digite a pergunta…"
          className="h-12 flex-1 rounded-full border border-input bg-card px-4 text-base outline-none focus:border-ring"
        />
        <button
          aria-label="Enviar pergunta"
          disabled={!typed.trim() || busy}
          onClick={() => {
            void answer(typed.trim());
            setTyped("");
          }}
          className="grid size-12 place-items-center rounded-full bg-secondary disabled:opacity-40"
        >
          <Send className="size-5" />
        </button>
      </div>

      <div className="flex items-center justify-center gap-6 pt-1">
        {en && phase === "idle" ? (
          <button aria-label="Nova resposta para a mesma pergunta" onClick={() => answer(question)} className="grid size-12 place-items-center rounded-full bg-secondary">
            <RotateCcw className="size-5" />
          </button>
        ) : (
          <span className="size-12" />
        )}
        <button
          onClick={phase === "listening" ? stop : start}
          disabled={busy}
          aria-label={phase === "listening" ? "Parar e responder" : "Ouvir pergunta"}
          className="relative grid size-24 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg disabled:opacity-60"
          style={phase === "listening" ? { boxShadow: `0 0 0 ${6 + level * 22}px color-mix(in oklch, var(--primary) 30%, transparent)` } : undefined}
        >
          {busy ? <Loader2 className="size-10 animate-spin" /> : phase === "listening" ? <Square className="size-9 fill-current" /> : <Mic className="size-10" />}
        </button>
        <span className="size-12" />
      </div>
      <p className="text-center text-xs text-muted-foreground">
        {phase === "listening" ? "Ouvindo… para sozinho quando o entrevistador terminar." : "Toque para ouvir a próxima pergunta"}
      </p>
    </main>
  );
}
