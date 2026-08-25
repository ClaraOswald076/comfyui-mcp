/**
 * The Panel's typed `workflow_list` reconnect-readiness refusal (#1785).
 *
 * This is deliberately separate from the graph-mutation refusal. `workflow_list`
 * is a read-only probe, and the Panel's claim is that the probe itself did not
 * run because the live workflow identity was not ready yet.
 */

export interface WorkflowListReadinessRefusal {
  code: "reconnect-not-ready";
  ready: false;
  applied: false;
  stage: "pre-probe";
  retryable: true;
}

export const PANEL_WORKFLOW_LIST_READINESS_PROP = "cmcpWorkflowListReadiness";

const OWN = Object.prototype.hasOwnProperty;

function hasOwn(target: unknown, key: string): boolean {
  return !!target && typeof target === "object" && OWN.call(target, key);
}

/** Read only a complete, known Panel readiness refusal and rebuild its shape. */
export function readWorkflowListReadiness(
  value: unknown,
): WorkflowListReadinessRefusal | null {
  if (!value || typeof value !== "object") return null;
  const refusal = value as Record<string, unknown>;
  for (const key of ["code", "ready", "applied", "stage", "retryable"]) {
    if (!hasOwn(refusal, key)) return null;
  }
  if (
    refusal.code !== "reconnect-not-ready" ||
    refusal.ready !== false ||
    refusal.applied !== false ||
    refusal.stage !== "pre-probe" ||
    refusal.retryable !== true
  ) {
    return null;
  }
  return {
    code: "reconnect-not-ready",
    ready: false,
    applied: false,
    stage: "pre-probe",
    retryable: true,
  };
}

/** Attach the validated Panel claim to the Error rejected by the bridge. */
export function attachWorkflowListReadiness<E extends Error>(
  err: E,
  refusal: WorkflowListReadinessRefusal,
): E {
  try {
    Object.defineProperty(err, PANEL_WORKFLOW_LIST_READINESS_PROP, {
      value: refusal,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Decorating an already-failed command must never replace its error.
  }
  return err;
}

/** Read the bridge-owned readiness claim from an Error. */
export function workflowListReadinessOf(
  err: unknown,
): WorkflowListReadinessRefusal | null {
  if (!err || typeof err !== "object" || !hasOwn(err, PANEL_WORKFLOW_LIST_READINESS_PROP)) {
    return null;
  }
  return readWorkflowListReadiness(
    (err as Record<string, unknown>)[PANEL_WORKFLOW_LIST_READINESS_PROP],
  );
}

/** Preserve the claim if the bridge substitutes a friendlier Error. */
export function inheritWorkflowListReadiness<E extends Error>(from: unknown, to: E): E {
  const refusal = workflowListReadinessOf(from);
  return refusal ? attachWorkflowListReadiness(to, refusal) : to;
}
