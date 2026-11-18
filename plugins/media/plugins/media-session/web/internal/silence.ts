/**
 * The keep-alive element's sound: a near-silent mono WAV, generated once.
 *
 * Chrome opens a media session only for media longer than about 5 s (shorter
 * clips are sound effects), so it lasts 10 s and loops. Its samples alternate
 * ±1 LSB of 16 bits (−90 dBFS): inaudible, but not digital zero, so nothing
 * along the way can tell it apart from quiet music and drop it.
 */
const SAMPLE_RATE = 8000;
const SECONDS = 10;

let url: string | null = null;

export function silenceUrl(): string {
  url ??= URL.createObjectURL(new Blob([silentWav()], { type: "audio/wav" }));
  return url;
}

function silentWav(): ArrayBuffer {
  const samples = SAMPLE_RATE * SECONDS;
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i++)
    v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  return buf;
}
