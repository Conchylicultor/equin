import { expect, test } from "bun:test";
import { classifyFrameUrl } from "./classify-url";

test("a third-party page is foreign", () => {
  expect(classifyFrameUrl("https://www.youtube.com/embed/x")).toEqual({
    kind: "foreign",
    url: "https://www.youtube.com/embed/x",
  });
});

test("equin, content, loopback, IP and non-web addresses are refused", () => {
  for (const raw of [
    "http://equin.localhost:9000/tasks",
    "http://att-1.localhost:9000/",
    "http://sonata.att-1.localhost:9000/",
    "http://proto-1.content.localhost:9000/equin/api/prototypes/proto-1/index.html",
    "http://localhost:3000/",
    "http://127.0.0.1:9000/",
    "http://[::1]:9000/",
    "http://192.168.1.10/",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "not a url",
  ]) {
    expect(classifyFrameUrl(raw).kind).toBe("refused");
  }
});
