import { describe, expect, test } from "bun:test";
import { readSetupTokenScreen } from "./cli-output";
import { createScreen } from "./screen";

// A real `setup-token` (bundled 2.1.310) under a 120×40 pseudo-terminal: its
// banner, then — after a callback whose code the token endpoint refused — its
// error and retry prompt. Drawn as a diff (absolute column moves over cells
// that already hold the right character), so the bytes alone do not read.
const SETUP_TOKEN_FAILED =
  "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004hWelcome\u001b[9Gto\u001b[12GClaude\u001b[19GCode\u001b[24Gv2.1.310\r\r\n..........................................................\r\r\n\r\r\n\u001b[6G*\u001b[46G\u2588\u2588\u2588\u2588\u2588\u2593\u2593\u2591\r\r\n\u001b[34G*\u001b[44G\u2588\u2588\u2588\u2593\u2591\u001b[54G\u2591\u2591\r\r\n\u001b[13G\u2591\u2591\u2591\u2591\u2591\u2591\u001b[43G\u2588\u2588\u2588\u2593\u2591\r\r\n\u001b[5G\u2591\u2591\u2591\u001b[11G\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u001b[43G\u2588\u2588\u2588\u2593\u2591\r\r\n\u001b[4G\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u001b[27G*\u001b[44G\u2588\u2588\u2593\u2591\u2591\u001b[55G\u2593\r\r\n\u001b[46G\u2591\u2593\u2593\u2588\u2588\u2588\u2593\u2593\u2591\r\r\n\u001b[2G*\u001b[36G\u2591\u2591\u2591\u2591\r\r\n\u001b[34G\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\r\r\n\u001b[32G\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\r\r\n\u001b[8G\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u001b[57G*\r\r\n\u001b[7G\u2588\u2588\u2584\u2588\u2588\u2588\u2588\u2588\u2584\u2588\u2588\u001b[42G*\r\r\n\u001b[8G\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u001b[23G*\r\r\n.......\u2588\u001b[10G\u2588\u001b[14G\u2588\u001b[16G\u2588..........................................\r\r\n\r\r\n\u001b[2GThis\u001b[7Gwill\u001b[12Gguide\u001b[18Gyou\u001b[22Gthrough\u001b[30Glong-lived\u001b[41G(1-year)\u001b[50Gauth\u001b[55Gtoken\u001b[61Gsetup\u001b[67Gfor\u001b[71Gyour\u001b[76GClaude\u001b[83Gaccount.\u001b[92GClaude\u001b[99Gsubscription\u001b[112Grequired.\r\r\n\r\r\n\u001b[2G\u2722\u001b[4GOpening\u001b[12Gbrowser\u001b[20Gto\u001b[23Gsign\u001b[28Gin\u2026\r\r\n\u001b[>0q\u001b[?u\u001b]7501;?\u0007\u001b[c\r\u001b[1C\u001b[1A\u2733\r\r\n\r\u001b[1C\u001b[1A\u2736\r\r\n\r\u001b[1C\u001b[1A\u273b\r\r\n\r\u001b[1C\u001b[1A\u273d\r\r\n\r\u001b[1C\u001b[1A\u273b\r\r\n\r\u001b[1C\u001b[1A\u2736\r\r\n\r\u001b[1C\u001b[1A\u2733\r\r\n\r\u001b[1C\u001b[1A\u2722\r\r\n\r\u001b[1C\u001b[1A\u00b7\r\r\n\r\u001b[1C\u001b[1A\u2722\r\r\n\r\u001b[1C\u001b[1A\u2733\r\r\n\r\u001b[1C\u001b[1A\u273b\r\r\n\r\u001b[1C\u001b[1A\u273d\r\r\n\r\u001b[1C\u001b[1A\u273b\r\r\n\r\u001b[1C\u001b[1A\u2736\r\r\n\r\u001b[1C\u001b[1A\u2733\r\r\n\r\u001b[1C\u001b[1A\u2722\r\r\n\r\u001b[1C\u001b[1AOAuth error: Request\u001b[23Gfailed with\u001b[35Gstatus\u001b[42Gcode\u001b[47G400\r\r\n\r\r\n\r\r\n\u001b[2GPress\u001b[8GEnter\u001b[14Gto\u001b[17Gretry.\r\r\n\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?1004l\u001b[>4m\u001b[<u\u001b[?2031l\u001b[?2004l\u001b(B\u000f\u001b[?1016l\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?25h\u001b7\u001b[r\u001b8\u001b]0;\u0007";

describe("createScreen", () => {
  test("reads what the program drew, not its bytes", async () => {
    const screen = createScreen({ cols: 120, rows: 40 });
    await screen.write(new TextEncoder().encode(SETUP_TOKEN_FAILED));
    const text = screen.text();
    expect(text).toContain("OAuth error: Request failed with status code 400");
    expect(text).toContain("Press Enter to retry.");
    expect(readSetupTokenScreen(text)).toEqual({
      kind: "stuck",
      error: "OAuth error: Request failed with status code 400",
    });
    screen.dispose();
  });
});
