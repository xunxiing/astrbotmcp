import test from "node:test";
import assert from "node:assert/strict";

import {
  compactInternalTool,
  compactInternalToolInvocation,
  compactInternalToolList,
} from "../src/tools.js";

test("compactInternalToolList keeps compact summaries by default", () => {
  const result = compactInternalToolList([
    {
      name: "gemini_image_generation",
      description: "generate image",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          aspect_ratio: { type: "string" },
        },
        required: ["prompt"],
      },
      active: true,
      type: "GeminiImageGenerationTool",
      origin: "plugin",
      origin_name: "astrbot_plugin_gemini_image_generation",
    },
  ]);

  assert.deepEqual(result, [
    {
      name: "gemini_image_generation",
      description: "generate image",
      active: true,
      origin: "plugin",
      origin_name: "astrbot_plugin_gemini_image_generation",
      type: "GeminiImageGenerationTool",
      parameter_keys: ["prompt", "aspect_ratio"],
      required: ["prompt"],
      parameter_count: 2,
    },
  ]);
});

test("compactInternalTool can include full parameter schema on demand", () => {
  const result = compactInternalTool(
    {
      name: "gemini_image_generation",
      description: "generate image",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
        },
        required: ["prompt"],
      },
      active: true,
      type: "GeminiImageGenerationTool",
      origin: "unknown",
      origin_name: "unknown",
    },
    { includeParameters: true },
  );

  assert.deepEqual(result, {
    name: "gemini_image_generation",
    description: "generate image",
    active: true,
    type: "GeminiImageGenerationTool",
    parameter_keys: ["prompt"],
    required: ["prompt"],
    parameter_count: 1,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
    },
  });
});

test("compactInternalToolInvocation keeps sync replies compact", () => {
  const result = compactInternalToolInvocation(
    {
      tool: {
        name: "md_doc_create",
        description: "create markdown doc",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
          },
          required: ["prompt"],
        },
        active: true,
        type: "MarkdownDocCreateTool",
      },
      conversation_id: "tool-mcp",
      message_id: "tool_123",
      unified_msg_origin: "webchat:FriendMessage:webchat!mcp!tool-mcp",
      results: [
        {
          text: "{\n  \"doc_id\": \"abc\"\n}",
        },
      ],
      emitted: {
        completed: false,
      },
    },
    {
      toolName: "md_doc_create",
      includeParameters: false,
      includeArguments: false,
      includeDebug: false,
    },
  );

  assert.deepEqual(result, {
    tool: {
      name: "md_doc_create",
      description: "create markdown doc",
      active: true,
      type: "MarkdownDocCreateTool",
      parameter_keys: ["prompt"],
      required: ["prompt"],
      parameter_count: 1,
    },
    tool_name: "md_doc_create",
    status: "finished",
    reply: "{\n  \"doc_id\": \"abc\"\n}",
    completed: false,
    conversation_id: "tool-mcp",
    message_id: "tool_123",
    unified_msg_origin: "webchat:FriendMessage:webchat!mcp!tool-mcp",
  });
});

test("compactInternalToolInvocation classifies background acceptance separately", () => {
  const result = compactInternalToolInvocation(
    {
      task_id: "tooltask_123",
      status: "running",
      execution_mode: "background",
      tool: {
        name: "gemini_image_generation",
        description: "generate image",
        active: true,
        type: "GeminiImageGenerationTool",
      },
      results: [
        {
          text: "[图像生成任务已启动]\n图片正在后台生成中，完成后会自动发送给用户。",
        },
      ],
      emitted: {
        completed: false,
      },
    },
    {
      toolName: "gemini_image_generation",
    },
  );

  assert.deepEqual(result, {
    tool: {
      name: "gemini_image_generation",
      description: "generate image",
      active: true,
      type: "GeminiImageGenerationTool",
    },
    tool_name: "gemini_image_generation",
    status: "running",
    task_id: "tooltask_123",
    execution_mode: "background",
    accepted_reply: "[图像生成任务已启动]\n图片正在后台生成中，完成后会自动发送给用户。",
    completed: false,
  });
});

test("compactInternalToolInvocation reads text from result content blocks", () => {
  const result = compactInternalToolInvocation(
    {
      task_id: "tooltask_456",
      status: "completed",
      results: [
        {
          content: [
            {
              type: "text",
              text: "图片正在生成，请稍等片刻。",
            },
          ],
        },
      ],
      emitted: {
        completed: true,
      },
    },
    {},
  );

  assert.deepEqual(result, {
    status: "completed",
    task_id: "tooltask_456",
    reply: "图片正在生成，请稍等片刻。",
    completed: true,
  });
});

test("compactInternalToolInvocation suppresses acceptance text after background completion", () => {
  const result = compactInternalToolInvocation(
    {
      tool_name: "gemini_image_generation",
      task_id: "tooltask_789",
      status: "completed",
      execution_mode: "background",
      result_text: "[图像生成任务已启动]\n图片正在后台生成中，完成后会自动发送给用户。",
      emitted: {
        completed: true,
        message_parts: [
          {
            type: "image",
            download_url: "http://127.0.0.1:6324/attachments/att_1/download",
          },
        ],
      },
    },
    {},
  );

  assert.deepEqual(result, {
    tool_name: "gemini_image_generation",
    status: "completed",
    task_id: "tooltask_789",
    execution_mode: "background",
    message_parts: [
      {
        type: "image",
        download_url: "http://127.0.0.1:6324/attachments/att_1/download",
      },
    ],
    completed: true,
  });
});

test("compactInternalToolInvocation can include parameters and arguments when requested", () => {
  const result = compactInternalToolInvocation(
    {
      tool: {
        name: "gemini_image_generation",
        description: "generate image",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
          },
          required: ["prompt"],
        },
        active: true,
        type: "GeminiImageGenerationTool",
      },
      arguments: {
        prompt: "test",
      },
      debug: {
        arguments: [{ path: "arguments.prompt", preview: "test" }],
      },
      emitted: {
        text: "done",
        completed: true,
      },
    },
    {
      toolName: "gemini_image_generation",
      includeParameters: true,
      includeArguments: true,
      includeDebug: true,
    },
  );

  assert.deepEqual(result, {
    tool: {
      name: "gemini_image_generation",
      description: "generate image",
      active: true,
      type: "GeminiImageGenerationTool",
      parameter_keys: ["prompt"],
      required: ["prompt"],
      parameter_count: 1,
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
        },
        required: ["prompt"],
      },
    },
    tool_name: "gemini_image_generation",
    status: "completed",
    reply: "done",
    completed: true,
    arguments: {
      prompt: "test",
    },
    debug: {
      arguments: [{ path: "arguments.prompt", preview: "test" }],
    },
  });
});
