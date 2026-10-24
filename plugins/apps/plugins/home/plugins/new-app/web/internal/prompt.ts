/**
 * The prompt every New app agent starts from: deliberately minimal. Every app
 * starts as a prototype; how to make one (mint the folder, the authoring rules)
 * and how to build the app afterwards (the create-app skill) are the repo's own
 * instructions, which reach the agent without being restated here.
 */
export function newAppPrompt(description: string): string {
  return [
    "I want to build a new app.",
    "Create a prototype first.",
    "",
    "App description:",
    description.trim(),
  ].join("\n");
}
