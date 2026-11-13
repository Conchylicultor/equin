-- Custom SQL migration file, put your code below! --
-- migration: 20261113_125933__flag_item_categories --
-- A flag item's `category` becomes a closed set (push-and-exit/flag-categories:
-- broken | decide | fyi | other). A stored free-form word maps onto the closest
-- one — `bug` → broken, `decision` → decide, `caveat` → fyi — and anything else
-- (the `flag` the bare-sentence items were given) → other. Idempotent: only
-- items whose category is not already one of the set change.
UPDATE "conversation_flags" SET "items" = (
  SELECT jsonb_agg(
    CASE WHEN item->>'category' IN ('broken', 'decide', 'fyi', 'other')
      THEN item
      ELSE jsonb_set(item, '{category}', to_jsonb(
        CASE lower(item->>'category')
          WHEN 'bug' THEN 'broken'
          WHEN 'decision' THEN 'decide'
          WHEN 'caveat' THEN 'fyi'
          ELSE 'other'
        END
      ))
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("items") WITH ORDINALITY AS e(item, ord)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("items") AS e(item)
  WHERE item->>'category' IS NULL
     OR item->>'category' NOT IN ('broken', 'decide', 'fyi', 'other')
);
