-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('WAITING_FOR_STUDENT', 'WAITING_FOR_PROJECT', 'READY', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "cosmicStudentId" TEXT;

-- CreateTable
CREATE TABLE "CompetitionAssignment" (
    "id" TEXT NOT NULL,
    "recommendationItemId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "sink" TEXT NOT NULL DEFAULT 'COSMIC',
    "status" "AssignmentStatus" NOT NULL DEFAULT 'READY',
    "cosmicStudentId" TEXT,
    "cosmicProjectId" TEXT,
    "cosmicTemplateId" TEXT,
    "cosmicEnrollmentId" TEXT,
    "cosmicCompetitionId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionAssignment_recommendationItemId_key" ON "CompetitionAssignment"("recommendationItemId");

-- CreateIndex
CREATE INDEX "CompetitionAssignment_status_idx" ON "CompetitionAssignment"("status");

-- CreateIndex
CREATE INDEX "CompetitionAssignment_studentId_idx" ON "CompetitionAssignment"("studentId");

-- AddForeignKey
ALTER TABLE "CompetitionAssignment" ADD CONSTRAINT "CompetitionAssignment_recommendationItemId_fkey" FOREIGN KEY ("recommendationItemId") REFERENCES "RecommendationItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionAssignment" ADD CONSTRAINT "CompetitionAssignment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionAssignment" ADD CONSTRAINT "CompetitionAssignment_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
