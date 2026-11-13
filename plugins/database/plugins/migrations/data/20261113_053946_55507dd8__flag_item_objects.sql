-- Custom SQL migration file, put your code below! --
-- migration: 20261113_053946__flag_item_objects --
-- A flag item becomes `{ category, text, detail? }` (push-and-exit's
-- `FlagItem`): an item stored as a bare sentence keeps its sentence as its
-- text, under the category `flag`. Idempotent: only string elements change.
UPDATE "conversation_flags" SET "items" = (
  SELECT jsonb_agg(
    CASE WHEN jsonb_typeof(item) = 'string'
      THEN jsonb_build_object('category', 'flag', 'text', item)
      ELSE item
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("items") WITH ORDINALITY AS e(item, ord)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("items") AS e(item)
  WHERE jsonb_typeof(item) = 'string'
);
