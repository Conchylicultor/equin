-- singularity:snapshot id=2685cc3e-e919-4df6-a544-a74713bff43b parents=a640b086-08b4-4257-846a-b8e127006e39
-- singularity:supersedes 8bf92d6f
-- singularity:phase expand
CREATE TABLE "before_after_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"tool_use_id" text,
	"title" text NOT NULL,
	"route" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"color_scheme" text,
	"before_attachment_id" text NOT NULL,
	"after_attachment_id" text NOT NULL,
	"before_label" text NOT NULL,
	"after_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "before_after_pairs_attachments" (
	"owner_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "before_after_pairs_attachments_owner_id_attachment_id_pk" PRIMARY KEY("owner_id","attachment_id")
);
CREATE INDEX "before_after_pairs_by_conv_idx" ON "before_after_pairs" USING btree ("conversation_id","created_at");
-- singularity:phase contract
ALTER TABLE "before_after_pairs_attachments" ADD CONSTRAINT "before_after_pairs_attachments_owner_id_before_after_pairs_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."before_after_pairs"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "before_after_pairs_attachments" ADD CONSTRAINT "before_after_pairs_attachments_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE cascade;
CREATE UNIQUE INDEX "before_after_pairs_tool_use_idx" ON "before_after_pairs" USING btree ("tool_use_id");
-- singularity:claims
