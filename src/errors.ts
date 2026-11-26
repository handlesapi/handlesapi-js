import type { ApiErrorCode } from "./generated/types.js";

/** An error code the API did not document, or a failure that never reached the API (bad gateway page, HTML body). */
export type HandlesApiErrorCode = ApiErrorCode | "unknown";

const RETRYABLE_CODES = new Set<HandlesApiErrorCode>([
  "rate_limited",
  "live_limit_reached",
  "platform_unavailable",
  "upstream_timeout",
  "upstream_error",
  "service_unavailable",
  "internal_error",
]);

/** Thrown for every non-2xx answer. Branch on `code`, never on `message`. */
export class HandlesApiError extends Error {
  override readonly name = "HandlesApiError";
  /** HTTP status of the response. */
  readonly status: number;
  /** Stable machine-readable code from `error.code`. */
  readonly code: HandlesApiErrorCode;
  /** Quote this to support: it identifies your exact call. */
  readonly requestId: string | null;
  /** Field-level detail on `invalid_request`: parameter name to reason. */
  readonly details: Record<string, string> | null;
  /** Seconds to wait, from the `Retry-After` header, when the API sent one. */
  readonly retryAfter: number | null;
  /** Response headers, for `X-RateLimit-*` and friends. */
  readonly headers: Headers;

  constructor(init: {
    status: number;
    code: HandlesApiErrorCode;
    message: string;
    requestId: string | null;
    details: Record<string, string> | null;
    retryAfter: number | null;
    headers: Headers;
  }) {
    super(`${init.code} (HTTP ${init.status}): ${init.message}`);
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfter = init.retryAfter;
    this.headers = init.headers;
  }

  /** True for codes where waiting and retrying can succeed. `quota_exceeded` is not one of them. */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code) || (this.code === "unknown" && this.status >= 500);
  }
}

/** The request never produced an HTTP answer: DNS, TLS, reset, or the client's own timeout. */
export class HandlesApiConnectionError extends Error {
  override readonly name = "HandlesApiConnectionError";
  readonly timedOut: boolean;
  constructor(message: string, options: { cause?: unknown; timedOut?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.timedOut = options.timedOut ?? false;
  }
}
