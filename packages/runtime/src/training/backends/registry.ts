/**
 * TransparentGuard Runtime — Backend Registry
 *
 * Discovers and returns the appropriate ITrainerBackend for a given backend ID.
 * New backends (Modal, SageMaker, Replicate, Vertex AI, custom) are registered
 * here by calling `registerBackend()` before the first training job is submitted.
 *
 * Default: the local no-op backend is always registered.
 * Additional backends are registered at application startup, typically by
 * reading environment variables for backend-specific credentials.
 *
 * Example (user code, once Modal SDK is available):
 *   import { registerBackend } from "@transparentguard/runtime/training";
 *   import { ModalTrainerBackend } from "@transparentguard/backend-modal";
 *   registerBackend(new ModalTrainerBackend({ token: process.env.MODAL_TOKEN }));
 */

import type { ITrainerBackend, BackendId } from "../types.js";
import { localBackend } from "./local.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const backends = new Map<BackendId, ITrainerBackend>();

// Always available
backends.set("local", localBackend);

/**
 * Register a compute backend.
 * Overwrites any existing registration for the same ID.
 */
export function registerBackend(backend: ITrainerBackend): void {
  backends.set(backend.id, backend);
}

/**
 * Retrieve a registered backend by ID.
 * Throws with a helpful message if the backend is not registered.
 */
export function getBackend(id: BackendId): ITrainerBackend {
  const b = backends.get(id);
  if (!b) {
    const available = [...backends.keys()].join(", ");
    throw new Error(
      `Trainer backend "${id}" is not registered. ` +
      `Available backends: ${available}. ` +
      `Import and register the backend before submitting a job.`,
    );
  }
  return b;
}

/**
 * List all registered backend IDs and display names.
 */
export function listBackends(): Array<{ id: BackendId; displayName: string }> {
  return [...backends.values()].map((b) => ({ id: b.id, displayName: b.displayName }));
}
