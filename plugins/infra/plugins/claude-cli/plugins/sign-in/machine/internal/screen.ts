import { Terminal } from "@xterm/headless";

// The screen a terminal program draws on, read back as text.
//
// `setup-token` is a full-screen terminal UI with no plain-text mode: without
// a terminal it holds everything back until it exits, and on an error it waits
// for Enter forever — silently. Under a pseudo-terminal it draws, but as a
// diff: it moves the cursor and skips the cells that already hold the right
// character, so its bytes are not its text. A terminal emulator replays them
// onto a grid, which is what a person would read.

export interface Screen {
  /** Draw what the program wrote; resolves once it is on the screen. */
  write(data: Uint8Array): Promise<void>;
  /** Resolves once everything written so far is on the screen. */
  drawn(): Promise<void>;
  /**
   * What the screen shows, scrollback included: one line per row (a row the
   * terminal wrapped joined to the one before), trailing blanks trimmed.
   */
  text(): string;
  dispose(): void;
}

export function createScreen(size: { cols: number; rows: number }): Screen {
  const term = new Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  let last: Promise<void> = Promise.resolve();
  return {
    write(data) {
      last = new Promise<void>((resolve) => term.write(data, resolve));
      return last;
    },
    drawn: () => last,
    text() {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text;
        else rows.push(text);
      }
      return rows.join("\n").trimEnd();
    },
    dispose: () => term.dispose(),
  };
}
