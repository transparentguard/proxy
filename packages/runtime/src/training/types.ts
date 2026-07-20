/**
 * TransparentGuard Runtime — Custom Classifier Training: Core Types
 *
 * Open standard interfaces for the full training pipeline:
 * dataset management, job lifecycle, model artifacts, active learning,
 * and drift detection. Compute-backend-agnostic by design.
 *
 * Open standards used:
 *   - Dataset storage schema: Arrow-compatible field types (JSONL on disk)
 *   - Model interchange: ONNX (write-once, run anywhere)
 *   - Job provenance: SLSA L2-compatible manifest structure
 *   - Model metadata: Hugging Face Model Card specification
 *   - Signing: Cosign-compatible detached signature envelope
 *   - Observability: OpenTelemetry-tagged job attributes
 */

// ---------------------------------------------------------------------------
// Primitive enumerations
// ---------------------------------------------------------------------------

/** Source of a labeled training example. */
export type DataSource = "human" | "auto" | "active-learning";

/** Compute backend identifier. Extensible — any string is valid. */
export type BackendId = "local" | "modal" | "sagemaker" | "replicate" | "vertex" | string;

/** Training job lifecycle states. */
export type JobStatus = "pending" | "queued" | "running" | "complete" | "failed" | "cancelled";

/** Model architecture families. Drives training config and inference path. */
export type ModelArchitecture =
  | "distilbert-classifier"
  | "bert-classifier"
  | "logistic-regression"
  | "svm"
  | "onnx-custom"
  | string;

// ---------------------------------------------------------------------------
// Dataset — labeled examples
// ---------------------------------------------------------------------------

/**
 * A single labeled training example.
 * Field layout is Arrow-schema-compatible for direct Parquet interop.
 *
 * `id` is the SHA-256 of `text` — content-addressed, deduplicate-safe.
 * `confidence` supports soft labels (0.0–1.0). Examples with confidence
 * between 0.35 and 0.65 are automatically flagged for the active learning queue.
 * `rationale` stores chain-of-thought annotation — enables knowledge distillation.
 */
