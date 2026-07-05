type FileClassificationRecord = any;

export function buildHoverMarkdown(filePath: string, record: FileClassificationRecord): string {
  const lines: string[] = [
    "### Corrdex",
    `**File:** \`${normalizePath(filePath)}\``,
    `**Primary Type:** \`${record.primaryType}\` (${formatPercent(record.confidence)})`,
  ];

  if (record.behaviors && record.behaviors.length > 0) {
    lines.push(`**Behaviors:** ${record.behaviors.map((behavior: any) => `\`${behavior.type}\` (${formatPercent(behavior.confidence)})`).join(", ")}`);
  } else {
    lines.push("**Behaviors:** none");
  }

  if ((record.architecturalRoles ?? []).length > 0) {
    lines.push(`**Architectural Roles:** ${record.architecturalRoles!.map((role: any) => `\`${role.type}\` (${formatPercent(role.confidence)})`).join(", ")}`);
  } else {
    lines.push("**Architectural Roles:** none");
  }

  if (record.dependencyProfile) {
    lines.push(`**Dependencies:** ${record.dependencyProfile.internal?.length ?? 0} internal, ${record.dependencyProfile.external?.length ?? 0} external`);
  }

  if (record.architecturalFindings && record.architecturalFindings.length > 0) {
    lines.push("");
    lines.push("**Findings**");
    for (const finding of record.architecturalFindings.slice(0, 5)) {
      lines.push(`- \`${finding.type}\` (${finding.severity}, ${formatPercent(finding.confidence)})`);
    }
  }

  return lines.join("\n");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
