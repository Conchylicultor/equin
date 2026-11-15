-- Custom SQL migration file, put your code below! --
-- migration: 20261115_135505__isle_retire_duplicate_plots --
-- Isle: before 2026-11-15 a building moved by hand could get a new plot made
-- exactly on the lot it left (move.ts left that lot out of the clash context),
-- so a world could hold two plots at one spot: the building on one, the other
-- an empty lot under it. Plots are never deleted (ids are positional), so the
-- empty twin is retired (world/core's `Plot.retired`: kept, no land at all).
-- Of two empty twins, the newer is retired. Idempotent: a retired plot is
-- neither retired again nor anyone's twin.

UPDATE "isle_plots" AS d
SET "retired" = true
FROM "isle_plots" AS o
WHERE d."world" = o."world"
  AND d."plot_id" <> o."plot_id"
  AND d."geometry" -> 'x' = o."geometry" -> 'x'
  AND d."geometry" -> 'y' = o."geometry" -> 'y'
  AND NOT d."retired"
  AND NOT o."retired"
  AND d."occupant" IS NULL
  AND (o."occupant" IS NOT NULL OR o."seq" < d."seq");
