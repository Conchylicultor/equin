import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { SkillsGraph } from "./components/skills-graph";

export default {
  description:
    "The story's skills graph: <SkillsGraph> draws the author's skills as a program — AGENTS.md as main(), the everyday skills (complete a task, answer a question, fix a bug, write tests first) funnelling into the meta skills (self-improvement, meta-fix, think a level higher, update skill, write a skill) in the highlight colour — with one run of execution travelling down it while on screen, and each skill's file and purpose on hover.",
  contributions: [],
} satisfies PluginDefinition;
