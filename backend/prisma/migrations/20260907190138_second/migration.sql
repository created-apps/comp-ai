-- AlterTable
ALTER TABLE "EnrolledRosterEntry" ADD COLUMN     "parentName" TEXT,
ADD COLUMN     "projectDescription" TEXT,
ADD COLUMN     "projectName" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'STUDENT',
ALTER COLUMN "domain" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "emailJourneyStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EnrolledTopPicks" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "competition1" TEXT,
    "whyCompetition1Fits" TEXT,
    "competition2" TEXT,
    "whyCompetition2Fits" TEXT,
    "competition3" TEXT,
    "whyCompetition3Fits" TEXT,
    "projectId" TEXT,
    "runId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "EnrolledTopPicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnrolledTopPicks_studentId_key" ON "EnrolledTopPicks"("studentId");

-- CreateIndex
CREATE INDEX "EnrolledTopPicks_generatedAt_idx" ON "EnrolledTopPicks"("generatedAt");

-- CreateIndex
CREATE INDEX "Project_studentId_source_idx" ON "Project"("studentId", "source");

-- AddForeignKey
ALTER TABLE "EnrolledTopPicks" ADD CONSTRAINT "EnrolledTopPicks_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
