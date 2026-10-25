import { describe, expect, test } from "bun:test";
import { parseSshPublicKey } from "./ssh-public-key";
import { InvalidSshKeyError } from "./ssh-key-error";

// Fixed vectors, NOT generated at test time: the whole point is proving our
// fingerprint equals what `ssh-keygen -lf` printed for these exact lines, so
// the expected value has to be the one a real ssh-keygen produced.
//
//   ssh-keygen -t ed25519 -f /tmp/vk -N "" -C equin-deploy-srv-test
//   ssh-keygen -lf /tmp/vk.pub
const ED25519_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILLeoWQaAHi4URNvoFUp+SXZWcAaZ1yjOFf+mIOTdsJa equin-deploy-srv-test";
const ED25519_FINGERPRINT = "SHA256:zHO/2ErzMdugLn6l/AGDHZQ9Iscrg4JaKEEGvKhks0U";

// An RSA key too — the parser validates the blob structurally, so key types it
// has never heard of must work without a code change.
const RSA_LINE =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDcZlDeqYF5J3jT0MdEad4KyimZBXx2MkgxZU42YgaWYNkoEi9KnPxpQfyXbmsZS5v9Pbp1KkqrfF9heeqbxPz1V0Njb5kgFdKN2a1BjUI5vaZu5LPANsenh6CJ9Ot48duvemTLGHPKC/RGw+sC1B80AOXEs0W+goJNxkZx7TCryLgrUFISZq/8LyHtf3KKOS5YJBo/CW4EsCtaCvy1j29E0OSbtMy2Ae3XYFzs4WavQ5qi+ZWwnCv7tVbq5X+bD2H9scWVgtd9U7Jl9fAp+syhj7U9J4lUPFVJt7oAGdKArilLDOfs36Z82Gg7ygDhTO5Z3RphLmMalx8J37H4AcFL a comment with spaces";
const RSA_FINGERPRINT = "SHA256:XESGeSZbuXSw2bqi+T8KD/Bs0EjZZLABsl38TCKT9X8";

describe("parseSshPublicKey", () => {
  test("matches `ssh-keygen -lf` for an ed25519 key", () => {
    expect(parseSshPublicKey(ED25519_LINE)).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: ED25519_FINGERPRINT,
      comment: "equin-deploy-srv-test",
      publicKey: ED25519_LINE,
    });
  });

  test("matches `ssh-keygen -lf` for an ssh-rsa key, comment spaces intact", () => {
    const key = parseSshPublicKey(RSA_LINE);
    expect(key.algorithm).toBe("ssh-rsa");
    expect(key.fingerprint).toBe(RSA_FINGERPRINT);
    expect(key.comment).toBe("a comment with spaces");
  });

  test("trims surrounding whitespace and a trailing newline", () => {
    const key = parseSshPublicKey(`  ${ED25519_LINE}\n`);
    expect(key.publicKey).toBe(ED25519_LINE);
    expect(key.fingerprint).toBe(ED25519_FINGERPRINT);
  });

  test("a key with no comment parses with an empty comment", () => {
    const [algorithm, blob] = ED25519_LINE.split(" ");
    const key = parseSshPublicKey(`${algorithm} ${blob}`);
    expect(key.comment).toBe("");
    expect(key.fingerprint).toBe(ED25519_FINGERPRINT);
  });

  test.each([
    ["empty", ""],
    ["whitespace only", "   \n "],
    ["single token", "ssh-ed25519"],
    ["non-base64 blob", "ssh-ed25519 not-a-key comment"],
    [
      "algorithm/blob mismatch",
      `ssh-rsa ${ED25519_LINE.split(" ")[1]} comment`,
    ],
    ["truncated blob", "ssh-ed25519 AAAA comment"],
    ["a private key pasted instead", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ])("rejects %s", (_label, line) => {
    expect(() => parseSshPublicKey(line)).toThrow(InvalidSshKeyError);
  });
});
