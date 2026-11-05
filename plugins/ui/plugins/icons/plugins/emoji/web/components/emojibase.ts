import { z } from "zod";
import type { EmojiData, EmojiDataResolver } from "frimousse";
import { EMOJIBASE_LOCALE } from "../../shared/mirror";

/** The fields of an emojibase `data.json` entry the picker reads. */
const EmojibaseEmojiSchema = z.object({
  emoji: z.string(),
  label: z.string(),
  /** Absent on components (regional indicators, skin-tone swatches). */
  group: z.number().optional(),
  subgroup: z.number().optional(),
  version: z.number(),
  tags: z.array(z.string()).optional(),
  skins: z
    .array(
      z.object({
        emoji: z.string(),
        /** One tone, or several for a multi-person emoji. */
        tone: z.union([z.number(), z.array(z.number())]),
      }),
    )
    .optional(),
});

const MessageSchema = z.object({
  key: z.string(),
  message: z.string(),
  order: z.number(),
});

const SkinToneKeySchema = z.enum([
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
]);
type SkinToneKey = z.infer<typeof SkinToneKeySchema>;

/** The fields of an emojibase `messages.json` the picker reads. */
const EmojibaseMessagesSchema = z.object({
  groups: z.array(MessageSchema),
  subgroups: z.array(MessageSchema),
  skinTones: z.array(z.object({ key: SkinToneKeySchema, message: z.string() })),
});

/** emojibase's numeric tones, 1–5, by name (0 is "none"). */
const TONES: readonly SkinToneKey[] = [
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
];

/** The group emojibase files its components under; never offered. */
const COMPONENT_GROUP = "component";
/** The subgroup holding the flags of countries (not of subdivisions). */
const COUNTRY_FLAG_SUBGROUP = "country-flag";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * emojibase's two files as frimousse's {@link EmojiData}, every version
 * included — the shape `defaultEmojiDataResolver` builds: categories are the
 * groups but components, labels capitalized, single-tone skins keyed by tone
 * and multi-tone ones kept as aliases, flags marked.
 */
export function toEmojiData(data: unknown, messages: unknown): EmojiData {
  const emojis = z.array(EmojibaseEmojiSchema).parse(data);
  const msgs = EmojibaseMessagesSchema.parse(messages);
  const countryFlags = msgs.subgroups.find(
    (s) => s.key === COUNTRY_FLAG_SUBGROUP,
  )?.order;
  const skinTones = Object.fromEntries(
    msgs.skinTones.map((t) => [t.key, capitalize(t.message)]),
  );
  for (const tone of TONES) {
    if (!(tone in skinTones))
      throw new Error(`emojibase messages: no label for skin tone "${tone}"`);
  }
  return {
    locale: EMOJIBASE_LOCALE,
    categories: msgs.groups
      .filter((g) => g.key !== COMPONENT_GROUP)
      .map((g) => ({ index: g.order, label: capitalize(g.message) })),
    skinTones: skinTones as Record<SkinToneKey, string>,
    emojis: emojis.flatMap((e) => {
      if (e.group === undefined) return [];
      const single = e.skins?.filter(
        (s): s is { emoji: string; tone: number } => typeof s.tone === "number",
      );
      const multi = e.skins
        ?.filter((s) => Array.isArray(s.tone))
        .map((s) => s.emoji);
      return [
        {
          emoji: e.emoji,
          category: e.group,
          version: e.version,
          label: capitalize(e.label),
          tags: e.tags ?? [],
          countryFlag:
            countryFlags !== undefined && e.subgroup === countryFlags
              ? true
              : undefined,
          skins: single?.length
            ? (Object.fromEntries(
                single.map((s) => [TONES[s.tone - 1], s.emoji]),
              ) as Record<SkinToneKey, string>)
            : undefined,
          aliases: multi?.length ? multi : undefined,
        },
      ];
    }),
  };
}

/**
 * The frimousse resolver over the emojibase files under `base`, each read
 * with `fetchFile` (the caller's way to the server — the transport's asset
 * hook). The data loads once, on the first resolve, and is shared by every
 * resolve after it; a failed load is forgotten, so the next resolve asks
 * again. Each resolve keeps the emoji up to the `emojiVersion` it is asked
 * for, and the country flags only where `drawsCountryFlags()` says the
 * browser draws them.
 */
export function emojibaseResolver(
  base: string,
  fetchFile: (url: string) => Promise<Response>,
  drawsCountryFlags: () => boolean,
): EmojiDataResolver {
  const loadJson = async (file: string): Promise<unknown> => {
    const res = await fetchFile(`${base}/${EMOJIBASE_LOCALE}/${file}`);
    if (!res.ok)
      throw new Error(`emoji data: ${file} answered HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
  let loading: Promise<EmojiData> | null = null;
  const load = (): Promise<EmojiData> => {
    loading ??= Promise.all([
      loadJson("data.json"),
      loadJson("messages.json"),
    ]).then(
      ([data, messages]) => toEmojiData(data, messages),
      (err: unknown) => {
        loading = null;
        throw err;
      },
    );
    return loading;
  };
  return async (_locale, { emojiVersion }) => {
    const data = await load();
    const flags = drawsCountryFlags();
    return {
      ...data,
      emojis: data.emojis.filter(
        (e) =>
          (emojiVersion === undefined || e.version <= emojiVersion) &&
          (flags || e.countryFlag !== true),
      ),
    };
  };
}
