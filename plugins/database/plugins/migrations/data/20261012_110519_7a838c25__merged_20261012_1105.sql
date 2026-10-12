-- singularity:phase expand
ALTER TABLE "sonata_songs_ext_rhythm" ADD COLUMN "bass_voicing" jsonb DEFAULT '{"enabled":true,"octave":2,"voiceLead":false,"doubleOctave":false}'::jsonb NOT NULL;
ALTER TABLE "sonata_songs_ext_rhythm" ADD COLUMN "chord_voicing" jsonb DEFAULT '{"enabled":true,"octave":4,"voiceLead":true,"doubleOctave":false}'::jsonb NOT NULL;
-- singularity:phase contract
-- singularity:claims
