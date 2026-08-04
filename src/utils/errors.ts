import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class ComfyUIError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ComfyUIError";
  }

  toToolResult(): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: this.code,
            message: this.message,
            details: this.details,
          }),
        },
      ],
    };
  }
}

export class ConnectionError extends ComfyUIError {
  constructor(message: string) {
    super(message, "CONNECTION_ERROR");
    this.name = "ConnectionError";
  }
}

export class WorkflowExecutionError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "WORKFLOW_EXECUTION_ERROR", details);
    this.name = "WorkflowExecutionError";
  }
}

export class ValidationError extends ComfyUIError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class RegistryError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "REGISTRY_ERROR", details);
    this.name = "RegistryError";
  }
}

export class ModelError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "MODEL_ERROR", details);
    this.name = "ModelError";
  }
}

export class ProcessControlError extends ComfyUIError {
  /**
   * Set when the ComfyUI server IS reachable (answered /system_stats) but its
   * listening socket could not be mapped to a local PID — so callers surface a
   * precise diagnostic instead of a flat "no process" message (issue #449).
   */
  reachableButNoPid?: boolean;

  /**
   * Set when the server that answered could NOT be bound to the process we would
   * act on — the instance behind the port changed while it was being identified
   * (#776). Callers must surface the diagnostic and touch nothing: killing on an
   * identity we could not confirm is exactly the wrong-instance hazard.
   */
  identityAmbiguous?: boolean;

  constructor(message: string, details?: unknown) {
    super(message, "PROCESS_CONTROL_ERROR", details);
    this.name = "ProcessControlError";
  }
}

export class RemoteModeError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "REMOTE_MODE_ERROR", details);
    this.name = "RemoteModeError";
  }
}

export class NodeSnapshotError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_SNAPSHOT_ERROR", details);
    this.name = "NodeSnapshotError";
  }
}

export class NodeBisectError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_BISECT_ERROR", details);
    this.name = "NodeBisectError";
  }
}

export function errorToToolResult(err: unknown): CallToolResult {
  if (err instanceof ComfyUIError) return err.toToolResult();
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
