import type { AgentToolCall, AgentToolResult } from "@agent";
import type { ChatAgentRunView, ChatWebSearchActivity, ChatWebSearchSource } from "./chatTypes";

interface WebSearchResultPayload {
  query?: unknown;
  provider?: unknown;
  answer?: unknown;
  results?: unknown;
  responseTime?: unknown;
  truncated?: unknown;
}

interface WebSearchResultItem {
  title?: unknown;
  url?: unknown;
  faviconDataUrl?: unknown;
  faviconMimeType?: unknown;
  content?: unknown;
  score?: unknown;
  publishedDate?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function responseTimeValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function queryFromCall(call: AgentToolCall) {
  if (!isRecord(call.args)) return "";
  return stringValue(call.args.query);
}

function validHttpUrl(value: unknown) {
  const rawUrl = stringValue(value);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function displayUrlFromUrl(url: URL) {
  return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/$/, "");
}

function sourceId(callId: string, url: string, index: number) {
  return `${callId}:source:${index}:${url}`;
}

export function compareWebSearchSourcesByRelevance(
  left: ChatWebSearchSource,
  right: ChatWebSearchSource,
) {
  if (left.score === undefined && right.score === undefined) return 0;
  if (left.score === undefined) return 1;
  if (right.score === undefined) return -1;
  return right.score - left.score;
}

function normalizeWebSearchSources(callId: string, results: unknown): ChatWebSearchSource[] {
  if (!Array.isArray(results)) return [];

  const seenUrls = new Set<string>();
  const sources: ChatWebSearchSource[] = [];

  results.forEach((item, index) => {
    if (!isRecord(item)) return;
    const result = item as WebSearchResultItem;
    const url = validHttpUrl(result.url);
    if (!url) return;

    const normalizedUrl = url.toString();
    if (seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);

    const title = stringValue(result.title) || url.hostname;
    const faviconDataUrl = stringValue(result.faviconDataUrl);
    const faviconMimeType = stringValue(result.faviconMimeType);
    const snippet = stringValue(result.content);
    const publishedDate = stringValue(result.publishedDate);

    sources.push({
      id: sourceId(callId, normalizedUrl, index),
      title,
      url: normalizedUrl,
      displayUrl: displayUrlFromUrl(url),
      domain: url.hostname.replace(/^www\./, ""),
      faviconDataUrl: faviconDataUrl.startsWith("data:image/") ? faviconDataUrl : undefined,
      faviconMimeType: faviconMimeType.startsWith("image/") ? faviconMimeType : undefined,
      snippet: snippet || undefined,
      score: numberValue(result.score),
      publishedDate: publishedDate || undefined,
    });
  });

  return sources.sort(compareWebSearchSourcesByRelevance);
}

function activityFromResult(
  previous: ChatWebSearchActivity | undefined,
  result: AgentToolResult,
): ChatWebSearchActivity {
  const payload = isRecord(result.result) ? (result.result as WebSearchResultPayload) : {};
  const query = stringValue(payload.query) || previous?.query || "";
  const provider = stringValue(payload.provider) || previous?.provider || "web";

  if (!result.ok) {
    return {
      callId: result.callId,
      query,
      provider,
      status: "failed",
      sources: previous?.sources ?? [],
      answer: previous?.answer,
      error: result.error,
      responseTime: previous?.responseTime ?? null,
      truncated: previous?.truncated,
      updatedAt: Date.now(),
    };
  }

  const answer = stringValue(payload.answer);

  return {
    callId: result.callId,
    query,
    provider,
    status: "completed",
    sources: normalizeWebSearchSources(result.callId, payload.results),
    answer: answer || undefined,
    error: undefined,
    responseTime: responseTimeValue(payload.responseTime),
    truncated: typeof payload.truncated === "boolean" ? payload.truncated : undefined,
    updatedAt: Date.now(),
  };
}

function upsertActivity(
  activities: ChatWebSearchActivity[] | undefined,
  activity: ChatWebSearchActivity,
): ChatWebSearchActivity[] {
  const currentActivities = activities ?? [];
  if (!currentActivities.some((candidate) => candidate.callId === activity.callId)) {
    return [...currentActivities, activity];
  }

  return currentActivities.map((candidate) =>
    candidate.callId === activity.callId ? activity : candidate,
  );
}

export function webSearchActivityFromCall(call: AgentToolCall): ChatWebSearchActivity | null {
  if (call.tool !== "web_search") return null;

  return {
    callId: call.id,
    query: queryFromCall(call),
    provider: "tavily",
    status: "running",
    sources: [],
    responseTime: null,
    updatedAt: Date.now(),
  };
}

export function upsertWebSearchActivityFromCall(
  run: ChatAgentRunView,
  call: AgentToolCall,
): ChatWebSearchActivity[] | undefined {
  const activity = webSearchActivityFromCall(call);
  if (!activity) return run.webSearchActivities;

  const existing = run.webSearchActivities?.find((candidate) => candidate.callId === call.id);
  return upsertActivity(run.webSearchActivities, {
    ...activity,
    sources: existing?.sources ?? activity.sources,
    answer: existing?.answer,
    error: existing?.error,
    responseTime: existing?.responseTime ?? activity.responseTime,
    truncated: existing?.truncated,
    status: existing?.status ?? activity.status,
  });
}

export function upsertWebSearchActivityFromResult(
  run: ChatAgentRunView,
  result: AgentToolResult,
): ChatWebSearchActivity[] | undefined {
  if (result.tool !== "web_search") return run.webSearchActivities;

  const previous = run.webSearchActivities?.find((activity) => activity.callId === result.callId);
  return upsertActivity(run.webSearchActivities, activityFromResult(previous, result));
}

export function normalizeWebSearchActivities(run: ChatAgentRunView): ChatWebSearchActivity[] {
  const activities = run.webSearchActivities ?? [];

  return run.toolCalls.reduce<ChatWebSearchActivity[]>((currentActivities, call) => {
    if (call.tool !== "web_search") return currentActivities;

    const callActivity =
      currentActivities.find((activity) => activity.callId === call.id) ??
      webSearchActivityFromCall(call);
    if (!callActivity) return currentActivities;

    const result = run.toolResults.find((candidate) => candidate.callId === call.id);
    const nextActivity = result ? activityFromResult(callActivity, result) : callActivity;
    return upsertActivity(currentActivities, nextActivity);
  }, activities);
}

export function getUniqueWebSearchSources(run: ChatAgentRunView | undefined): ChatWebSearchSource[] {
  if (!run?.webSearchActivities?.length) return [];

  const seenUrls = new Set<string>();
  const sources: ChatWebSearchSource[] = [];

  run.webSearchActivities.forEach((activity) => {
    activity.sources.forEach((source) => {
      if (seenUrls.has(source.url)) return;
      seenUrls.add(source.url);
      sources.push(source);
    });
  });

  return sources.sort(compareWebSearchSourcesByRelevance);
}
