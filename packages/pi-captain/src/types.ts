export interface PathPolicy {
  path: string;
  mode?: "read" | "write" | "readwrite";
}

export interface SandboxPolicy {
  allowPaths?: PathPolicy[];
  blockNetwork?: boolean;
  allowCommands?: string[];
  blockCommands?: string[];
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: object;
}

export interface CaptainConfig {
  prompt: string;
  model?: string;
  cwd: string;
  tools?: string[];
  systemPrompt?: string;
  policy: SandboxPolicy;
  timeout: number;
  ipcSocketPath: string;
  childExtensionPath: string;
  toolDefs: ToolDefinition[];
}

// IPC protocol — child → parent

export interface ToolCallRequest {
  type: "tool_call";
  id: string;
  toolName: string;
  params: Record<string, unknown>;
}

// IPC protocol — parent → child

export interface ToolCallUpdate {
  type: "tool_update";
  id: string;
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

export interface ToolCallResult {
  type: "tool_result";
  id: string;
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError: boolean;
}

export interface ToolCallError {
  type: "tool_error";
  id: string;
  message: string;
}

export type ParentMessage = ToolCallUpdate | ToolCallResult | ToolCallError;
export type ChildMessage = ToolCallRequest;
export type IpcMessage = ParentMessage | ChildMessage;
