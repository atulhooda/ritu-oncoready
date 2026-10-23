"use client";

import { AlertTriangle, ChevronDown, FileText, Info, MessageSquare, Mic, MicOff, Pause, Play, Send, Sparkles, Square, Trash2, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { canRecognize, canSpeak, checkMicrophone, listen, speak } from "@/lib/speech";
import type { AssistantAnswer, AssistantSource } from "@/lib/types";

const SUGGESTIONS = [
  "What was the pulse rate three months ago compared with the latest?",
  "Does the patient have any allergies?",
  "Compare the previous and latest hemoglobin.",
  "What medications were recorded during the last visit?",
  "Which investigations are still pending?",
  "What symptoms did the patient report recently?",
  "What were the findings of the previous biopsy?",
  "When was the last PET-CT scan performed?",
];

type NewMessage =
  | { role: "doctor"; text: string; via: "chat" | "voice" }
  | { role: "ritu"; answer: AssistantAnswer }
  | { role: "error"; text: string; retry: string };
type Message = NewMessage & { id: number };

const BASIS: Record<string, string> = {
  stated: "date written with the entry",
  document: "date of the document",
  conversation: "when the patient said it",
};

function dateLabel(d: string | null) {
  return d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "undated";
}

/** What is read aloud: the answer's sentences, without source numbers. */
function speechText(a: AssistantAnswer): string {
  return [a.conflict, ...a.lines.map((l) => l.text)].filter(Boolean).join(" ");
}

function AnswerView({ answer, onOpenSource, compact }: { answer: AssistantAnswer; onOpenSource: (s: AssistantSource) => void; compact?: boolean }) {
  const [reading, setReading] = useState(false);
  const bySource = new Map(answer.sources.map((s) => [s.n, s]));
  const open = (n: number) => {
    const s = bySource.get(n);
    if (s) onOpenSource(s.source);
  };
  useEffect(() => () => {
    if (reading && canSpeak()) window.speechSynthesis.cancel();
  }, [reading]);

  return (
    <div className="space-y-3">
      {answer.conflict && (
        <div className="flex gap-2 rounded-lg border border-amber-500/60 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {answer.conflict}
        </div>
      )}
      {answer.notice && (
        <div className="flex gap-2 rounded-lg bg-line/40 px-3 py-2 text-[13px] text-ink/80">
          <Info size={15} className="mt-0.5 shrink-0" /> {answer.notice}
        </div>
      )}
      <div className="space-y-1.5 text-[14.5px] leading-relaxed">
        {answer.lines.map((l, i) => (
          <div key={i}>
            <p
              className={
                l.kind === "heading" ? "pt-1 text-[12px] font-semibold uppercase tracking-wide text-ink/60"
                  : l.kind === "missing" ? "text-ink/70 italic"
                  : l.kind === "computed" ? "font-medium"
                  : l.kind === "note" ? "text-ink/70" : ""
              }
            >
              {l.text}
              {l.refs.map((n) => (
                <button key={n} onClick={() => open(n)} className="ml-0.5 align-super text-[11px] font-semibold text-brand hover:underline" title="Open the source">
                  [{n}]
                </button>
              ))}
              {l.kind === "computed" && <span className="ml-1.5 rounded bg-line/60 px-1 py-px align-middle text-[10px] font-medium uppercase tracking-wide text-ink/60">calculated</span>}
            </p>
            {l.flag && <p className="mt-0.5 text-[12px] text-red-700">⚠ {l.flag}</p>}
          </div>
        ))}
      </div>
      {answer.sources.length > 0 && (
        <div className="space-y-1.5 border-t border-line pt-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink/50">Sources</div>
          {answer.sources.map((s) => {
            const src = s.source;
            return (
              <button
                key={s.n}
                onClick={() => onOpenSource(src)}
                className="flex w-full gap-2 rounded-lg border border-line/80 bg-white px-2.5 py-2 text-left text-[12.5px] transition hover:border-brand/50 hover:bg-brand-soft/30"
              >
                <span className="font-semibold text-brand">[{s.n}]</span>
                <span className="min-w-0 flex-1">
                  {src.type === "document" ? (
                    <span className="flex items-center gap-1 font-medium">
                      <FileText size={13} className="shrink-0" /> <span className="truncate">{src.filename}</span>
                      <span className="shrink-0 text-ink/60">· page {src.page_number}</span>
                    </span>
                  ) : (
                    <span className="font-medium">Patient&apos;s conversation with Ritu · turn {src.turn_index}</span>
                  )}
                  <span className="block text-ink/60">
                    {dateLabel(s.date)}
                    {s.date_basis ? ` (${BASIS[s.date_basis]})` : ""}
                  </span>
                  {!compact && <span className="mt-0.5 block truncate italic text-ink/70">“{src.type === "document" ? src.text_span : src.quote}”</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink/50">
        <span>
          Searched {answer.searched.documents} document{answer.searched.documents === 1 ? "" : "s"} ({answer.searched.pages} page{answer.searched.pages === 1 ? "" : "s"}) and{" "}
          {answer.searched.conversations} conversation{answer.searched.conversations === 1 ? "" : "s"}
        </span>
        {canSpeak() && !compact && (
          <button
            onClick={() => {
              if (reading) {
                window.speechSynthesis.cancel();
                setReading(false);
              } else {
                setReading(true);
                speak(speechText(answer), () => setReading(false));
              }
            }}
            className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
          >
            {reading ? <Square size={12} /> : <Volume2 size={13} />} {reading ? "Stop" : "Read aloud"}
          </button>
        )}
      </div>
    </div>
  );
}

type VoiceState = "idle" | "listening" | "processing" | "answered" | "error";

function VoiceMode({
  patientName,
  ask,
  onOpenSource,
  onClose,
}: {
  patientName: string;
  ask: (q: string) => Promise<AssistantAnswer | null>;
  onOpenSource: (s: AssistantSource) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [audio, setAudio] = useState<"playing" | "paused" | "stopped">("stopped");
  const rec = useRef<{ stop: () => void; abort: () => void } | null>(null);

  const play = useCallback((a: AssistantAnswer) => {
    setAudio("playing");
    speak(speechText(a), () => setAudio("stopped"));
  }, []);

  const start = useCallback(async () => {
    if (canSpeak()) window.speechSynthesis.cancel();
    setAudio("stopped");
    setError(null);
    setAnswer(null);
    setHeard("");
    if (!canRecognize()) {
      setState("error");
      setError("Voice input needs Chrome or Edge. You can still type your question in the chat.");
      return;
    }
    const micProblem = await checkMicrophone();
    if (micProblem) {
      setState("error");
      setError(micProblem);
      return;
    }
    setState("listening");
    let finalText = "";
    rec.current = listen({
      onInterim: setHeard,
      onFinal: (t) => {
        finalText = t;
        setHeard(t);
      },
      onError: (m) => {
        setError(m);
        setState("error");
      },
      onEnd: async () => {
        rec.current = null;
        if (!finalText) {
          setState((s) => (s === "listening" ? "idle" : s));
          return;
        }
        setState("processing");
        const a = await ask(finalText);
        if (!a) {
          setState("error");
          setError("Could not get an answer. Check the connection and try again.");
          return;
        }
        setAnswer(a);
        setState("answered");
        play(a);
      },
    });
  }, [ask, play]);

  useEffect(() => () => {
    rec.current?.abort();
    if (canSpeak()) window.speechSynthesis.cancel();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <button
            onClick={state === "listening" ? () => rec.current?.stop() : start}
            disabled={state === "processing"}
            aria-label={state === "listening" ? "Stop recording" : "Start speaking"}
            className={`relative flex h-20 w-20 items-center justify-center rounded-full text-white transition ${
              state === "listening" ? "bg-red-600" : state === "processing" ? "bg-brand/60" : "bg-brand hover:bg-brand/90"
            }`}
          >
            {state === "listening" && <span className="absolute inset-0 animate-ping rounded-full bg-red-500/40" />}
            {state === "processing" ? (
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : state === "listening" ? (
              <Square size={26} fill="currentColor" />
            ) : (
              <Mic size={30} />
            )}
          </button>
          <div className="text-[15px] font-semibold">
            {state === "listening" ? "Listening… tap to stop" : state === "processing" ? `Searching ${patientName}'s records…` : state === "answered" ? "Ask another question" : "Tap and ask about this patient"}
          </div>
        </div>

        {heard && (
          <div className="rounded-xl bg-paper px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink/50">{state === "listening" ? "Hearing" : "You asked"}</div>
            <p className="mt-1 text-[15px]">{heard}</p>
            {state !== "listening" && <p className="mt-1 text-[11.5px] text-ink/50">Check this is what you said. If not, ask again or type it in the chat.</p>}
          </div>
        )}
        {error && (
          <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-800">
            <MicOff size={17} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {answer && (
          <div className="rounded-xl border border-line bg-white px-4 py-3">
            {canSpeak() && (
              <div className="mb-3 flex items-center gap-2">
                {audio === "playing" ? (
                  <button onClick={() => { window.speechSynthesis.pause(); setAudio("paused"); }} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-medium">
                    <Pause size={14} /> Pause
                  </button>
                ) : audio === "paused" ? (
                  <button onClick={() => { window.speechSynthesis.resume(); setAudio("playing"); }} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-medium">
                    <Play size={14} /> Resume
                  </button>
                ) : (
                  <button onClick={() => play(answer)} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-medium">
                    <Play size={14} /> Play answer
                  </button>
                )}
                {audio !== "stopped" && (
                  <button onClick={() => { window.speechSynthesis.cancel(); setAudio("stopped"); }} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-medium">
                    <Square size={13} /> Stop
                  </button>
                )}
                <span className="text-[12px] text-ink/50">{audio === "playing" ? "Reading aloud…" : ""}</span>
              </div>
            )}
            <AnswerView answer={answer} onOpenSource={onOpenSource} compact />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-[11.5px] text-ink/50">
        <span>Browser speech: Chrome/Edge send audio to their speech service; answers are read by your device&apos;s voice.</span>
        <button onClick={onClose} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-medium text-ink hover:border-ink/30">
          Back to chat
        </button>
      </div>
    </div>
  );
}

/**
 * RITU records assistant, doctor dashboard only. Answers about the patient on screen, from that
 * patient's records (POST /doctor/patients/{caseId}/assistant). Mount it with key={caseId}: a new
 * patient starts a new, empty conversation, so nothing carries over between patients.
 */
export function RituAssistant({
  caseId,
  patientName,
  onOpenSource,
}: {
  caseId: string | null;
  patientName: string | null;
  onOpenSource?: (s: AssistantSource) => void;
}) {
  const [mode, setMode] = useState<"closed" | "chat" | "voice">("closed");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);
  const first = patientName?.split(" ")[0] ?? "this patient";

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const push = (m: NewMessage) => setMessages((ms) => [...ms, { ...m, id: nextId.current++ }]);

  const ask = useCallback(
    async (question: string, via: "chat" | "voice" = "chat"): Promise<AssistantAnswer | null> => {
      if (!caseId || !question.trim()) return null;
      push({ role: "doctor", text: question.trim(), via });
      setBusy(true);
      try {
        const answer = await api<AssistantAnswer>(`/doctor/patients/${caseId}/assistant`, {
          method: "POST",
          body: JSON.stringify({ question: question.trim() }),
        });
        push({ role: "ritu", answer });
        return answer;
      } catch (e) {
        push({ role: "error", text: e instanceof Error ? e.message : "Something went wrong", retry: question });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [caseId],
  );

  const openSource = (s: AssistantSource) => {
    onOpenSource?.(s);
    setMode("closed"); // step aside so the record is visible; the conversation is kept
  };

  if (mode === "closed") {
    return (
      <div className="print-hide fixed bottom-5 right-5 z-50 flex items-center gap-1 rounded-full border border-line bg-white p-1.5 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)]">
        <span className="hidden pl-3 pr-1 text-[13px] font-semibold sm:inline">RITU</span>
        <button onClick={() => setMode("chat")} title="Chat with RITU" aria-label="Chat with RITU" className="flex h-11 items-center gap-2 rounded-full bg-brand px-4 text-[14px] font-semibold text-white hover:bg-brand/90">
          <MessageSquare size={18} /> <span className="hidden sm:inline">Chat</span>
        </button>
        <button onClick={() => setMode("voice")} title="Talk to RITU" aria-label="Talk to RITU" className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-white hover:bg-ink/85">
          <Mic size={18} />
        </button>
        {messages.length > 0 && <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-brand ring-2 ring-white" />}
      </div>
    );
  }

  return (
    <section
      aria-label="RITU AI Assistant"
      className="print-hide fixed inset-x-0 bottom-0 top-14 z-50 flex flex-col overflow-hidden rounded-t-2xl border border-line bg-white shadow-[0_20px_60px_-15px_rgba(0,0,0,0.45)] sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(680px,calc(100vh-6rem))] sm:w-[420px] sm:rounded-2xl"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line bg-ink px-5 py-3.5 text-white">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand">
            <Sparkles size={17} />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">RITU AI Assistant</div>
            <div className="truncate text-[12.5px] text-white/65">{patientName ? `Records of ${patientName}` : "No patient open"}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {caseId && (
            <button
              onClick={() => setMode(mode === "voice" ? "chat" : "voice")}
              title={mode === "voice" ? "Chat" : "Talk to RITU"}
              aria-label={mode === "voice" ? "Switch to chat" : "Switch to voice"}
              className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
            >
              {mode === "voice" ? <MessageSquare size={18} /> : <Mic size={18} />}
            </button>
          )}
          {messages.length > 0 && mode === "chat" && (
            <button onClick={() => setMessages([])} title="Clear conversation" aria-label="Clear conversation" className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white">
              <Trash2 size={17} />
            </button>
          )}
          <button onClick={() => setMode("closed")} title="Minimise" aria-label="Minimise" className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white">
            <ChevronDown size={19} />
          </button>
          <button
            onClick={() => {
              setMode("closed");
              setMessages([]);
            }}
            title="Close and clear"
            aria-label="Close"
            className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
          >
            <X size={19} />
          </button>
        </div>
      </header>

      {!caseId ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[15px] text-ink/70">
          Open a patient to ask about their records. RITU answers only from the records of the patient on screen.
        </div>
      ) : mode === "voice" ? (
        <VoiceMode patientName={first} ask={(q) => ask(q, "voice")} onOpenSource={openSource} onClose={() => setMode("chat")} />
      ) : (
        <>
          <div className="flex-1 space-y-4 overflow-y-auto bg-paper/60 px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-[14px] text-ink/75">
                  Ask about {first}&apos;s records: measurements over time, reports, medicines, allergies, pending tests, or what {first} told Ritu.
                  Every answer comes from the records, with its source.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => ask(s)} className="rounded-full border border-line bg-white px-3 py-1.5 text-left text-[12.5px] hover:border-brand/50 hover:text-brand">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === "doctor" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[14.5px] text-white">
                    {m.via === "voice" && <Mic size={12} className="mb-0.5 mr-1 inline opacity-70" />}
                    {m.text}
                  </div>
                </div>
              ) : m.role === "ritu" ? (
                <div key={m.id} className="rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3">
                  <AnswerView answer={m.answer} onOpenSource={openSource} />
                </div>
              ) : (
                <div key={m.id} className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-800">
                  Could not get an answer: {m.text}{" "}
                  <button onClick={() => ask(m.retry)} className="font-semibold underline">
                    Try again
                  </button>
                </div>
              ),
            )}
            {busy && (
              <div className="flex items-center gap-2 text-[13px] text-ink/60">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand" style={{ animationDelay: `${i * 120}ms` }} />
                  ))}
                </span>
                Searching {first}&apos;s records…
              </div>
            )}
            <div ref={bottom} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const q = input;
              setInput("");
              ask(q);
            }}
            className="flex items-end gap-2 border-t border-line bg-white px-3 py-3"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              maxLength={500}
              placeholder={`Ask about ${first}'s records…`}
              className="max-h-28 min-h-[42px] flex-1 resize-none rounded-xl border border-line bg-[#fcfbf9] px-3 py-2.5 text-[14.5px] outline-none focus:border-brand"
            />
            <button type="button" onClick={() => setMode("voice")} title="Talk to RITU" aria-label="Talk to RITU" className="flex h-[42px] w-[42px] items-center justify-center rounded-xl border border-line text-ink/70 hover:border-ink/30 hover:text-ink">
              <Mic size={18} />
            </button>
            <button type="submit" disabled={busy || input.trim().length < 2} aria-label="Send" className="flex h-[42px] w-[42px] items-center justify-center rounded-xl bg-brand text-white disabled:opacity-40">
              <Send size={17} />
            </button>
          </form>
          <p className="bg-white px-4 pb-2.5 text-[11px] text-ink/45">From this patient&apos;s records only. Not a diagnosis or advice; check the sources.</p>
        </>
      )}
    </section>
  );
}
