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
  type TurnId,
  ProviderItemId,
} from "@t3tools/contracts";

const PROVIDER = "gemini" as const;

// ---------------------------------------------------------------------------
// Raw Gemini stream-json event types
// ---------------------------------------------------------------------------

type GeminiStreamEventType =
  | "init"
  | "message"
  | "tool_use"
  | "tool_result"
  | "result";

interface GeminiStreamEvent {
  readonly type: GeminiStreamEventType | string;
  readonly timestamp?: string;
  readonly session_id?: string;
  readonly model?: string;
  readonly role?: string;
  readonly content?: string;
  readonly delta?: boolean;
  readonly tool_name?: string;
  readonly tool_id?: string;
  readonly parameters?: unknown;
  readonly status?: string;
  readonly output?: string;
  readonly error?: unknown;
  readonly stats?: {
    readonly total_tokens?: number;
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cached?: number;
    readonly duration_ms?: number;
    readonly tool_calls?: number;
  };
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
  turnId: TurnId,
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

  return mapGeminiEvent(threadId, turnId, event);
}

/**
 * Parse multiple Gemini stream-json lines emitted from a buffer split by
 * newlines and return all canonical events in order.
 */
export function parseGeminiStreamLines(
  threadId: ThreadId,
  turnId: TurnId,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ProviderRuntimeEvent> {
  return lines.flatMap((line) => parseGeminiStreamLine(threadId, turnId, line));
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function makeBase(
  threadId: ThreadId,
  turnId?: TurnId,
): {
  readonly eventId: EventId;
  readonly provider: "gemini";
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly turnId?: TurnId;
} {
  return {
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
    ...(turnId ? { turnId } : {}),
  };
}

function mapGeminiEvent(
  threadId: ThreadId,
  turnId: TurnId,
  event: GeminiStreamEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.type as GeminiStreamEventType) {
    case "init":
      return [];

    case "message": {
      if (event.role !== "assistant") {
        return [];
      }
      const text = event.content;
      if (!text) return [];
      return [
        {
          ...makeBase(threadId, turnId),
          type: "content.delta",
          payload: {
            streamKind: "assistant_text" as const,
            delta: text,
          },
        },
      ];
    }

    case "tool_use": {
      const itemType = toCanonicalToolItemType(event.tool_name);
      const detail = event.parameters ? JSON.stringify(event.parameters) : event.tool_name;
      const itemId = event.tool_id ? ProviderItemId.make(event.tool_id) : undefined;
      return [
        {
          ...makeBase(threadId, turnId),
          ...(itemId ? { providerRefs: { providerItemId: itemId } } : {}),
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
      const itemType = toCanonicalToolItemType(event.tool_name);
      const isError = event.status === "error";
      const detail = event.output ?? (event.error ? JSON.stringify(event.error) : undefined);
      const itemId = event.tool_id ? ProviderItemId.make(event.tool_id) : undefined;

      const baseEvent = {
        ...makeBase(threadId, turnId),
        ...(itemId ? { providerRefs: { providerItemId: itemId } } : {}),
      };

      if (isError) {
        return [
          {
            ...baseEvent,
            type: "item.completed",
            payload: {
              itemType,
              status: "failed" as const,
              ...(detail ? { detail } : {}),
            },
          },
          {
            ...baseEvent,
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
          ...baseEvent,
          type: "item.completed",
          payload: {
            itemType,
            status: "completed" as const,
            ...(detail ? { detail } : {}),
          },
        },
      ];
    }

    case "result": {
      if (!event.stats) return [];
      return [
        {
          ...makeBase(threadId, turnId),
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: event.stats.total_tokens ?? 0,
              inputTokens: event.stats.input_tokens,
              outputTokens: event.stats.output_tokens,
              cachedInputTokens: event.stats.cached,
              compactsAutomatically: true,
            },
          },
        },
      ];
    }

    default:
      return [];
  }
}
