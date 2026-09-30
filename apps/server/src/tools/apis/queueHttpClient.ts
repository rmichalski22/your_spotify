export type RequestPriority = "normal" | "high";

interface HttpClientRequestConfig {
  method: string;
  url: string;
  data?: any;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  priority?: RequestPriority;
  retry429MaxAttempts?: number;
}

interface HttpClientResponse<T> {
  status: number;
  statusText: string;
  data: T;
}

interface QueueItem<T = any> {
  config: HttpClientRequestConfig;
  resolve: (value: HttpClientResponse<T>) => void;
  reject: (reason?: unknown) => void;
  retry429AttemptCount: number;
}

interface QueueState {
  highPriorityQueue: QueueItem<any>[];
  normalPriorityQueue: QueueItem<any>[];
  isProcessingQueue: boolean;
  requestTimes: number[];
  cooldownUntil: number;
  maxRequests: number;
  nextTimer: ReturnType<typeof setTimeout> | null;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly body: string;

  constructor(options: { status: number; statusText: string; body: string }) {
    super(
      `HTTP error! status: ${options.status}, statusText: ${options.statusText}, body: ${options.body}`,
    );
    this.status = options.status;
    this.statusText = options.statusText;
    this.body = options.body;
  }
}

const DEFAULT_RETRY_429_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const RATE_WINDOW_MS = 30_000;

function createQueueState(): QueueState {
  return {
    highPriorityQueue: [],
    normalPriorityQueue: [],
    isProcessingQueue: false,
    requestTimes: [],
    cooldownUntil: 0,
    maxRequests: 0,
    nextTimer: null,
  };
}

export class QueuedHttpClientFactory {
  private readonly queueState: QueueState = createQueueState();

  constructor(
    private readonly options: {
      baseURL: string;
      headers: Record<string, string>;
      maxRequestsPerWindow?: number;
    },
  ) {
    this.queueState.maxRequests = options.maxRequestsPerWindow ?? 0;
  }

  createClient(headers: Record<string, string>) {
    const mergedHeaders = { ...this.options.headers, ...headers };
    return new QueuedHttpClient(
      this.options.baseURL,
      mergedHeaders,
      this.queueState,
    );
  }
}

export class QueuedHttpClient {
  constructor(
    private readonly baseURL: string,
    private readonly headers: Record<string, string>,
    private readonly queueState: QueueState = createQueueState(),
  ) {}

  request<T = any>(
    config: HttpClientRequestConfig,
  ): Promise<HttpClientResponse<T>> {
    return new Promise<HttpClientResponse<T>>((resolve, reject) => {
      const queueItem: QueueItem<T> = {
        config: {
          ...config,
          headers: { ...this.headers, ...config.headers },
          url: config.url.startsWith("http")
            ? config.url
            : this.baseURL + config.url,
        },
        resolve,
        reject,
        retry429AttemptCount: 0,
      };

      this.enqueue(queueItem);

      this.processQueue();
    });
  }

