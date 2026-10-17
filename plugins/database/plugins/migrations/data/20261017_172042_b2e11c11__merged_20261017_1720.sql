-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "attachment_holds" (
	"holder" text NOT NULL,
	"attachment_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "attachment_holds_holder_attachment_id_pk" PRIMARY KEY("holder","attachment_id")
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "attachment_holds" ADD CONSTRAINT "attachment_holds_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
