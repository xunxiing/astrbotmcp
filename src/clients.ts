import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

import { AppConfig } from "./config.js";

type QueryValue = string | number | boolean | null | undefined;

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
