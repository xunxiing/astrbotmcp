export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface RichToolResult {
  __richResult: true;
  value: unknown;
  extraContent?: Array<{
    type: "image";
    data: string;
    mimeType: string;
  }>;
}

export function richResult(
  value: unknown,
  extraContent: Array<{
    type: "image";
    data: string;
    mimeType: string;
  }> = [],
): RichToolResult {
  return {
    __richResult: true,
    value,
    extraContent,
  };
}

export function isRichResult(value: unknown): value is RichToolResult {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as RichToolResult).__richResult === true
  );
}

export function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: toJsonText(value),
      },
    ],
  };
}

export function toolResult(value: unknown) {
  if (!isRichResult(value)) {
    return jsonResult(value);
  }
  return {
    content: [
      {
        type: "text" as const,
        text: toJsonText(value.value),
      },
      ...(value.extraContent ?? []),
    ],
  };
}
