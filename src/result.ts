export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
