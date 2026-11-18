// The installer's dependencies, collected into infra/deps' registry through the
// `default` array: the pinned bashes install.sh's tests run under
// (`./equin deps install installer-test-bashes`; deps/testing reads them).
import { installerTestBashes } from "./internal/test-bashes";

export default [installerTestBashes];
