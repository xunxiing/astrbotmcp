export type CapabilityMode = "search" | "readonly" | "minimize" | "full";
export type LogView = "compact" | "raw";

export interface AppConfig {
  gatewayUrl: string;
  gatewayToken: string;
  gatewayTimeout: number;
  capabilityMode: CapabilityMode;
  enableSearchTools: boolean;
  logView: LogView;
  enableLogNoiseFiltering: boolean;
}

const CAPABILITY_MODES = new Set<CapabilityMode>([
  "search",
  "readonly",
  "minimize",
  "full",
]);

const LOG_VIEWS = new Set<LogView>(["compact", "raw"]);

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === null) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const value = env(name);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const gatewayToken = env("ASTRBOT_GATEWAY_TOKEN");
  if (!gatewayToken) {
    throw new Error("ASTRBOT_GATEWAY_TOKEN is required.");
  }

  const capabilityMode = (env("ASTRBOT_CAPABILITY_MODE") ?? "full") as CapabilityMode;
  if (!CAPABILITY_MODES.has(capabilityMode)) {
    throw new Error(
      `ASTRBOT_CAPABILITY_MODE must be one of ${Array.from(CAPABILITY_MODES).join(", ")}.`,
    );
  }

  const logView = (env("ASTRBOT_LOG_VIEW") ?? "compact") as LogView;
  if (!LOG_VIEWS.has(logView)) {
    throw new Error(`ASTRBOT_LOG_VIEW must be one of ${Array.from(LOG_VIEWS).join(", ")}.`);
  }

  return {
    gatewayUrl: (env("ASTRBOT_GATEWAY_URL") ?? "http://127.0.0.1:6324").replace(/\/+$/, ""),
    gatewayToken,
    gatewayTimeout: envNumber("ASTRBOT_GATEWAY_TIMEOUT", 30_000),
    capabilityMode,
    enableSearchTools: envBoolean("ASTRBOT_ENABLE_SEARCH_TOOLS", false),
    logView,
    enableLogNoiseFiltering: envBoolean("ASTRBOT_ENABLE_LOG_NOISE_FILTERING", true),
  };
}
