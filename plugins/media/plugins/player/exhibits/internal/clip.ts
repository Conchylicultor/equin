// The test clip, inlined as a data URL (an exhibit fetches nothing): a 5 s
// 640×360 testsrc2 card with a 440 Hz sine, h264 + aac, 150 KB —
//   ffmpeg -f lavfi -i testsrc2=size=640x360:rate=24:duration=5 \
//          -f lavfi -i sine=frequency=440:duration=5 \
//          -c:v libx264 -preset veryslow -crf 34 -pix_fmt yuv420p \
//          -c:a aac -b:a 48k -movflags +faststart -shortest clip.mp4
export { default as clipSrc } from "./clip.mp4?inline";
