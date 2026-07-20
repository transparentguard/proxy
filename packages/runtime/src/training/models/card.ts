/**
 * TransparentGuard Runtime — Hugging Face Model Card Generator
 *
 * Generates a model card following the Hugging Face Model Card specification.
 * The card is stored as model.card.json in every artifact directory.
 *
 * JSON format is used (not YAML) for programmatic access.
 * The card is compatible with the HF Hub model card schema and can be
 * converted to a README.md YAML front-matter card for HF Hub publishing.
 *
 * @see https://huggingface.co/docs/hub/model-cards
 */

import type { ModelCard, ModelManifest, DatasetVersion } from "../types.js";

const RUNTIME_VERSION = "0.1.1";

/**
 * Generate a model card for a trained classifier.
 */
export function generateModelCard(
  manifest: ModelManifest,
  datasetVersion: DatasetVersion,
): ModelCard {
  const labels = datasetVersion.labels;
  const metrics = manifest.metrics ?? {};

  return {
    model_name: manifest.classifier_name,
    description:
      `Custom text classifier for "${manifest.classifier_name}" trained with TransparentGuard. ` +
      `Detects the following classes: ${labels.join(", ")}.`,
    architecture: manifest.architecture,
    dataset_hash: manifest.dataset_hash,
    training_examples: datasetVersion.example_count,
    labels,
    metrics,
    created_at: manifest.created_at,
    tg_version: RUNTIME_VERSION,
    provenance_level: manifest.provenance ? "SLSA_L2" : "SLSA_L1",
    intended_use:
      "This model is intended for use as a custom classifier within the TransparentGuard " +
      "policy enforcement runtime. It evaluates text inputs and returns a classification " +
      "score used to enforce policy rules defined in a TPS policy file.",
    limitations:
      "Performance depends on the quality and quantity of labeled training examples. " +
      "Models trained on fewer than 200 examples per class may not generalize well. " +
      "Review the active learning queue regularly to address uncertain predictions.",
    license: "MIT",
  };
}

/**
 * Format a model card for terminal display.
 */
export function formatModelCard(card: ModelCard): string {
  const lines: string[] = [`\nModel Card — ${card.model_name}\n`];
  lines.push(`  Description  : ${card.description}`);
  lines.push(`  Architecture : ${card.architecture}`);
  lines.push(`  Labels       : ${card.labels.join(", ")}`);
  lines.push(`  Examples     : ${card.training_examples}`);
  lines.push(`  Provenance   : ${card.provenance_level}`);
  lines.push(`  TG Version   : ${card.tg_version}`);
  lines.push(`  Created      : ${card.created_at}`);

  if (Object.keys(card.metrics).length > 0) {
    lines.push("\n  Metrics");
    for (const [k, v] of Object.entries(card.metrics)) {
      lines.push(`    ${k.padEnd(16)} : ${typeof v === "number" ? v.toFixed(4) : v}`);
    }
  }

  lines.push(`\n  Intended use : ${card.intended_use}`);
  lines.push(`  Limitations  : ${card.limitations}`);
  lines.push(`  License      : ${card.license}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Convert a model card to Hugging Face README.md YAML front-matter format.
 * Useful for publishing to the HF Hub.
 */
export function toHuggingFaceReadme(card: ModelCard): string {
  const metricsYaml = Object.entries(card.metrics)
    .map(([k, v]) => `  - type: ${k}\n    value: ${v}`)
    .join("\n");

  return `---
language:
- en
license: ${card.license}
tags:
- text-classification
- transparentguard
- custom-classifier
model-index:
- name: ${card.model_name}
  results:
  - task:
      type: text-classification
    metrics:
${metricsYaml || "    []"}
---

# ${card.model_name}

${card.description}

## Intended Use

${card.intended_use}

## Training Details

- **Architecture:** ${card.architecture}
- **Training examples:** ${card.training_examples}
- **Labels:** ${card.labels.join(", ")}
- **Dataset hash:** \`${card.dataset_hash}\`
- **Provenance level:** ${card.provenance_level}
- **TG Runtime version:** ${card.tg_version}

## Limitations

${card.limitations}

## License

${card.license}
`;
}
