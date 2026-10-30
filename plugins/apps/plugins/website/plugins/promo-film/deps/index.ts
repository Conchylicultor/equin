// The promo film's music track, installed on demand. Host-only, like every
// `deps/` barrel; collected into infra/deps' registry through the `default`
// array. (ffmpeg is declared by media/ffmpeg.)
import { promoMusic } from "./internal/music";

export { promoMusic, PROMO_MUSIC } from "./internal/music";

export default [promoMusic];
