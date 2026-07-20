/**
 * TransparentGuard Runtime — Local (No-Op) Trainer Backend
 *
 * The local backend is the default when no external compute service is configured.
 * It creates a job record, writes the SLSA provenance skeleton, and immediately
 * sets status to "pending" — awaiting a real trainer to be wired in.
 *
 * This is intentional: the full pipeline (dataset management, versioning,
 * artifact storage, signing, CLI) works end-to-end without a training backend.
 * When Modal, SageMaker, or Replicate is added tomorrow, only this file changes.
 *
 * Future: when onnxruntime-node is available, a local Python subprocess
 * (scikit-learn logistic regression → ONNX export) can be invoked here
 * for small datasets without any external service.
 */

import { randomBytes } from "crypto";
import type { ITrainerBackend, TrainingSpec, TrainingJob } from "../types.js";

export class LocalTrainerBackend implements ITrainerBackend {
  readonly id = "local" as const;
  readonly displayName = "Local (no-op — wire in a compute backend to train)";

  async train(spec: TrainingSpec, _datasetPath: string): Promise<TrainingJob> {
    const now = new Date().toISOString();
    return {
      job_id: `tg-job-local-${randomBytes(4).toString("hex")}`,
      classifier_name: spec.classifier_name,
      dataset_hash: spec.dataset_version,
      dataset_version: spec.dataset_version,
      backend: this.id,
      status: "pending",
      created_at: now,
      error:
        "Local backend does not perform training. " +
        "Set a compute backend (modal, sagemaker, replicate) and re-run. " +
        "The dataset, versioning, and artifact pipeline are fully ready.",
    };
  }

  async status(
    jobId: string,
    _backendJobId?: string,
  ): Promise<Pick<TrainingJob, "status" | "error" | "artifact_path" | "completed_at">> {
    return {
      status: "pending",
      error: "Local backend does not perform training. Configure a compute backend.",
    };
  }

  async cancel(_jobId: string, _backendJobId?: string): Promise<void> {
    // No-op — local jobs never start
  }
}

/** Singleton local backend instance. */
export const localBackend = new LocalTrainerBackend();
