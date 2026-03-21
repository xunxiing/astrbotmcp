import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

import { AppConfig } from "./config.js";

type QueryValue = string | number | boolean | null | undefined;

export interface GatewaySseEvent {
  id?: string;
  event?: string;
  data: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>) {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeEnvelope(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === true && "data" in record) {
    return record.data;
  }
  return payload;
}

function parsePossibleJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseSseBlock(block: string): GatewaySseEvent | null {
  const lines = block.split(/\r?\n/);
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "id") {
      id = value;
      continue;
    }
    if (field === "event") {
      event = value;
      continue;
    }
    if (field === "data") {
      dataLines.push(value);
    }
  }

  if (!id && !event && dataLines.length === 0) {
    return null;
  }
  return {
    id,
    event,
    data: parsePossibleJson(dataLines.join("\n")),
  };
}

async function requestJson(
  url: URL,
  init: RequestInit,
  timeout: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await parseJson(response);
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload && "error" in payload
          ? String(((payload as Record<string, unknown>).error as Record<string, unknown>)?.message ?? response.statusText)
          : response.statusText;
      throw new ApiError(message, response.status, payload);
    }
    if (
      typeof payload === "object" &&
      payload &&
      "ok" in (payload as Record<string, unknown>) &&
      (payload as Record<string, unknown>).ok === false
    ) {
      const error = (payload as Record<string, unknown>).error as
        | Record<string, unknown>
        | undefined;
      throw new ApiError(String(error?.message ?? "Request failed"), response.status, payload);
    }
    return normalizeEnvelope(payload);
  } finally {
    clearTimeout(timer);
  }
}

async function requestBuffer(
  url: URL,
  init: RequestInit,
  timeout: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const payload = await parseJson(response);
      const message =
        typeof payload === "object" && payload && "error" in payload
          ? String(
              ((payload as Record<string, unknown>).error as Record<string, unknown>)
                ?.message ?? response.statusText,
            )
          : response.statusText;
      throw new ApiError(message, response.status, payload);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

export class GatewayClient {
  constructor(private readonly config: AppConfig) {}

  async request(
    method: string,
    path: string,
    options: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const url = buildUrl(this.config.gatewayUrl, path, options.query);
    return requestJson(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.gatewayToken}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      },
      this.config.gatewayTimeout,
    );
  }

  async stream(
    method: string,
    path: string,
    options: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<GatewaySseEvent[]> {
    const url = buildUrl(this.config.gatewayUrl, path, options.query);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.config.gatewayTimeout,
    );
    const events: GatewaySseEvent[] = [];
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.gatewayToken}`,
          Accept: "text/event-stream",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await parseJson(response);
        const message =
          typeof payload === "object" && payload && "error" in payload
            ? String(
                ((payload as Record<string, unknown>).error as Record<string, unknown>)
                  ?.message ?? response.statusText,
              )
            : response.statusText;
        throw new ApiError(message, response.status, payload);
      }
      if (!response.body) {
        return events;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        let separatorMatch = buffer.match(/\r?\n\r?\n/);
        while (separatorMatch?.index !== undefined) {
          const splitIndex = separatorMatch.index;
          const block = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + separatorMatch[0].length);
          const event = parseSseBlock(block);
          if (event) {
            events.push(event);
          }
          separatorMatch = buffer.match(/\r?\n\r?\n/);
        }

        if (done) {
          const finalEvent = parseSseBlock(buffer.trim());
          if (finalEvent) {
            events.push(finalEvent);
          }
          return events;
        }
      }
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
        return events;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async download(
    path: string,
    options: {
      query?: Record<string, QueryValue>;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<Buffer> {
    const url = buildUrl(this.config.gatewayUrl, path, options.query);
    return requestBuffer(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.gatewayToken}`,
          ...(options.headers ?? {}),
        },
      },
      options.timeoutMs ?? this.config.gatewayTimeout,
    );
  }

  async uploadFile(
    path: string,
    filePath: string,
    options: {
      query?: Record<string, QueryValue>;
      fieldName?: string;
      extraFields?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const url = buildUrl(this.config.gatewayUrl, path, options.query);
    const targetPath = resolvePath(filePath);
    const fileBuffer = await readFile(targetPath);
    const form = new FormData();
    form.append(
      options.fieldName ?? "file",
      new File([fileBuffer], basename(targetPath)),
    );
    for (const [key, value] of Object.entries(options.extraFields ?? {})) {
      form.append(key, value);
    }

    return requestJson(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.gatewayToken}`,
        },
        body: form,
      },
      this.config.gatewayTimeout,
    );
  }
}
