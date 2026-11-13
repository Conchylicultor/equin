// Every image import is an ImportedImage — its URL and its pixel size — not
// the bare URL string `vite/client` declares (`framework/image-import`).
// Referenced from `vite-env.d.ts` BEFORE `vite/client`, which is how vite
// documents overriding its asset typings: the first declaration of a pattern
// module wins. The shape is written out (an ambient file cannot import);
// every consumer that names `ImportedImage` holds it against the original.

declare module "*.png" {
  const image: {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  };
  export default image;
}

declare module "*.jpg" {
  const image: {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  };
  export default image;
}

declare module "*.jpeg" {
  const image: {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  };
  export default image;
}

declare module "*.gif" {
  const image: {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  };
  export default image;
}

declare module "*.webp" {
  const image: {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  };
  export default image;
}

declare module "*.bmp" {
  const image: {
    readonly src: string;
    readonly width: number;
    readonly height: number;
  };
  export default image;
}
