import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import advanceIcon from "../assets/staffdeck/cot-icons/advance.svg";
import executeIcon from "../assets/staffdeck/cot-icons/execute.svg";
import generatedIcon from "../assets/staffdeck/cot-icons/generated.svg";
import judgeIcon from "../assets/staffdeck/cot-icons/judge.svg";
import loadingIcon from "../assets/staffdeck/cot-icons/loading.svg";
import referenceIcon from "../assets/staffdeck/cot-icons/reference.png";
import selectIcon from "../assets/staffdeck/cot-icons/select.svg";
import employeeAvatar from "../assets/staffdeck/staffdeck-avatar-default.png";
import { useI18n } from "../i18n";
import copyByLocale from "../i18n/site.json";
import { MarkdownMessage } from "./chat/chatHelpers";
import {
  normalizeSiteChatCitations,
  type SiteChatSource,
} from "./siteChatFormatting";

type StageStatus = "running" | "done" | "error" | "stopped";

type Stage = {
  id: string;
  label: string;
  detail?: string;
  status: StageStatus;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  stages?: Stage[];
  sources?: SiteChatSource[];
  status?: "streaming" | "done" | "error" | "stopped";
  error?: string;
};

type ServerEvent = {
  event: string;
  data: Record<string, unknown>;
};

type ChatCopy = (typeof copyByLocale)["en-US"]["chat"];

const SITE_CHAT_API_BASE = (
  import.meta.env.VITE_SITE_CHAT_API_BASE_URL?.trim()
  || (import.meta.env.PROD ? "http://39.102.210.77:10086/api/site-chat" : "/api/site-chat")
).replace(/\/+$/, "");

const STAGE_ICONS: Record<string, string> = {
  waiting: loadingIcon,
  route: judgeIcon,
  sop: selectIcon,
  retrieval: advanceIcon,
  answer: generatedIcon,
};

function newId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function parseEventBlock(block: string): ServerEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function StageIcon({ stage }: { stage: Stage }) {
  if (stage.status === "error") {
    return <AlertCircle className="site-chat-stage-error-icon" aria-hidden />;
  }
  return (
    <img
      className="site-chat-stage-icon"
      data-running={stage.status === "running"}
      src={STAGE_ICONS[stage.id] || loadingIcon}
      alt=""
    />
  );
}

function upsertStage(stages: Stage[] = [], stage: Stage) {
  const index = stages.findIndex((item) => item.id === stage.id);
  if (index < 0) return [...stages, stage];
  return stages.map((item, itemIndex) => itemIndex === index ? { ...item, ...stage } : item);
}