  get<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "get", url });
  }

  delete<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "delete", url });
  }

  head<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "head", url });
  }

  options<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "options", url });
  }

  post<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "post", url });
  }

  put<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "put", url });
  }

  patch<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "patch", url });
  }

  private processQueue() {
    if (this.queueState.isProcessingQueue) {
      return;
    }

    if (this.queueState.nextTimer) {
      clearTimeout(this.queueState.nextTimer);
      this.queueState.nextTimer = null;
    }
    const next =
      this.queueState.highPriorityQueue[0] ??
      this.queueState.normalPriorityQueue[0];
    if (!next) {
      return;
    }

    const waitMs = this.getRateLimitWait(next.config.priority === "high");
    if (waitMs > 0) {
      this.queueState.nextTimer = setTimeout(() => this.processQueue(), waitMs);
      return;
    }

    this.dequeueNext();

    this.queueState.isProcessingQueue = true;

    this.execute(next)
      .catch((error) => {
        next.reject(error);
      })
      .finally(() => {
        this.queueState.isProcessingQueue = false;
        this.processQueue();
      });
  }

  private async execute<T = any>(queueItem: QueueItem<T>) {
    const url = new URL(queueItem.config.url);

    if (queueItem.config.params) {
      Object.entries(queueItem.config.params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const payload: RequestInit = {
      method: queueItem.config.method,
      headers: queueItem.config.headers,
      body: queueItem.config.data
        ? JSON.stringify(queueItem.config.data)
        : undefined,
      credentials: "include",
    };

    // Count attempts before sending so concurrent clients share the same rolling window.
    if (this.queueState.maxRequests > 0) {
      this.queueState.requestTimes.push(Date.now());
    }
    const response = await fetch(url, payload);

    if (!response.ok) {
      const text = await response.text();

      if (response.status !== 429) {
        throw new HttpError({
          status: response.status,
          statusText: response.statusText,
          body: text,
        });
      }

      const maxAttempts =
        queueItem.config.retry429MaxAttempts ?? DEFAULT_RETRY_429_MAX_ATTEMPTS;

      // Development-mode quota exhaustion has no documented reset time. Retrying
      // it would only spend more quota and can keep the user locked out.
      if (this.isQuotaExceeded(text)) {
        throw new HttpError({
          status: response.status,
          statusText: response.statusText,
          body: text,
        });
      }

      const retryAfterMs = this.parseRetryAfterHeader(response);
      this.queueState.cooldownUntil = Math.max(
        this.queueState.cooldownUntil,
        Date.now() + retryAfterMs,
      );
      if (this.queueState.maxRequests > 1) {
        this.queueState.maxRequests = Math.max(
          1,
          Math.floor(this.queueState.maxRequests / 2),
        );
      }

      if (queueItem.retry429AttemptCount >= maxAttempts) {
        throw new HttpError({
          status: response.status,
          statusText: response.statusText,
          body: text,
        });
      }

      queueItem.retry429AttemptCount += 1;
      this.requeue(queueItem);
      return;
    }

    const data = (await response.json()) as T;
    queueItem.resolve({
      data,
      status: response.status,
      statusText: response.statusText,
    });
  }

  private requeue(queueItem: QueueItem<any>) {
    if (queueItem.config.priority === "high") {
      this.queueState.highPriorityQueue.unshift(queueItem);
      return;
    }
    this.queueState.normalPriorityQueue.unshift(queueItem);
  }

  private enqueue(queueItem: QueueItem<any>) {
    if (queueItem.config.priority === "high") {
      this.queueState.highPriorityQueue.push(queueItem);
      return;
    }

    this.queueState.normalPriorityQueue.push(queueItem);
  }

  private dequeueNext() {
    return (
      this.queueState.highPriorityQueue.shift() ??
      this.queueState.normalPriorityQueue.shift()
    );
  }

  private parseRetryAfterHeader(response: Response) {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    const retryAfterValue = Array.isArray(retryAfter)
      ? retryAfter[0]
      : retryAfter;

    const retryAfterAsNumber = Number(retryAfterValue);
    if (!Number.isNaN(retryAfterAsNumber)) {
      return Math.max(0, retryAfterAsNumber * 1000);
    }

    const retryAtTimestamp = Date.parse(retryAfterValue);
    if (Number.isNaN(retryAtTimestamp)) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    return Math.max(0, retryAtTimestamp - Date.now());
  }

  private isQuotaExceeded(body: string) {
    try {
      return JSON.parse(body)?.error?.reason === "QUOTA_EXCEEDED";
    } catch {
      return false;
    }
  }

  private getRateLimitWait(highPriority: boolean) {
    const now = Date.now();
    this.queueState.requestTimes = this.queueState.requestTimes.filter(
      (time) => time > now - RATE_WINDOW_MS,
    );
    const max = this.queueState.maxRequests;
    // Keep two slots available for interactive requests, including login.
    const budget = highPriority ? max : Math.max(1, max - 2);
    const oldest = this.queueState.requestTimes[0];
    const rateWait =
      max > 0 &&
      this.queueState.requestTimes.length >= budget &&
      oldest !== undefined
        ? oldest + RATE_WINDOW_MS - now + 1
        : 0;
    return Math.max(0, this.queueState.cooldownUntil - now, rateWait);
  }
}
