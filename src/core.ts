import { HandlesApiConnectionError, HandlesApiError, type HandlesApiErrorCode } from "./errors.js";
import type { ApiMeta } from "./generated/types.js";

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.handlesapi.com/v1";

export interface ClientOptions {
  /** API key (`hk_live_...`). Falls back to the `HANDLES_API_KEY` environment variable. Keep it server-side. */
  apiKey?: string;
  /** Defaults to `https://api.handlesapi.com/v1`. */
  baseUrl?: string;
  /** Retries after a 429, a 5xx or a network failure. Default 2. Set 0 to disable. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 60000: live reads can take ten seconds or more. */
  timeoutMs?: number;
  /** Longest `Retry-After` the client will sleep through; a longer wait is thrown instead. Default 30 seconds. */
  maxRetryAfterSeconds?: number;
  /** Custom `fetch`, for tests or proxies. Defaults to the global one (Node 18+, browsers, Deno, Bun, Workers). */
  fetch?: typeof fetch;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  /** Abort the call (including pending retries). */
  signal?: AbortSignal;
  /** Overrides the client's `maxRetries` for this call. */
  maxRetries?: number;
  /** Overrides the client's `timeoutMs` for this call. */
  timeoutMs?: number;
}

/** What the API reports in `X-Credits-*` on every successful call. Values are null when a header is missing. */
export interface CreditsInfo {
  /** Credits this call used. */
  cost: number | null;
  /** Plan credits left in the current period. */
  remaining: number | null;
  /** When the current period ends, ISO 8601. */
  periodEnd: string | null;
}

/** `X-RateLimit-*`: the per-minute window. */
export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds at which the window resets. */
  reset: number | null;
}

export interface ApiResponse<T> {
  data: T;
  meta: ApiMeta;
  credits: CreditsInfo;
  rateLimit: RateLimitInfo;
  /** From `meta.request_id`, falling back to the `X-Request-Id` header. */
  requestId: string | null;
  headers: Headers;
}

export interface RawRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below the base URL, already filled in, for example `/accounts/x/nasa`. */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

const num = (v: string | null): number | null => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `Retry-After` is either delta-seconds or an HTTP date. Returns seconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, (at - now) / 1000);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function serializeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    usp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.HANDLES_API_KEY;
}

type Failure = HandlesApiError | HandlesApiConnectionError;

const isRetryable = (err: Failure): boolean => (err instanceof HandlesApiConnectionError ? true : err.retryable);

/** 429 honours Retry-After; everything else backs off exponentially with jitter (500 ms, 1 s, 2 s... capped at 8 s). */
export function retryDelayMs(err: Failure, attempt: number): number {
  if (err instanceof HandlesApiError && err.retryAfter !== null) return Math.ceil(err.retryAfter * 1000);
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

/** Transport shared by every endpoint method: auth, JSON, credit headers, retries, errors. */
export class HandlesApiCore {
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly maxRetries: number;
  protected readonly timeoutMs: number;
  protected readonly maxRetryAfterSeconds: number;
  protected readonly fetchImpl: typeof fetch;
  protected readonly extraHeaders: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? envKey();
    if (!apiKey) {
      throw new Error("Handles API key missing: pass { apiKey } or set the HANDLES_API_KEY environment variable.");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 30;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("No fetch available: use Node 18+ or pass { fetch }.");
    this.fetchImpl = options.fetch ?? f.bind(globalThis);
    this.extraHeaders = options.headers ?? {};
  }

  /** Sends one request and returns the `{ data, meta }` envelope plus credit and rate-limit headers. */
  async requestRaw<T = unknown>(req: RawRequest, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = this.baseUrl + req.path + serializeQuery(req.query);
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };
    if (typeof window === "undefined") headers["User-Agent"] = `handlesapi-js/${VERSION}`;
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt<T>(url, { method: req.method, headers, body }, options);
      if (outcome.ok) return outcome.value;
      const err = outcome.error;
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      if (err instanceof HandlesApiError && err.retryAfter !== null && err.retryAfter > this.maxRetryAfterSeconds) throw err;
      await sleep(retryDelayMs(err, attempt), options.signal);
    }
  }

  private async attempt<T>(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string | undefined },
    options: RequestOptions,
  ): Promise<{ ok: true; value: ApiResponse<T> } | { ok: false; error: Failure }> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, { ...init, signal: ctrl.signal });
        text = await res.text();
      } catch (cause) {
        if (options.signal?.aborted) throw cause; // the caller cancelled: not a retryable failure
        return {
          ok: false,
          error: new HandlesApiConnectionError(
            timedOut ? `Request timed out after ${timeoutMs} ms` : `Network error: ${(cause as Error)?.message ?? cause}`,
            { cause, timedOut },
          ),
        };
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body, handled below */
      }
      if (res.ok && json && typeof json === "object" && "data" in json) {
        const env = json as { data: T; meta?: ApiMeta };
        const meta = env.meta ?? ({} as ApiMeta);
        return {
          ok: true,
          value: {
            data: env.data,
            meta,
            credits: {
              cost: num(res.headers.get("x-credits-cost")),
              remaining: num(res.headers.get("x-credits-remaining")),
              periodEnd: res.headers.get("x-credits-period-end"),
            },
            rateLimit: {
              limit: num(res.headers.get("x-ratelimit-limit")),
              remaining: num(res.headers.get("x-ratelimit-remaining")),
              reset: num(res.headers.get("x-ratelimit-reset")),
            },
            requestId: meta.request_id ?? res.headers.get("x-request-id"),
            headers: res.headers,
          },
        };
      }
      const e = (json as { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, string> } } | null)?.error;
      return {
        ok: false,
        error: new HandlesApiError({
          status: res.status,
          code: (e?.code ?? "unknown") as HandlesApiErrorCode,
          message: e?.message ?? (res.ok ? "Response was not a { data, meta } envelope" : text.slice(0, 200) || res.statusText),
          requestId: e?.request_id ?? res.headers.get("x-request-id"),
          details: e?.details ?? null,
          retryAfter: parseRetryAfter(res.headers.get("retry-after")),
          headers: res.headers,
        }),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
