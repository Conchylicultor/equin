// The test's other thread: answers each handle it is sent with that thread's
// CPU clock, read from here.
import { readThreadCpuOf, type ThreadCpuHandle } from "../thread-cpu-clock";

declare const self: Worker;
self.onmessage = (e: MessageEvent<ThreadCpuHandle>) => {
  self.postMessage(readThreadCpuOf(e.data));
};
