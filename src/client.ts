import { HandlesApiCore, type ApiResponse, type ClientOptions, type RequestOptions } from "./core.js";
import type { OperationMethods } from "./generated/methods.js";
import { operations, type OperationName, type OperationTypes, type PaginatedOperation } from "./generated/operations.js";

// Declaration merging: the typed endpoint methods are declared here and attached to the prototype below.
export interface HandlesApi extends OperationMethods {}

/**
 * Typed client for the Handles API (https://handlesapi.com/docs).
 *
 * There is one method per endpoint, named after its `operationId` in camelCase:
 * `GET /accounts/{platform}/{handle}` is `client.accountsCheck({ platform, handle })`.
 * Path, query and body parameters all go in the one `params` object.
 */
export class HandlesApi extends HandlesApiCore {
  constructor(options: ClientOptions = {}) {
    super(options);
  }

  /** Calls any endpoint by operation name. The generated methods are thin wrappers around this. */
  async operation<K extends OperationName>(
    name: K,
    params: OperationTypes[K]["params"],
    options?: RequestOptions,
  ): Promise<ApiResponse<OperationTypes[K]["data"]>> {
    const op = operations[name];
    const p = params as Record<string, unknown>;
    let path: string = op.path;
    for (const k of op.pathParams) {
      const v = p[k];
      if (v === undefined || v === null || v === "") throw new TypeError(`${name}: missing path parameter "${k}"`);
      path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
    const query: Record<string, unknown> = {};
    for (const k of op.queryParams) if (p[k] !== undefined) query[k] = p[k];
    const bodyParams: readonly string[] = op.bodyParams;
    let body: Record<string, unknown> | undefined;
    if (bodyParams.length > 0) {
      body = {};
      for (const k of bodyParams) if (p[k] !== undefined) body[k] = p[k];
    } else if (op.method === "POST") {
      body = {};
    }
    return this.requestRaw<OperationTypes[K]["data"]>({ method: op.method, path, query, body }, options);
  }

  /**
   * Follows `meta.page.next_cursor` and yields one response per page. Stops when the cursor is null,
   * which is the only reliable end of a result set, or after `maxPages`.
   *
   * ```ts
   * for await (const page of client.paginate("xUsersTweets", { handle: "nasa", limit: 100 }, { maxPages: 3 })) {
   *   console.log(page.data, page.credits.remaining);
   * }
   * ```
   */
  async *paginate<K extends PaginatedOperation>(
    name: K,
    params: OperationTypes[K]["params"],
    options: RequestOptions & { maxPages?: number } = {},
  ): AsyncGenerator<ApiResponse<OperationTypes[K]["data"]>, void, undefined> {
    const { maxPages = Infinity, ...requestOptions } = options;
    let cursor: string | undefined = (params as { cursor?: string }).cursor;
    for (let page = 0; page < maxPages; page++) {
      const res: ApiResponse<OperationTypes[K]["data"]> = await this.operation(
        name,
        { ...params, cursor } as OperationTypes[K]["params"],
        requestOptions,
      );
      yield res;
      const next = res.meta.page?.next_cursor ?? null;
      if (!next) return;
      cursor = next;
    }
  }
}

// Attach one prototype method per operation. The type side is declared by OperationMethods above.
for (const name of Object.keys(operations) as OperationName[]) {
  Object.defineProperty(HandlesApi.prototype, name, {
    value: function (this: HandlesApi, params: never, options?: RequestOptions) {
      return this.operation(name, params, options);
    },
    writable: true,
    configurable: true,
  });
}
