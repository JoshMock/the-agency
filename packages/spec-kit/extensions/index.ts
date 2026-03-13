import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const skills = [
  { name: "speckit-init", description: "Initialize the .specify/ workspace in the current repo" },
  { name: "speckit-specify", description: "Create or update the feature specification from a natural language feature description" },
  { name: "speckit-clarify", description: "Interactively resolve critical ambiguities in the feature specification" },
  { name: "speckit-plan", description: "Execute the implementation planning workflow using the plan template" },
  { name: "speckit-tasks", description: "Generate an actionable, dependency-ordered tasks.md for the feature" },
  { name: "speckit-taskstoissues", description: "Convert existing tasks into actionable GitHub issues" },
  { name: "speckit-checklist", description: "Generate a targeted checklist artifact for a specific quality domain" },
  { name: "speckit-analyze", description: "Analyze spec, plan, and tasks for consistency before implementation" },
  { name: "speckit-implement", description: "Execute the implementation plan by processing all tasks in tasks.md" },
  { name: "speckit-constitution", description: "Create or update the project constitution" },
];

function loadSkill(name: string): { content: string; skillPath: string } {
  const skillPath = join(__dirname, "..", "skills", name, "SKILL.md");
  const content = readFileSync(skillPath, "utf-8");
  return { content, skillPath };
}

export default function (pi: ExtensionAPI) {
  for (const skill of skills) {
    pi.registerCommand(skill.name, {
      description: skill.description,
      handler: async (args, ctx) => {
        const { content, skillPath } = loadSkill(skill.name);
        const expanded = content
          .replace(/SKILL_PATH/g, skillPath)
          .replace(/\$ARGUMENTS/g, args ?? "");
        ctx.sendUserMessage(expanded);
      },
    });
  }
}