function ExecutionRecord({ message, copy }: { message: ChatMessage; copy: ChatCopy }) {
  const [expanded, setExpanded] = useState(true);
  const stages = message.stages || [];

  return (
    <section className="site-chat-execution" data-streaming={message.status === "streaming"}>
      <button
        type="button"
        className="site-chat-execution-title"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <img src={executeIcon} alt="" />
        <span>{copy.execution}</span>
        {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
      </button>
      {expanded && (
        <div className="site-chat-stage-list">
          {stages.map((stage) => (
            <div className="site-chat-stage" data-status={stage.status} key={stage.id}>
              <StageIcon stage={stage} />
              <div>
                <strong>{stage.label}</strong>
                {stage.detail && <p>{stage.detail}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StaffProfile({
  copy,
  onPointerEnter,
  onPointerLeave,
  open,
  setProfileRef,
  style,
}: {
  copy: ChatCopy;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  open: boolean;
  setProfileRef: (node: HTMLDivElement | null) => void;
  style: CSSProperties;
}) {
  return (
    <div
      className={`site-chat-profile-card${open ? " is-visible" : ""}`}
      ref={setProfileRef}
      role="tooltip"
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <strong>{copy.emptyGreeting}</strong>
      <p>{copy.emptyRole}</p>
      <div className="site-chat-profile-tags">
        {copy.emptyTags.map((tag) => <span key={tag}>{tag}</span>)}
      </div>
      <div className="site-chat-profile-stats">
        {copy.emptyStats.map((stat) => (
          <div key={stat.label}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StaffAvatar({ copy, placement }: { copy: ChatCopy; placement: "empty" | "composer" }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [profileNode, setProfileNode] = useState<HTMLDivElement | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileStyle, setProfileStyle] = useState<CSSProperties>({ left: -9999, top: -9999 });

  const updateProfilePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const profileRect = profileNode?.getBoundingClientRect();
    const profileWidth = profileRect?.width || 258;
    const profileHeight = profileRect?.height || 164;
    const viewportPadding = 12;
    const gap = 12;

    let left = placement === "empty" ? anchorRect.right + gap : anchorRect.left;
    let top = placement === "empty"
      ? anchorRect.top + (anchorRect.height - profileHeight) / 2
      : anchorRect.top - profileHeight - gap;

    if (left + profileWidth > window.innerWidth - viewportPadding) {
      left = anchorRect.left - profileWidth - gap;
    }
    if (top < viewportPadding) {
      top = Math.min(anchorRect.bottom + gap, window.innerHeight - profileHeight - viewportPadding);
    }

    setProfileStyle({
      left: Math.max(viewportPadding, Math.min(left, window.innerWidth - profileWidth - viewportPadding)),
      top: Math.max(viewportPadding, Math.min(top, window.innerHeight - profileHeight - viewportPadding)),
    });
  }, [placement, profileNode]);

  useLayoutEffect(() => {
    if (!profileOpen) return undefined;
    updateProfilePosition();
    const frame = window.requestAnimationFrame(updateProfilePosition);
    window.addEventListener("resize", updateProfilePosition);
    window.addEventListener("scroll", updateProfilePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateProfilePosition);
      window.removeEventListener("scroll", updateProfilePosition, true);
    };
  }, [profileOpen, updateProfilePosition]);

  useEffect(() => () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
  }, []);

  const cancelHide = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const showProfile = () => {
    cancelHide();
    updateProfilePosition();
    setProfileOpen(true);
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      setProfileOpen(false);
      hideTimerRef.current = null;
    }, 140);
  };

  return (
    <>
      <div
        className={`site-chat-avatar-anchor is-${placement}`}
        ref={anchorRef}
        tabIndex={0}
        aria-label={`${copy.emptyGreeting} ${copy.emptyRole}`}
        onPointerEnter={showProfile}
        onPointerLeave={scheduleHide}
        onFocus={showProfile}
        onBlur={scheduleHide}
        onClick={showProfile}
      >
        <img src={employeeAvatar} alt="" />
      </div>
      {typeof document !== "undefined" && createPortal(
        <StaffProfile
          copy={copy}
          onPointerEnter={showProfile}
          onPointerLeave={scheduleHide}
          open={profileOpen}
          setProfileRef={setProfileNode}
          style={profileStyle}
        />,
        document.body,
      )}
    </>
  );
}

function EmptyState({
  copy,
  disabled,
  onPrompt,
}: {
  copy: ChatCopy;
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}) {
  return (
    <div className="site-chat-empty">
      <div className="site-chat-empty-greeting">
        <StaffAvatar copy={copy} placement="empty" />
        <div>
          <h2>{copy.emptyGreeting}</h2>
          <p>{copy.emptySubtitle}</p>
        </div>
      </div>
      <div className="site-chat-empty-meta">
        <div className="site-chat-empty-role">
          <p>{copy.emptyRole}</p>
          <div>
            {copy.emptyTags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </div>
        <div className="site-chat-empty-stats">
          {copy.emptyStats.map((stat) => (
            <div key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="site-chat-suggestions" aria-label={copy.intro}>
        {copy.prompts.map((prompt) => (
          <button type="button" disabled={disabled} key={prompt} onClick={() => onPrompt(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SiteChat() {
  const { locale } = useI18n();
  const copy = copyByLocale[locale].chat;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [csrfToken, setCsrfToken] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const composingRef = useRef(false);

  useEffect(() => {
    let active = true;
    fetch(`${SITE_CHAT_API_BASE}/session`, { credentials: "include" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
      .then((data) => {
        if (active && typeof data.csrfToken === "string" && typeof data.sessionToken === "string") {
          setCsrfToken(data.csrfToken);
          setSessionToken(data.sessionToken);
        }
      })
      .catch(() => {
        if (active) setCsrfToken("");
        if (active) setSessionToken("");
      });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !stickToBottomRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  const history = useMemo(
    () => messages
      .filter((message) => message.content.trim() && message.status !== "streaming")
      .slice(-8)
      .map(({ role, content }) => ({ role, content })),
    [messages],
  );

  const updateAssistant = (id: string, update: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => message.id === id ? update(message) : message));
  };

  const handleEvent = (assistantId: string, packet: ServerEvent) => {
    updateAssistant(assistantId, (assistant) => {
      const stages = assistant.stages || [];
      if (packet.event === "route.started") {
        return {
          ...assistant,
          stages: upsertStage(stages.filter((stage) => stage.id !== "waiting"), {
            id: "route",
            label: copy.stages.route,
            status: "running",
          }),
        };
      }
      if (packet.event === "route.completed") {
        const mode = String(packet.data.mode || "");
        const label = mode === "product_qa"
          ? copy.stages.routeProduct
          : mode === "casual"
            ? copy.stages.routeCasual
            : copy.stages.routeUnsupported;
        return {
          ...assistant,
          stages: upsertStage(stages, {
            id: "route",
            label,
            detail: typeof packet.data.reason === "string" ? packet.data.reason : undefined,
            status: "done",
          }),
        };
      }
      if (packet.event === "sop.selected") {
        return { ...assistant, stages: upsertStage(stages, { id: "sop", label: copy.stages.sop, status: "done" }) };
      }
      if (packet.event === "retrieval.started") {
        return { ...assistant, stages: upsertStage(stages, { id: "retrieval", label: copy.stages.retrieval, status: "running" }) };
      }
      if (packet.event === "retrieval.completed") {
        return {
          ...assistant,
          stages: upsertStage(stages, { id: "retrieval", label: copy.stages.retrieval, status: "done" }),
          sources: Array.isArray(packet.data.sources) ? packet.data.sources as SiteChatSource[] : [],
        };
      }
      if (packet.event === "answer.started") {
        return { ...assistant, stages: upsertStage(stages, { id: "answer", label: copy.stages.answer, status: "running" }) };
      }
      if (packet.event === "answer.delta") {
        return { ...assistant, content: assistant.content + String(packet.data.delta || "") };
      }
      if (packet.event === "answer.completed") {
        return {
          ...assistant,
          stages: upsertStage(stages, { id: "answer", label: copy.stages.answer, status: "done" }),
          status: "done",
        };
      }
      if (packet.event === "error") {
        const error = String(packet.data.message || copy.retry);
        const activeStage = [...stages].reverse().find((stage) => stage.status === "running");
        return {
          ...assistant,
          error,
          status: "error",
          stages: activeStage
            ? upsertStage(stages, { ...activeStage, status: "error", detail: error })
            : stages,
        };
      }
      return assistant;
    });
  };

  const send = async (contentOverride?: string) => {
    const content = (contentOverride ?? input).trim();
    if (!content || busy || !csrfToken || !sessionToken) return;
    const userMessage: ChatMessage = { id: newId(), role: "user", content, status: "done" };
    const assistantMessage: ChatMessage = {
      id: newId(),
      role: "assistant",
      content: "",
      stages: [{ id: "waiting", label: copy.stages.thinking, status: "running" }],
      status: "streaming",
    };
    setInput("");
    stickToBottomRef.current = true;
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`${SITE_CHAT_API_BASE}/stream`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Site-CSRF": csrfToken,
          "X-Site-Session": sessionToken,
        },
        body: JSON.stringify({ message: content, history, locale }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        blocks.forEach((block) => {
          const packet = parseEventBlock(block);
          if (packet) handleEvent(assistantMessage.id, packet);
        });
        if (done) break;
      }
      if (buffer.trim()) {
        const packet = parseEventBlock(buffer);
        if (packet) handleEvent(assistantMessage.id, packet);
      }
      updateAssistant(assistantMessage.id, (assistant) => assistant.status === "streaming"
        ? { ...assistant, status: "done", stages: (assistant.stages || []).map((stage) => stage.status === "running" ? { ...stage, status: "done" } : stage) }
        : assistant);
    } catch (error) {
      if (controller.signal.aborted) {
        updateAssistant(assistantMessage.id, (assistant) => ({
          ...assistant,
          status: "stopped",
          stages: (assistant.stages || []).map((stage) => stage.status === "running" ? { ...stage, status: "stopped" } : stage),
        }));
      } else {
        updateAssistant(assistantMessage.id, (assistant) => ({
          ...assistant,
          status: "error",
          error: error instanceof Error ? error.message : copy.retry,
        }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="site-chat-shell">
      <div
        className="site-chat-transcript"
        ref={transcriptRef}
        aria-live="polite"
        onScroll={(event) => {
          const target = event.currentTarget;
          stickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
        }}
      >
        <div className="site-chat-transcript-track">
          {messages.length === 0 ? (
            <EmptyState
              copy={copy}
              disabled={busy || !csrfToken || !sessionToken}
              onPrompt={(prompt) => { void send(prompt); }}
            />
          ) : messages.map((message) => {
            const normalized = message.role === "assistant"
              ? normalizeSiteChatCitations(message.content, message.sources || [])
              : { content: message.content, sources: [] as SiteChatSource[] };
            return (
              <article className={`site-chat-message is-${message.role}`} key={message.id}>
                {message.role === "assistant" && <ExecutionRecord message={message} copy={copy} />}
                {normalized.content && (
                  <div className="site-chat-content">
                    {message.role === "assistant"
                      ? <MarkdownMessage content={normalized.content} />
                      : normalized.content}
                  </div>
                )}
                {message.status === "stopped" && <div className="site-chat-stopped">{copy.stopped}</div>}
                {message.error && (
                  <div className="site-chat-error">
                    <AlertCircle aria-hidden />
                    <div><strong>{copy.errorTitle}</strong><p>{message.error}</p></div>
                  </div>
                )}
                {normalized.sources.length > 0 && (
                  <div className="site-chat-sources">
                    <span><img src={referenceIcon} alt="" />{copy.sources}</span>
                    <div>
                      {normalized.sources.map((source) => (
                        <button type="button" key={source.id} title={source.title}>[{source.index}] {source.title}</button>
                      ))}
                    </div>
                  </div>
                )}
                {message.role === "assistant" && message.status !== "streaming" && (
                  <div className="site-chat-feedback">
                    <button type="button" aria-label={copy.feedbackUp} title={copy.feedbackUp}><ThumbsUp aria-hidden /></button>
                    <button type="button" aria-label={copy.feedbackDown} title={copy.feedbackDown}><ThumbsDown aria-hidden /></button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      <div className="site-chat-composer-stage">
        <StaffAvatar copy={copy} placement="composer" />
        <div className="site-chat-composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder={copy.placeholder}
            rows={1}
            maxLength={2_000}
            disabled={busy}
          />
          <div className="site-chat-composer-controls">
            <div className="site-chat-composer-actions">
              {busy ? (
                <button type="button" className="site-chat-send is-stop" onClick={() => abortRef.current?.abort()} aria-label={copy.stop} title={copy.stop}>
                  <Square aria-hidden />
                </button>
              ) : (
                <button type="button" className="site-chat-send" onClick={() => void send()} disabled={!input.trim() || !csrfToken || !sessionToken} aria-label={copy.send} title={copy.send}>
                  <Send aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
