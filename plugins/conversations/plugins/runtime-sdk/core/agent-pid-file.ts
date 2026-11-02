// An agent's pid file: its pid on the first line — what the daemon registry's
// `readPidFile` reads — then the Claude account it signs in as. The file
// exists exactly while the agent runs, and an agent keeps its account until
// its process restarts, so the file is the one place every backend reads which
// account each running agent is on (`runtime-sdk.agent-processes`).

/** The pid file an agent writes once its socket listens. */
export function agentPidFileText(pid: number, account: string): string {
  return `${String(pid)}\n${account}\n`;
}

/**
 * The account a pid file names, or `null` for one written by an agent started
 * before pid files named it (temporary: such an agent counts on no account
 * until its process restarts).
 */
export function agentPidFileAccount(text: string): string | null {
  const account = text.split("\n")[1]?.trim() ?? "";
  return account === "" ? null : account;
}
