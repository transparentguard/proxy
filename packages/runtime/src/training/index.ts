/**
 * TransparentGuard Runtime — Training Module Barrel
 *
 * Re-exports all public training APIs. Consumed by:
 *   - packages/runtime/src/index.ts (main runtime barrel)
 *   - packages/cli/src/commands/* (via @transparentguard/runtime)
 */

// Core types
export type {
  LabeledExample,
  DatasetStats,
  DatasetVersion,
  DatasetManifest,
  TrainingSpec,
  TrainingJob,
  JobStatus,
  ModelManifest,
  ModelArtifact,
  ModelCard,
  ActiveLearningEntry,
  DriftReport,
  DriftWindowEntry,
  SLSAProvenance,
  ITrainerBackend,
  DataSource,
  BackendId,
  ModelArchitecture,
} from "./types.js";

// Dataset — store
export {
  tgDataDir,
  datasetDir,
  textId,
  fileHash,
  readExamples,
  readVersionedExamples,
  addExample,
  importJsonl,
  computeStats,
  exportJsonl,
  getManifest,
  listDatasets,
} from "./dataset/store.js";
export type { AddExampleOptions } from "./dataset/store.js";

// Dataset — validator
export {
  validateDataset,
  formatValidationReport,
} from "./dataset/validator.js";
export type {
  ValidationReport,
  ValidationFinding,
  ValidationSeverity,
  ValidationConfig,
} from "./dataset/validator.js";

// Dataset — versioning (aliased to avoid clash with model resolveVersion)
export {
  createSnapshot,
  listVersions,
  verifySnapshot,
  formatVersionList,
} from "./dataset/versioning.js";
export { resolveVersion as resolveDatasetVersion } from "./dataset/versioning.js";
export type { SnapshotResult } from "./dataset/versioning.js";

// Dataset — auto-labeler
export {
  registerAutoLabeler,
  autoLabel,
  autoLabelFromFile,
} from "./dataset/auto-labeler.js";
export type { AutoLabelResult } from "./dataset/auto-labeler.js";

// Dataset — drift
export {
  appendDriftEntry,
  readDriftWindow,
  checkDrift,
} from "./dataset/drift.js";

// Jobs — manager (cancelJob aliased to cancelTrainingJob to avoid name collision)
export {
  listJobs,
  getJob,
  submitJob,
  refreshJobStatus,
  formatJobList,
} from "./jobs/manager.js";
export { cancelJob as cancelTrainingJob } from "./jobs/manager.js";

// Jobs — manifest (SLSA)
export {
  buildProvenance,
  signProvenance,
  verifyProvenance,
  formatProvenance,
} from "./jobs/manifest.js";

// Backends — registry
export {
  registerBackend,
  getBackend,
  listBackends,
} from "./backends/registry.js";

// Backends — local
export { localBackend, LocalTrainerBackend } from "./backends/local.js";

// Models — store (resolveVersion aliased to avoid clash with dataset resolveVersion)
export {
  modelsBaseDir,
  modelDir,
  artifactDir,
  weightsHash,
  createArtifact,
  loadArtifact,
  updateManifest,
  setHead,
  listModelClassifiers,
  listArtifactVersions,
  formatModelList,
} from "./models/store.js";
export { resolveVersion as resolveModelVersion } from "./models/store.js";

// Models — loader (active learning + ONNX fallback chain)
export {
  appendActiveLearningEntry,
  readActiveLearningQueue,
  clearActiveLearningQueue,
  loadAndInfer,
} from "./models/loader.js";
export type { ModelLoadOptions } from "./models/loader.js";

// Models — signing
export {
  signArtifact,
  verifyArtifact,
} from "./models/signing.js";

// Models — card
export {
  generateModelCard,
  formatModelCard,
  toHuggingFaceReadme,
} from "./models/card.js";
