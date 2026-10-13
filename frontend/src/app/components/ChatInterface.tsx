"use client";

import React, { useRef, useCallback, useMemo, useEffect, FormEvent } from "react";
import {
  Square,
  ArrowUp,
  Paperclip,
  Loader2,
  FileText,
  Search,
  ClipboardList,
  GraduationCap,
  Upload,
  Activity,
  DollarSign,
  Users,
  Wrench,
} from "lucide-react";
import { ChatMessage } from "@/app/components/ChatMessage";
import { LogoMark } from "@/app/components/LogoMark";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";
import type { ToolCall } from "@/app/types/types";
import { approvalQueueNote, useInterruptApprovals } from "@/app/hooks/useInterruptApprovals";
import { Assistant } from "@langchain/langgraph-sdk";
import {
  type AIMessageChunk,
  type BaseMessage,
  isAIMessage,
  isHumanMessage,
  isToolMessage,
} from "@langchain/core/messages";
import { ANALYTICS_AGENT_ID, CAREER_AGENT_ID } from "@/app/config/agents";
import { CHART_TOOL_NAME } from "@/app/lib/charts";
import { extractStringFromMessageContent, parsePartialArgs } from "@/app/utils/utils";
import { useChatContext } from "@/providers/ChatProvider";
import { useFileUpload, useUploadDrop } from "@/app/hooks/useFileUpload";
import { useUploadCue } from "@/app/hooks/useUploadCue";
import { UPLOAD_ACCEPT } from "@/app/lib/uploadFiles";
import { useStickToBottom } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

interface ChatInterfaceProps {
  assistant: Assistant | null;
}

// Empty-state suggestion chips. Clicking fills the composer.
const CAREER_SUGGESTIONS = [
  {
    label: "调研公司",
    icon: Search,
    prompt: "请调研我正在面试的公司和职位，并总结该职位看重的能力。",
  },
  {
    label: "优化我的简历",
    icon: FileText,
    prompt: "请根据具体职位描述优化我的简历。",
  },
  {
    label: "准备面试",
    icon: GraduationCap,
    prompt: "请帮我准备面试，按轮次制定计划，并准备 STAR 故事。",
  },
  {
    label: "制作面试速查卡",
    icon: ClipboardList,
    prompt: "请为我即将参加的面试制作一页式面试速查卡。",
  },
];

// Each asks for a chart explicitly: without that the agent often answers in
// prose alone, which is a fine answer but a poor first impression of what it
// can do.
const ANALYTICS_SUGGESTIONS = [
  {
    label: "运行可靠性",
    icon: Activity,
    prompt: "按天对比本周与上周的失败运行次数，并绘制图表。",
  },
  {
    label: "LLM 成本",
    icon: DollarSign,
    prompt:
      "统计过去 30 天各模型的 LLM 成本，绘制图表，并说明使用数据实际覆盖了多少支出。",
  },
  {
    label: "活跃用户",
    icon: Users,
    prompt: "绘制过去 30 天的每日活跃用户数，排除单用户历史记录。",
  },
  {
    label: "工具使用情况",
    icon: Wrench,
    prompt: "哪些工具调用最多，哪些调用会失败？请绘制图表。",
  },
];

/**
 * What the empty state says, per agent.
 *
 * The hero is the first thing a user reads, and career copy under the
 * analytics agent would be simply wrong. Keyed by graph id, falling back to
 * the career agent for anything unrecognised.
 */
const EMPTY_STATES: Record<
  string,
  {
    heading: React.ReactNode;
    blurb: string;
    suggestions: typeof CAREER_SUGGESTIONS;
    showUpload: boolean;
    placeholder: string;
  }
