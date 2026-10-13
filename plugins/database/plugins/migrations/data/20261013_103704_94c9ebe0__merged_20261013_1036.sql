-- singularity:phase expand
ALTER TABLE "sonata_songs_ext_rhythm" ADD COLUMN "restart_on_chord_change" boolean DEFAULT true NOT NULL;
-- singularity:phase contract
ALTER TABLE "sonata_songs_ext_rhythm" DROP COLUMN IF EXISTS "enabled";
-- singularity:claims
