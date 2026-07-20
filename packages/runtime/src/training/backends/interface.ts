/**
 * TransparentGuard Runtime — Trainer Backend Interface
 *
 * Re-exports ITrainerBackend from types.ts as the single source of truth.
 * All backend implementations (local, Modal, SageMaker, Replicate, Vertex AI, etc.)
 * must implement this interface.
 *
 * The interface is intentionally minimal:
 *   - train()  → submit a job, return a job record
 *   - status() → poll current status (non-throwing)
 *   - cancel() → cancel a running job (no-op if terminal)
 *
 * Everything else — dataset management, artifact storage, signing,
 * SLSA provenance, active learning, drift detection — lives in the
 * platform layer and is backend-agnostic.
 */

export type { ITrainerBackend, TrainingSpec, TrainingJob, JobStatus, BackendId } from "../types.js";