export interface LabeledExample {
  /** SHA-256 hex of `text`. Content-addressed — duplicate texts share an id. */
  id: string;
  /** Raw input text to classify. */
  text: string;
  /** Label string — multi-class, not constrained to binary. */
  label: string;
  /** Soft label confidence [0.0, 1.0]. Default 1.0 for hard labels. */
  confidence: number;
  /** Chain-of-thought rationale for this label. Enables distillation. */
  rationale?: string;
  /** How this label was produced. */
  source: DataSource;
  /** Who labeled it (user ID, model ID, or "tg-auto"). */
  annotator?: string;
  /** ISO 8601 timestamp of when the label was assigned. */
  labeled_at: string;
  /** Arbitrary extensible metadata. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dataset — statistics and versioning
// ---------------------------------------------------------------------------

/** Per-dataset label distribution and quality statistics. */
export interface DatasetStats {
  /** Total number of examples. */
  total: number;
  /** Count per label string. */
  label_distribution: Record<string, number>;
  /** Average whitespace-tokenized length across all examples. */
  avg_token_length: number;
  /**
   * Balance score [0.0, 1.0]. 1.0 = perfectly balanced across labels.
   * Computed as min(counts) / max(counts).
   */
  balance_score: number;
  /** Number of examples with confidence in [0.35, 0.65] — active learning candidates. */
  uncertain_count: number;
  /** Number of duplicate texts detected (same `id`). */
  duplicate_count: number;
  /** Vocabulary size (unique whitespace-tokenized tokens, case-folded). */
  vocab_size: number;
}

/**
 * An immutable, content-addressed snapshot of a dataset at a point in time.
 * `hash` is the SHA-256 of the JSONL file contents at snapshot time.
 * Snapshots are append-only — existing versions are never modified.
 */
export interface DatasetVersion {
  /** Monotonic version string: "v1", "v2", … */
  version: string;
  /** SHA-256 hex of the JSONL snapshot file. Content-addressed. */
  hash: string;
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** Number of examples in this snapshot. */
  example_count: number;
  /** All unique label strings present in this snapshot. */
  labels: string[];
  /** Statistics computed at snapshot time. */
  stats: DatasetStats;
}

/**
 * Top-level dataset manifest. Stored as `manifest.json` in the dataset directory.
 * Tracks all immutable versions and the HEAD pointer.
 */
export interface DatasetManifest {
  /** Classifier name this dataset trains. */
  classifier_name: string;
  /** ISO 8601 timestamp of first creation. */
  created_at: string;
  /** ISO 8601 timestamp of most recent mutation. */
  updated_at: string;
  /** Current HEAD version string (e.g. "v3"). Points to latest snapshot. */
  head: string;
  /** All immutable version snapshots, oldest first. */
  versions: DatasetVersion[];
}

// ---------------------------------------------------------------------------
// Training jobs
// ---------------------------------------------------------------------------

/**
 * Input specification for a training job.
 * Passed to `ITrainerBackend.train()`.
 */
export interface TrainingSpec {
  /** Classifier name to train. Must have a dataset with at least 20 examples. */
  classifier_name: string;
  /**
   * Dataset version to train on. Use "HEAD" for the latest snapshot.
   * A specific hash pins the training run for reproducibility.
   */
  dataset_version: string;
  /** Compute backend to use. */
  backend: BackendId;
  /** Model architecture. Defaults to "distilbert-classifier". */
  architecture?: ModelArchitecture;
  /** Backend-specific hyperparameters. */
  hyperparameters?: Record<string, unknown>;
  /** Arbitrary tags attached to the job for filtering and SLSA provenance. */
  tags?: Record<string, string>;
}

/**
 * A training job record. Persisted as an NDJSON event in ~/.tg/jobs/jobs.ndjson.
 * The status field follows a state machine: pending → queued → running → complete|failed|cancelled.
 */
export interface TrainingJob {
  /** Unique job identifier. Format: tg-job-<8 hex chars>. */
  job_id: string;
  /** Classifier name being trained. */
  classifier_name: string;
  /** SHA-256 of the dataset snapshot used. */
  dataset_hash: string;
  /** Dataset version string (e.g. "v2"). */
  dataset_version: string;
  /** Compute backend used. */
  backend: BackendId;
  /** Current job lifecycle status. */
  status: JobStatus;
  /** ISO 8601 timestamp of job creation. */
  created_at: string;
  /** ISO 8601 timestamp of job start (set when status → running). */
  started_at?: string;
  /** ISO 8601 timestamp of job completion (set when status → complete|failed|cancelled). */
  completed_at?: string;
  /** Error message if status === "failed". */
  error?: string;
  /** Filesystem path to the model artifact directory on successful completion. */
  artifact_path?: string;
  /** Backend-native job ID for polling/cancellation. */
  backend_job_id?: string;
}

// ---------------------------------------------------------------------------
// SLSA provenance manifest
// ---------------------------------------------------------------------------

/**
 * SLSA L2-compatible provenance document.
 * Generated for every training job on completion.
 * Signed with ECDSA-P256 (same key pair as evaluation receipts).
 *
 * @see https://slsa.dev/spec/v1.0/provenance
 */
export interface SLSAProvenance {
  /** SLSA build type URI. */
  build_type: "https://transparentguard.dev/slsa/training/v1";
  /** Provenance compliance level. */
  provenance_level: "SLSA_L1" | "SLSA_L2";
  /** Subject: the model artifact being attested. */
  subject: {
    name: string;
    digest: { sha256: string };
  };
  /** Build definition. */
  build_definition: {
    classifier_name: string;
    dataset_hash: string;
    dataset_version: string;
    backend: BackendId;
    architecture: string;
    hyperparameters: Record<string, unknown>;
    tags: Record<string, string>;
  };
  /** Run details. */
  run_details: {
    job_id: string;
    started_at: string;
    completed_at: string;
    runtime_version: string;
  };
  /** ISO 8601 timestamp of provenance document creation. */
  generated_at: string;
  /** ECDSA-P256 signature over the canonical JSON of the above fields. */
  signature?: string;
}

// ---------------------------------------------------------------------------
// Model artifacts
// ---------------------------------------------------------------------------

/**
 * Metadata manifest for a trained model artifact.
 * Stored as `manifest.json` alongside the model weights.
 *
 * `hash` is the SHA-256 of the ONNX weights file when present,
 * or "pending" when the artifact is registered without weights.
 */
export interface ModelManifest {
  /** Classifier name this model implements. */
  classifier_name: string;
  /** Artifact version string: "v1", "v2", … */
  version: string;
  /**
   * SHA-256 hex of model.onnx (if weights present) or "pending".
   * Content-addressed — enables integrity verification at load time.
   */
  hash: string;
  /** Training job that produced this model. */
  training_job_id: string;
  /** Dataset snapshot used for training. */
  dataset_hash: string;
  /** Dataset version string. */
  dataset_version: string;
  /** Compute backend that performed training. */
  backend: BackendId;
  /** Model architecture. */
  architecture: ModelArchitecture;
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** Evaluation metrics from the training run (accuracy, f1, etc.). */
  metrics?: Record<string, number>;
  /** Whether this artifact has a Cosign-compatible detached signature. */
  signed: boolean;
  /** Path to detached signature file relative to artifact_dir. */
  signature_path?: string;
  /** SLSA provenance document embedded at artifact creation time. */
  provenance?: SLSAProvenance;
}

/**
 * A resolved model artifact — manifest + filesystem paths.
 * Returned by `ModelStore.load()`.
 */
export interface ModelArtifact {
  /** Parsed manifest. */
  manifest: ModelManifest;
  /** Absolute path to the artifact directory on disk. */
  artifact_dir: string;
  /** Absolute path to model.onnx, or undefined if weights are not yet present. */
  weights_path?: string;
  /** Absolute path to model.card.json. */
  card_path: string;
}

// ---------------------------------------------------------------------------
// Hugging Face Model Card
// ---------------------------------------------------------------------------

/**
 * Model card following the Hugging Face Model Card specification.
 * @see https://huggingface.co/docs/hub/model-cards
 */
export interface ModelCard {
  /** Model name / classifier name. */
  model_name: string;
  /** One-line description of what the classifier detects. */
  description: string;
  /** Model architecture. */
  architecture: ModelArchitecture;
  /** Training dataset version hash. */
  dataset_hash: string;
  /** Number of training examples used. */
  training_examples: number;
  /** Label classes the model was trained on. */
  labels: string[];
  /** Evaluation metrics. */
  metrics: Record<string, number>;
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** TransparentGuard runtime version used for training orchestration. */
  tg_version: string;
  /** SLSA provenance level. */
  provenance_level: string;
  /** Intended use cases. */
  intended_use: string;
  /** Known limitations. */
  limitations: string;
  /** License identifier. */
  license: string;
}

// ---------------------------------------------------------------------------
// Active learning
// ---------------------------------------------------------------------------

/**
 * An inference result that the model was uncertain about.
 * Queued for human review and re-labeling.
 * Entries with confidence in [0.35, 0.65] are flagged automatically.
 */
export interface ActiveLearningEntry {
  /** SHA-256 of the input text. */
  id: string;
  /** Raw input text. */
  text: string;
  /** Model's raw confidence score. */
  score: number;
  /** Classifier name that flagged this entry. */
  classifier_name: string;
  /** ISO 8601 timestamp when the entry was flagged. */
  flagged_at: string;
  /** The label the model predicted (before uncertainty flagging). */
  predicted_label: string;
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Result of comparing the live inference distribution against the training distribution.
 * KL divergence is used as the divergence measure.
 * A report with `is_drifted: true` triggers a retraining recommendation.
 */
export interface DriftReport {
  /** Classifier name. */
  classifier_name: string;
  /** ISO 8601 timestamp of when drift was checked. */
  checked_at: string;
  /** KL divergence between training and live distributions. */
  divergence: number;
  /** Divergence threshold above which drift is declared. Default: 0.1. */
  threshold: number;
  /** True when divergence exceeds the threshold. */
  is_drifted: boolean;
  /** Label score distribution from the training dataset. */
  training_distribution: Record<string, number>;
  /** Label score distribution from the current inference window. */
  current_distribution: Record<string, number>;
  /** Human-readable recommendation (e.g. "Retrain recommended"). */
  recommendation?: string;
}

/**
 * Rolling window of inference scores used for drift detection.
 * Stored as `drift-window.ndjson` in the model artifact directory.
 */
export interface DriftWindowEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Classifier score for this inference. */
  score: number;
  /** Label returned by the model. */
  label: string;
  /** Source text SHA-256 (not the text itself — privacy-preserving). */
  text_id: string;
}

// ---------------------------------------------------------------------------
// Trainer backend interface
// ---------------------------------------------------------------------------

/**
 * The contract every compute backend must implement.
 * Swap Modal for SageMaker for Replicate by implementing this interface.
 * The rest of the training pipeline — dataset management, artifact storage,
 * signing, CLI — stays completely unchanged.
 */
export interface ITrainerBackend {
  /** Unique backend identifier. */
  readonly id: BackendId;
  /** Human-readable backend name for display. */
  readonly displayName: string;
  /**
   * Submit a training job. Returns a job record with status "queued" or "running".
   * Must be idempotent when called with the same spec.
   */
  train(spec: TrainingSpec, datasetPath: string): Promise<TrainingJob>;
  /**
   * Poll current status of a backend job.
   * Must not throw — return { status: "failed", error: msg } instead.
   */
  status(jobId: string, backendJobId?: string): Promise<Pick<TrainingJob, "status" | "error" | "artifact_path" | "completed_at">>;
  /**
   * Cancel a running or queued job.
   * No-op if the job is already complete or failed.
   */
  cancel(jobId: string, backendJobId?: string): Promise<void>;
}