> = {
  [ANALYTICS_AGENT_ID]: {
    heading: (
      <>
        了解<em className="text-brand-accent-text italic">你的产品</em>。
      </>
    ),
    blurb:
      "直接从数据仓库了解活跃度、可靠性、LLM 成本和助手行为。用自然语言提问，获得数据、关键限制说明，以及必要时的图表。",
    suggestions: ANALYTICS_SUGGESTIONS,
    showUpload: false,
    placeholder: "给 OfferMind 发消息：询问使用情况、可靠性或成本……",
  },
  [CAREER_AGENT_ID]: {
    heading: (
      <>
        更快拿到<em className="text-brand-accent-text italic">下一份工作</em>。
      </>
    ),
    blurb:
      "上传你的简历和职位描述。OfferMind 会优化申请材料、调研公司，并为每一轮面试做好准备，全部集中在一个工作区中。",
    suggestions: CAREER_SUGGESTIONS,
    showUpload: true,
    placeholder: "给 OfferMind 发消息：粘贴职位链接，或描述你想申请的职位……",
  },
};

// The composer's paperclip attach is hidden by default — uploads are handled in
// the Workspace (Files → Upload), which uses the same path. Flip to `true` to
// re-show the paperclip in the composer; the upload logic below stays wired.
const COMPOSER_ATTACH_ENABLED = false;

/** Tools rendered as their own card in the message column, not in the rail. */
const CARD_TOOL_NAMES = new Set<string>(["task", CHART_TOOL_NAME]);

