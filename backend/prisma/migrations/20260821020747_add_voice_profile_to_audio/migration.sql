-- Add voice profile fields as nullable first
ALTER TABLE "Audio"
ADD COLUMN "character" TEXT,
ADD COLUMN "emotion" TEXT,
ADD COLUMN "style" TEXT,
ADD COLUMN "tone" TEXT;

-- Preserve existing audio records with a neutral default profile
UPDATE "Audio"
SET
  "character" = 'adult_male',
  "emotion" = 'natural',
  "style" = 'conversation',
  "tone" = 'neutral'
WHERE
  "character" IS NULL;

-- Make voice profile fields required
ALTER TABLE "Audio"
ALTER COLUMN "character" SET NOT NULL,
ALTER COLUMN "emotion" SET NOT NULL,
ALTER COLUMN "style" SET NOT NULL,
ALTER COLUMN "tone" SET NOT NULL;

-- Current application generates WAV files
ALTER TABLE "Audio"
ALTER COLUMN "format" SET DEFAULT 'wav';