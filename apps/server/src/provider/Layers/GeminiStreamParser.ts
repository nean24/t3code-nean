/**
 * GeminiStreamParser – Maps Gemini CLI stream-json lines into canonical
 * `ProviderRuntimeEvent` objects.
 *
 * Gemini CLI emits newline-delimited JSON when launched with
 * `--output-format stream-json`. Each line is a single structured event
 * object. This module parses those lines and translates them into the
 * provider-neutral `ProviderRuntimeEvent` stream consumed by the
 * orchestration layer.
 *
 * @module GeminiStreamParser
 */

import { randomUUID } from "node:crypto";
import {
  EventId,
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";

const PROVIDER = "gemini" as const;

// ---------------------------------------------------------------------------
// Raw Gemini stream-json event types
// ---------------------------------------------------------------------------

/**
 * Subset of Gemini CLI stream-json event types we handle.
 * Unknown types fall through to a no-op.
 */
type GeminiStreamEventType =
  | "content"
  | "tool_call"
  | "tool_result"
  | "turn_start"
  | "turn_end"
  | "error"
  | "session_start"
  | "session_end"
  | "approval_request"
  | "approval_response";

interface GeminiStreamEvent {
  readonly type: GeminiStreamEventType | string;
  readonly text?: string;
  readonly tool?: string;
  readonly status?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly error?: string;
  readonly requestId?: string;
  readonly decision?: string;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly turnId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventId(): EventId {
  return EventId.make(randomUUID());
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimOrUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function toCanonicalToolItemType(tool: string | undefined): CanonicalItemType {
  const name = trimOrUndefined(tool);
  if (!name) return "dynamic_tool_call";
  const normalized = name.toLowerCase();
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch"))
    return "file_change";
  if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("exec"))
    return "command_execution";
  if (normalized.includes("search") || normalized.includes("web")) return "web_search";
  if (normalized.includes("read") || normalized.includes("file")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

// ---------------------------------------------------------------------------
// Public: parse a single Gemini stream-json line
// ---------------------------------------------------------------------------

/**
 * Parse a single raw Gemini stream-json line (already decoded from the
 * process stdout) and return zero or more canonical `ProviderRuntimeEvent`
 * objects.
 *
 * Invalid JSON lines or unknown event types produce an empty array.
 */
export function parseGeminiStreamLine(
  threadId: ThreadId,
  rawLine: string,
): ReadonlyArray<ProviderRuntimeEvent> {
  const line = rawLine.trim();
  if (!line || !line.startsWith("{")) {
    return [];
  }

  let event: GeminiStreamEvent;
  try {
    event = JSON.parse(line) as GeminiStreamEvent;
  } catch {
    return [];
  }

  return mapGeminiEvent(threadId, event);
}

/**
 * Parse multiple Gemini stream-json lines emitted from a buffer split by
 * newlines and return all canonical events in order.
 */
export function parseGeminiStreamLines(
  threadId: ThreadId,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ProviderRuntimeEvent> {
  return lines.flatMap((line) => parseGeminiStreamLine(threadId, line));
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function makeBase(threadId: ThreadId, turnIdStr?: string): {
  readonly eventId: EventId;
  readonly provider: "gemini";
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly turnId?: ReturnType<typeof TurnId.make>;
} {
  return {
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
    ...(turnIdStr ? { turnId: TurnId.make(turnIdStr) } : {}),
  };
}

function mapGeminiEvent(
  threadId: ThreadId,
  event: GeminiStreamEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.type as GeminiStreamEventType) {
    case "session_start":
      return [
        {
          ...makeBase(threadId),
          type: "session.state.changed",
          payload: { state: "ready" as const },
        },
      ];

    case "session_end":
      return [
        {
          ...makeBase(threadId),
          type: "session.exited",
          payload: {
            exitKind: "graceful" as const,
            ...(trimOrUndefined(event.reason) ? { reason: trimOrUndefined(event.reason)! } : {}),
          },
        },
      ];

    case "turn_start":
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "turn.started",
          payload: {},
        },
      ];

    case "turn_end":
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "turn.completed",
          payload: { state: "completed" as const },
        },
      ];

    case "content": {
      const text = trimOrUndefined(event.text);
      if (!text) return [];
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "content.delta",
          payload: {
            streamKind: "assistant_text" as const,
            delta: text,
          },
        },
      ];
    }

    case "tool_call": {
      const itemType = toCanonicalToolItemType(event.tool);
      const detail = trimOrUndefined(
        typeof event.input === "string"
          ? event.input
          : event.input
            ? JSON.stringify(event.input)
            : event.tool,
      );
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress" as const,
            ...(detail ? { detail } : {}),
          },
        },
      ];
    }

    case "tool_result": {
      const itemType = toCanonicalToolItemType(event.tool);
      const detail = trimOrUndefined(
        typeof event.output === "string"
          ? event.output
          : event.output
            ? JSON.stringify(event.output)
            : undefined,
      );
      const isError = event.status === "error" || event.status === "failed";
      if (isError) {
        return [
          {
            ...makeBase(threadId, event.turnId),
            type: "runtime.error",
            payload: {
              message: detail ?? "Tool call failed",
              class: "provider_error" as const,
            },
          },
        ];
      }
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "item.completed",
          payload: {
            itemType,
            status: "completed" as const,
            ...(detail ? { detail } : {}),
          },
        },
      ];
    }

    case "approval_request": {
      const requestId = trimOrUndefined(event.requestId);
      if (!requestId) return [];
      const detail = trimOrUndefined(event.reason ?? event.tool);
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "request.opened",
          payload: {
            requestType: "exec_command_approval" as const,
            ...(detail ? { detail } : {}),
          },
        },
      ];
    }

    case "approval_response": {
      const requestId = trimOrUndefined(event.requestId);
      if (!requestId) return [];
      const decision =
        event.decision === "accept" || event.decision === "acceptForSession"
          ? event.decision
          : "decline";
      return [
        {
          ...makeBase(threadId, event.turnId),
          type: "request.resolved",
          payload: {
            requestType: "exec_command_approval" as const,
            decision,
          },
        },
      ];
    }

    case "error": {
      const message = trimOrUndefined(event.error ?? event.text);
      if (!message) return [];
      return [
        {
          ...makeBase(threadId),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error" as const,
          },
        },
      ];
    }

    default:
      // Unknown event types from future Gemini CLI versions are silently dropped.
      return [];
  }
}
