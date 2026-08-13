/**
 * MCP tool results land directly in an agent's context window. Passing through
 * a fat 25-row API response spends thousands of tokens on nested ids, HTML and
 * admin fields the caller did not ask for, so every result is projected and
 * bounded here before it crosses the protocol boundary.
 */
import type { ParticipantRecord, SessionRecord, SpeakerRecord } from "./client";

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export interface ToolTextResult {
  content: [{ type: "text"; text: string }];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(
  text: string,
  max: number,
  fullTextTool: string | null = "get_submission",
): TruncatedText {
  const originalLength = text.length;
  if (originalLength <= max) return { text, truncated: false, originalLength };

  /*
   * Naming the tool that returns the untruncated text is the point of the
   * marker: an agent that only learns text was cut has to guess its next move.
   * Where no exposed tool returns the full value — a speaker biography, which
   * only the REST API serves in full — the marker says so rather than naming a
   * tool that would not help.
   */
  const recovery = fullTextTool
    ? `call ${fullTextTool} for the full text`
    : "the full text is available via the REST API";
  const marker = `… [truncated: ${originalLength.toLocaleString("en-US")} chars total — ${recovery}]`;
  const keep = Math.max(0, max - marker.length);
  return {
    text: `${text.slice(0, keep).trimEnd()}${marker}`,
    truncated: true,
    originalLength,
  };
}

function nameOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function compactParticipant(participant: ParticipantRecord) {
  return {
    name: participant.full_name ?? participant.name ?? null,
    email: participant.email ?? null,
    company: participant.company_name ?? participant.company ?? null,
  };
}

export function compactSession(
  record: SessionRecord,
  options: { detail: "list" | "full" },
): Record<string, unknown> {
  const description = record.description == null
    ? null
    : truncate(stripHtml(record.description), options.detail === "list" ? 200 : 1_200);
  const common = {
    id: record.id,
    event_id: record.event_id ?? null,
    friendly_id: record.friendly_id ?? null,
    title: record.title,
    status: record.status ?? null,
    is_abstract: record.is_abstract ?? null,
    description,
    starts_at: record.starts_at ?? null,
    ends_at: record.ends_at ?? null,
    schedule_state: record.starts_at ? "scheduled" : "unscheduled",
    track: nameOf(record.track),
    room: nameOf(record.room),
    format: nameOf(record.format),
    level: nameOf(record.level),
    tags: (record.tags ?? []).map(nameOf).filter((name): name is string => name !== null),
    participants: (record.participants ?? []).map(compactParticipant),
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null,
  };
  if (options.detail === "list") return common;
  return {
    ...common,
    capacity: record.capacity ?? null,
    is_public: record.is_public ?? null,
    composition_status: record.composition_status ?? null,
    custom_fields: record.custom_fields ?? [],
    deleted_at: record.deleted_at ?? null,
    admin_url: record.admin_url ?? null,
  };
}

export function compactSpeaker(record: SpeakerRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.full_name ?? record.name ?? null,
    company: record.company_name ?? record.company ?? null,
    email: record.email ?? null,
    about: record.about == null ? null : truncate(stripHtml(record.about), 300, null),
  };
}

export function toolJson(value: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
