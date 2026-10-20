import { Markdown } from "@plugins/primitives/plugins/markdown/web";

// The two diagrams of the mockup this renderer was designed from
// (proto-1792499588-rr4kzl, which mocks this exhibit), as mermaid fences.
const SOURCE = `
\`\`\`mermaid
sequenceDiagram
  participant cli as CLI (claude)
  participant sdk as agent.ts (SDK process)
  participant be as Backend (event consumer)
  participant qr as Question relay (pending_questions)
  participant web as Web (conversation view)
  cli->>sdk: tool_use AskUserQuestion
  Note over sdk: canUseTool() parks — in-memory promise
  sdk->>be: permission_request
  be->>qr: holdQuestion()
  qr->>web: waitingFor = "question"
  Note over web: RelayQuestionCard + AnswerForm
  web->>qr: POST answer
  qr-->>be: onQuestionResolved
  be-->>sdk: socket { answer, requestId }
  sdk-->>cli: allow · updatedInput = answers
\`\`\`

\`\`\`mermaid
flowchart TB
  renderer["Diagram renderer<br>CodePreview.Renderer"]
  registry["Code preview registry<br>keyed by fence language"]:::key
  markdown["Markdown fences<br>mermaid fence"]
  codeblock["Page code block<br>Code · Preview · Split"]
  conversations["Conversations<br>assistant text"]
  files["File viewer<br>.md files"]
  pages["Pages<br>/diagram"]
  renderer -->|contributes| registry
  registry -->|useCodePreviewRenderer| markdown
  registry -->|useCodePreviewRenderer| codeblock
  markdown --> conversations
  markdown --> files
  codeblock --> pages
\`\`\`
`;

/**
 * The native sequence diagram and flowchart, each in a real markdown fence —
 * the frame, Preview / Code switch and stage a conversation shows them in.
 */
export default function NativeDiagramsExhibit() {
  return <Markdown>{SOURCE}</Markdown>;
}