export const ChatInterface = React.memo<ChatInterfaceProps>(({ assistant }) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const { uploading, uploadFiles, onInputChange } = useFileUpload();
  const { dragActive, dropHandlers } = useUploadDrop(uploadFiles, uploading);
  const { showUploadCta } = useUploadCue();

  // The empty state belongs to the agent: career copy under the analytics
  // agent would simply be wrong, and its upload cue meaningless.
  const emptyState = EMPTY_STATES[assistant?.graph_id ?? ""] ?? EMPTY_STATES[CAREER_AGENT_ID];

  const { scrollRef, contentRef } = useStickToBottom();

  const {
    stream,
    messages,
    isLoading,
    isThreadLoading,
    interrupts,
    sendMessage,
    stopStream,
    resumeInterrupt,
    input,
    setInput,
    focusComposerNonce,
  } = useChatContext();

  // HITL approval state. `getThreadInterrupts` reads the ThreadStream record
  // (live subagent interrupts never reach `interrupts`); the ref keeps the
  // accessor referentially stable so the hook's derivation isn't re-run per
  // render.
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const getThreadInterrupts = useCallback(() => streamRef.current.getThread()?.interrupts, []);
  const approvals = useInterruptApprovals({
    interrupts,
    getThreadInterrupts,
    isLoading,
    messages,
    resumeInterrupt,
  });
  const { interruptedToolCallIds } = approvals;

  // The v2 protocol coerces ANY new input on an interrupted thread into a
  // resume (`Command(resume=<input>)`) — a chat message would crash the HITL
  // middleware, which expects `{decisions: [...]}`. So while a review is
  // pending the composer locks; Reject-with-message is the channel for
  // "never mind, do something else instead".
  const reviewPending = approvals.pendingApprovals.length > 0 || interrupts.length > 0;

  const submitDisabled = isLoading || !assistant || reviewPending;

  // Focus the textarea (with cursor at end) whenever a sibling surface — e.g.
  // Workspace > Files Upload — appended an "Uploaded: ..." note. Skip the
  // initial mount nonce==0.
  useEffect(() => {
    if (focusComposerNonce === 0) return;
    const t = textareaRef.current;
    if (!t) return;
    t.focus();
    const end = t.value.length;
    t.setSelectionRange(end, end);
  }, [focusComposerNonce]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 28;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const verticalPadding = paddingTop + paddingBottom;
    const minHeight = lineHeight * 2 + verticalPadding;
    const maxHeight = lineHeight * 5 + verticalPadding;

    textarea.style.height = `${minHeight}px`;

    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight + 1 ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const handleSubmit = useCallback(
    (e?: FormEvent) => {
      if (e) {
        e.preventDefault();
      }
      const messageText = input.trim();
      if (!messageText || isLoading || submitDisabled) return;
      sendMessage(messageText);
      setInput("");
    },
    [input, isLoading, sendMessage, setInput, submitDisabled]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (submitDisabled) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, submitDisabled]
  );

  const fillSuggestion = useCallback(
    (prompt: string) => {
      setInput(prompt);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        const end = t.value.length;
        t.setSelectionRange(end, end);
      });
    },
    [setInput]
  );

  // Cache stable references for finalized ToolCall objects and per-message
  // toolCall arrays. While streaming, each token produces a new `messages`
  // reference, which previously rebuilt every ToolCall fresh and defeated the
  // React.memo on ChatMessage/ToolCallBox. We keep finalized entries cached by
  // id and only emit a new array reference for messages whose entries actually
  // changed — the streaming AI message gets a fresh reference so its tool box
  // re-renders and shows live tokens; all earlier messages stay stable.
  const toolCallCacheRef = useRef(new Map<string, ToolCall>());
  const toolCallArrayCacheRef = useRef(new Map<string, ToolCall[]>());

  // TODO: can we make this part of the hook?
  const processedMessages = useMemo(() => {
    /*
     1. Loop through all messages
     2. For each AI message, add the AI message, and any tool calls to the messageMap
     3. For each tool message, find the corresponding tool call in the messageMap and update the status and output
    */
    const messageMap = new Map<string, { message: BaseMessage; toolCalls: ToolCall[] }>();
    messages.forEach((message: BaseMessage) => {
      if (isAIMessage(message)) {
        // Completed calls live on `tool_calls` (parsed args); a call whose
        // args are still streaming only exists as a `tool_call_chunks` entry
        // (partial-JSON string args) until it finishes assembling.
        const done = (message.tool_calls ?? []).filter((tc) => tc.name !== "");
        const doneIds = new Set(done.map((tc) => tc.id));
        const chunks = (message as AIMessageChunk).tool_call_chunks ?? [];
        const streaming = chunks.filter((c) => c.id && c.name && !doneIds.has(c.id));
        // Pending tools: always fresh reference so the streaming box re-renders.
        // Cache hit happens later when the matching ToolMessage flips status.
        // Only calls with a pending approval routed to them read as
        // "interrupted" — a parallel call the reviewer isn't gating stays a
        // plain pending row.
        const statusFor = (id: string | undefined | null): ToolCall["status"] =>
          id && interruptedToolCallIds.has(id) ? "interrupted" : "pending";
        const toolCallsWithStatus: ToolCall[] = [
          ...done.map((tc) => ({
            id: tc.id ?? `tool-${Math.random()}`,
            name: tc.name,
            args: (tc.args ?? {}) as Record<string, unknown>,
            status: statusFor(tc.id),
          })),
          ...streaming.map((c) => ({
            id: c.id!,
            name: c.name!,
            args: parsePartialArgs(c.args),
            status: statusFor(c.id),
          })),
        ];
        messageMap.set(message.id!, {
          message,
          toolCalls: toolCallsWithStatus,
        });
      } else if (isToolMessage(message)) {
        const toolCallId = message.tool_call_id;
        if (!toolCallId) {
          return;
        }
        for (const [, data] of messageMap.entries()) {
          const toolCallIndex = data.toolCalls.findIndex((tc: ToolCall) => tc.id === toolCallId);
          if (toolCallIndex === -1) {
            continue;
          }
          const result = extractStringFromMessageContent(message);
          const cached = toolCallCacheRef.current.get(toolCallId);
          if (cached && cached.status === "completed" && cached.result === result) {
            data.toolCalls[toolCallIndex] = cached;
          } else {
            const next: ToolCall = {
              ...data.toolCalls[toolCallIndex],
              status: "completed" as const,
              result,
            };
            toolCallCacheRef.current.set(toolCallId, next);
            data.toolCalls[toolCallIndex] = next;
          }
          break;
        }
      } else if (isHumanMessage(message)) {
        messageMap.set(message.id!, {
          message,
          toolCalls: [],
        });
      }
    });
    const processedArray = Array.from(messageMap.values());
    // Reuse the previous toolCalls array reference when none of the entries
    // changed identity, so React.memo on ChatMessage short-circuits for messages
    // that aren't actively streaming.
    const arrayCache = toolCallArrayCacheRef.current;
    const seenMessageIds = new Set<string>();
    const result = processedArray.map((data, index) => {
      const prevMessage = index > 0 ? processedArray[index - 1].message : null;
      const messageId = data.message.id;
      let toolCalls = data.toolCalls;
      if (messageId) {
        seenMessageIds.add(messageId);
        const cachedArray = arrayCache.get(messageId);
        const sameRefs =
          cachedArray &&
          cachedArray.length === toolCalls.length &&
          cachedArray.every((tc, i) => tc === toolCalls[i]);
        if (sameRefs) {
          toolCalls = cachedArray!;
        } else {
          arrayCache.set(messageId, toolCalls);
        }
      }
      return {
        message: data.message,
        toolCalls,
        showAvatar: data.message.type !== prevMessage?.type,
      };
    });
    // Drop entries for messages that no longer exist (e.g. thread switch).
    for (const id of arrayCache.keys()) {
      if (!seenMessageIds.has(id)) arrayCache.delete(id);
    }
    return result;
  }, [messages, interruptedToolCallIds]);

  // Merge consecutive runs of regular (non-`task`) tool calls across AI
  // messages into one disclosure unit per run, batched by issuing message
  // (calls in one message ran in parallel). A run breaks on prose — which
  // renders above its own message's tool calls — on a subagent spawn — whose
  // card renders below them — and on human messages. The same identity-caching
  // discipline as processedMessages applies: a head keeps its previous batches
  // reference while no member batch changed, so React.memo holds downstream.
  const regularToolCallsCacheRef = useRef(
    new Map<string, { source: ToolCall[]; regular: ToolCall[] }>()
  );
  const toolBatchesCacheRef = useRef(new Map<string, ToolCall[][]>());

  const { toolBatchesByHead, openEndedHeadId } = useMemo(() => {
    const regularCache = regularToolCallsCacheRef.current;
    const batchesCache = toolBatchesCacheRef.current;
    const byHead = new Map<string, ToolCall[][]>();
    const seenMessageIds = new Set<string>();
    let current: { headId: string; batches: ToolCall[][] } | null = null;

    for (const { message, toolCalls } of processedMessages) {
      const messageId = message.id;
      if (!messageId || message.type === "human") {
        current = null;
        continue;
      }
      seenMessageIds.add(messageId);

      let regular: ToolCall[];
      const cached = regularCache.get(messageId);
      if (cached && cached.source === toolCalls) {
        regular = cached.regular;
      } else {
        // Excluded because they render as their own cards (see ChatMessage):
        // `task` becomes a subagent card, `create_chart` a chart.
        regular = toolCalls.filter((tc) => !CARD_TOOL_NAMES.has(tc.name));
        if (
          cached &&
          cached.regular.length === regular.length &&
          cached.regular.every((tc, i) => tc === regular[i])
        ) {
          regular = cached.regular;
        }
        regularCache.set(messageId, { source: toolCalls, regular });
      }

      if (extractStringFromMessageContent(message).trim() !== "") current = null;
      if (regular.length > 0) {
        if (!current) current = { headId: messageId, batches: [] };
        current.batches.push(regular);
        byHead.set(current.headId, current.batches);
      }
      if (toolCalls.some((tc) => tc.name === "task" && !!tc.args["subagent_type"])) {
        current = null;
      }
    }

    for (const [headId, batches] of byHead) {
      const prev = batchesCache.get(headId);
      if (prev && prev.length === batches.length && prev.every((b, i) => b === batches[i])) {
        byHead.set(headId, prev);
      } else {
        batchesCache.set(headId, batches);
      }
    }
    for (const id of batchesCache.keys()) if (!byHead.has(id)) batchesCache.delete(id);
    for (const id of regularCache.keys()) if (!seenMessageIds.has(id)) regularCache.delete(id);

    // A transcript that ends inside a run may still grow another batch — its
    // head holds the group open across think-pauses while the run is live.
    return { toolBatchesByHead: byHead, openEndedHeadId: current?.headId ?? null };
  }, [processedMessages]);

  // Approvals no tool-call box renders: subagent-owned ones are claimed by
  // their SubagentCard; whatever remains gets a standalone card below the
  // transcript so a pending interrupt is NEVER invisible or unanswerable
  // (e.g. a reloaded thread whose subagent activity doesn't replay).
  const fallbackApprovals = useMemo(
    () =>
      approvals.unassignedApprovals.filter(
        (approval) => !approvals.claimedKeySet.has(approval.key)
      ),
    [approvals.unassignedApprovals, approvals.claimedKeySet]
  );

  const isEmpty = !isThreadLoading && processedMessages.length === 0;
  const canSend = !submitDisabled && input.trim().length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-canvas">
      {/* Shared picker for the hero upload CTA and the composer paperclip. */}
      <input
        ref={attachInputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={onInputChange}
      />
      <div className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain" ref={scrollRef}>
        <div ref={contentRef}>
          {isThreadLoading ? (
            <div className="flex items-center justify-center p-8">
              <p className="text-secondary">加载中…</p>
            </div>
          ) : isEmpty ? (
            <div className="flex min-h-[68vh] flex-col items-center justify-center px-7 py-10 text-center">
              <div
                className="mb-6"
                style={{
                  filter:
                    "drop-shadow(0 10px 28px color-mix(in srgb, var(--brand-accent) 32%, transparent))",
                }}
              >
                <LogoMark size={56} />
              </div>
              <h1 className="font-serif text-[40px] leading-[1.08] font-medium tracking-[-0.01em] text-primary">
                {emptyState.heading}
              </h1>
              <p className="mx-auto mt-4 max-w-[480px] text-[15.5px] leading-relaxed text-secondary">
                {emptyState.blurb}
              </p>
              {showUploadCta && emptyState.showUpload && (
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={uploading}
                  {...dropHandlers}
                  className={cn(
                    "mt-8 flex w-full max-w-[480px] items-center gap-3.5 rounded-2xl border border-dashed border-border2 bg-surface-raised/70 px-5 py-4 text-left shadow-sm transition-colors hover:border-brand-strong hover:bg-brand-accent-soft/40 disabled:opacity-60",
                    dragActive && "border-brand-strong bg-brand-accent-soft/40"
                  )}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-[9px] bg-brand-accent-soft text-brand-accent">
                    {uploading ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Upload size={18} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold text-primary">
                      添加你的简历或职位描述
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-tertiary">
                      {uploading
                        ? "上传中…"
                        : "点击选择文件，或拖放文件 — 仅支持 PDF、DOC、DOCX、TXT、MD"}
                    </span>
                  </span>
                </button>
              )}
              <div
                className={cn(
                  "flex max-w-[560px] flex-wrap justify-center gap-2.5",
                  showUploadCta ? "mt-5" : "mt-7"
                )}
              >
                {emptyState.suggestions.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => fillSuggestion(s.prompt)}
                    className="flex items-center gap-2 rounded-[11px] border border-primary bg-surface-raised px-3.5 py-2.5 text-[13.5px] font-medium text-primary shadow-sm transition-all hover:-translate-y-px hover:border-brand-strong"
                  >
                    <s.icon className="size-4 text-brand-accent" />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[760px] px-6 pt-6 pb-8">
              {processedMessages.map((data) => {
                const messageId = data.message.id;
                const toolBatches = messageId ? toolBatchesByHead.get(messageId) : undefined;
                return (
                  <ChatMessage
                    key={messageId}
                    message={data.message}
                    toolCalls={data.toolCalls}
                    toolBatches={toolBatches ?? null}
                    isOpenEndedGroup={messageId != null && messageId === openEndedHeadId}
                    isLoading={isLoading}
                    showAvatar={data.showAvatar}
                    approvals={approvals}
                    stream={stream}
                  />
                );
              })}
              {fallbackApprovals.length > 0 && (
                <div className="mt-5 flex flex-col gap-3 pl-10">
                  {fallbackApprovals.map((approval) => (
                    <div
                      key={approval.key}
                      className="overflow-hidden rounded-lg border border-warning/30 bg-warning/10 p-3"
                    >
                      <ToolApprovalInterrupt
                        actionRequest={approval.actionRequest}
                        reviewConfig={approval.reviewConfig}
                        onDecide={(decision) => approvals.decide(approval, decision)}
                        queuedDecision={approvals.queuedDecisions.get(approval.key)}
                        queueNote={approvalQueueNote(approval, approvals.queuedDecisions)}
                        isLoading={isLoading}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 bg-linear-to-t from-canvas via-canvas to-transparent px-4 pt-4 pb-5">
        <div className="mx-auto w-full max-w-[760px]">
          {isLoading && (
            <div className="mb-2 flex items-center gap-2 px-2 text-xs text-secondary">
              <span className="size-1.5 animate-pulse rounded-full bg-brand-accent" />
              OfferMind 正在处理…
            </div>
          )}
          {!isLoading && reviewPending && (
            <div className="mb-2 flex items-center gap-2 px-2 text-xs text-secondary">
              <span className="size-1.5 rounded-full bg-warning" />
              等待你的审核：请批准、编辑或拒绝待处理的操作后继续。
            </div>
          )}
          <div className="flex flex-col overflow-hidden rounded-[18px] border border-primary bg-surface-raised shadow-lg shadow-black/5 transition-colors focus-within:border-brand-strong focus-within:ring-2 focus-within:ring-brand-accent/30">
            <form onSubmit={handleSubmit} className="flex flex-col">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  requestAnimationFrame(resizeTextarea);
                }}
                onKeyDown={handleKeyDown}
                placeholder={emptyState.placeholder}
                className="block w-full resize-none border-0 bg-transparent px-5 pt-4 pb-3 text-[15px] leading-7 text-primary outline-hidden placeholder:text-tertiary"
                rows={2}
              />
              <div className="flex items-center justify-between gap-2 px-3 pb-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  {COMPOSER_ATTACH_ENABLED && (
                    <button
                      type="button"
                      title="附加文件"
                      onClick={() => attachInputRef.current?.click()}
                      disabled={uploading || submitDisabled}
                      className="grid size-9 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-surface3 hover:text-primary disabled:opacity-50"
                    >
                      {uploading ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Paperclip size={16} />
                      )}
                    </button>
                  )}
                  <span className="truncate text-xs text-tertiary">
                    按 Enter 发送 · Shift+Enter 换行
                  </span>
                </div>
                <button
                  type={isLoading ? "button" : "submit"}
                  onClick={isLoading ? stopStream : handleSubmit}
                  disabled={!isLoading && !canSend}
                  aria-label={isLoading ? "停止" : "发送"}
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
                    isLoading
                      ? "bg-destructive text-white hover:bg-destructive/90"
                      : canSend
                        ? "bg-brand-accent text-on-accent hover:bg-brand-accent-hover"
                        : "bg-border2 text-tertiary"
                  )}
                >
                  {isLoading ? <Square size={14} /> : <ArrowUp size={18} />}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
});

ChatInterface.displayName = "ChatInterface";
