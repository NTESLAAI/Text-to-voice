-- CreateTable
CREATE TABLE "Dialogue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "fileUrl" TEXT,
    "format" TEXT NOT NULL DEFAULT 'wav',
    "characters" INTEGER NOT NULL,
    "duration" DOUBLE PRECISION,
    "provider" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dialogue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogueSpeaker" (
    "id" TEXT NOT NULL,
    "dialogueId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "age" TEXT NOT NULL,
    "character" TEXT NOT NULL,
    "region" TEXT NOT NULL,

    CONSTRAINT "DialogueSpeaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogueTurn" (
    "id" TEXT NOT NULL,
    "dialogueId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "speaker" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "style" TEXT NOT NULL,

    CONSTRAINT "DialogueTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dialogue_projectId_idx" ON "Dialogue"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "DialogueSpeaker_dialogueId_role_key" ON "DialogueSpeaker"("dialogueId", "role");

-- CreateIndex
CREATE INDEX "DialogueSpeaker_dialogueId_idx" ON "DialogueSpeaker"("dialogueId");

-- CreateIndex
CREATE UNIQUE INDEX "DialogueTurn_dialogueId_order_key" ON "DialogueTurn"("dialogueId", "order");

-- CreateIndex
CREATE INDEX "DialogueTurn_dialogueId_idx" ON "DialogueTurn"("dialogueId");

-- AddForeignKey
ALTER TABLE "Dialogue" ADD CONSTRAINT "Dialogue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DialogueSpeaker" ADD CONSTRAINT "DialogueSpeaker_dialogueId_fkey" FOREIGN KEY ("dialogueId") REFERENCES "Dialogue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DialogueTurn" ADD CONSTRAINT "DialogueTurn_dialogueId_fkey" FOREIGN KEY ("dialogueId") REFERENCES "Dialogue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
