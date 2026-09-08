-- CreateEnum
CREATE TYPE "Persona" AS ENUM ('TOF', 'ENROLLED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'PARENT', 'INTERNAL', 'ADMIN');

-- CreateEnum
CREATE TYPE "RecStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "ItemState" AS ENUM ('RECOMMENDED', 'APPROVED', 'SELECTED', 'ACTIVE', 'ARCHIVED', 'LOCKED');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('UPCOMING', 'OPEN', 'CLOSED', 'AWAITING_VERIFICATION', 'VERIFIED');

-- CreateEnum
CREATE TYPE "VerifyStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'NO_CHANGE', 'FAILED');

-- CreateEnum
CREATE TYPE "DeadlinePrecision" AS ENUM ('DAY', 'MONTH', 'YEAR', 'ROLLING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "persona" "Persona" NOT NULL,
    "personaLockedAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrolledRosterEntry" (
    "id" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "rawEmail" TEXT NOT NULL,
    "parentEmailNormalized" TEXT,
    "parentEmail2Normalized" TEXT,
    "studentName" TEXT,
    "programTypes" TEXT[],
    "programTrack" TEXT,
    "competitionAllowance" INTEGER,
    "rawRow" JSONB NOT NULL,
    "sheetRowNumber" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "syncRunId" TEXT NOT NULL,

    CONSTRAINT "EnrolledRosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetSyncRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rowsSeen" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "deactivated" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,

    CONSTRAINT "SheetSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" INTEGER,
    "age" INTEGER,
    "school" TEXT,
    "city" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "parentName" TEXT,
    "parentEmail" TEXT,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramEnrolment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "programName" TEXT NOT NULL,
    "competitionAllowance" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),

    CONSTRAINT "ProgramEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "grade" TEXT,
    "school" TEXT,
    "city" TEXT,
    "country" TEXT,
    "source" TEXT,
    "firstReportRunId" TEXT,
    "reportGeneratedAt" TIMESTAMP(3),
    "crmSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competition" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "baseSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "regionCode" TEXT NOT NULL,
    "regions" TEXT[],
    "sourceSheets" TEXT[],
    "description" TEXT,
    "submissionDetails" TEXT,
    "domains" TEXT[],
    "domainsRaw" TEXT,
    "deadlineDate" TIMESTAMP(3),
    "deadlineMonth" INTEGER,
    "deadlineYear" INTEGER,
    "deadlineText" TEXT,
    "deadlinePrecision" "DeadlinePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "isRolling" BOOLEAN NOT NULL DEFAULT false,
    "gradeMin" INTEGER,
    "gradeMax" INTEGER,
    "ageMin" INTEGER,
    "ageMax" INTEGER,
    "eligibilityRaw" TEXT,
    "allowsIndividual" BOOLEAN,
    "allowsTeam" BOOLEAN,
    "teamMin" INTEGER,
    "teamMax" INTEGER,
    "teamRaw" TEXT,
    "registrationStatus" TEXT,
    "registrationText" TEXT,
    "prestige" INTEGER,
    "selectivity" INTEGER,
    "complexity" INTEGER,
    "timeInvestment" INTEGER,
    "totalScore" INTEGER,
    "difficulty" "Difficulty",
    "officialUrls" TEXT[],
    "cycle" TEXT,
    "cycleActive" BOOLEAN NOT NULL DEFAULT true,
    "winnerLists" TEXT,
    "notes" TEXT,
    "comments" TEXT,
    "internalGuidanceUrl" TEXT,
    "contentHash" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "sourceRows" JSONB,
    "warnings" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitionMilestone" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "dateStart" TIMESTAMP(3),
    "dateEnd" TIMESTAMP(3),
    "dateText" TEXT,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'UPCOMING',
    "activatesOnQualification" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,

    CONSTRAINT "CompetitionMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "studentId" TEXT,
    "leadId" TEXT,
    "name" TEXT,
    "domain" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "maturity" TEXT,
    "classification" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "persona" "Persona" NOT NULL,
    "status" "RecStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "retrievalTrace" JSONB,
    "engineVersion" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "fitBucket" TEXT,
    "state" "ItemState" NOT NULL DEFAULT 'RECOMMENDED',
    "detail" JSONB NOT NULL,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "RecommendationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationEvent" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "trigger" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extracted" JSONB,
    "diff" JSONB,
    "status" "VerifyStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "leadId" TEXT,
    "anonId" TEXT,
    "persona" "Persona" NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "competitionsSeen" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "toolTrace" JSONB,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSend" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "journey" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "providerId" TEXT,

    CONSTRAINT "EmailSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_emailNormalized_key" ON "User"("emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "EnrolledRosterEntry_emailNormalized_key" ON "EnrolledRosterEntry"("emailNormalized");

-- CreateIndex
CREATE INDEX "EnrolledRosterEntry_parentEmailNormalized_idx" ON "EnrolledRosterEntry"("parentEmailNormalized");

-- CreateIndex
CREATE INDEX "EnrolledRosterEntry_parentEmail2Normalized_idx" ON "EnrolledRosterEntry"("parentEmail2Normalized");

-- CreateIndex
CREATE INDEX "EnrolledRosterEntry_active_idx" ON "EnrolledRosterEntry"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE INDEX "ProgramEnrolment_studentId_idx" ON "ProgramEnrolment"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_emailNormalized_key" ON "Lead"("emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Competition_slug_key" ON "Competition"("slug");

-- CreateIndex
CREATE INDEX "Competition_cycleActive_idx" ON "Competition"("cycleActive");

-- CreateIndex
CREATE INDEX "Competition_deadlineDate_idx" ON "Competition"("deadlineDate");

-- CreateIndex
CREATE INDEX "Competition_region_idx" ON "Competition"("region");

-- CreateIndex
CREATE INDEX "Competition_baseSlug_idx" ON "Competition"("baseSlug");

-- CreateIndex
CREATE INDEX "CompetitionMilestone_dateStart_idx" ON "CompetitionMilestone"("dateStart");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionMilestone_competitionId_cycle_order_key" ON "CompetitionMilestone"("competitionId", "cycle", "order");

-- CreateIndex
CREATE INDEX "Project_studentId_idx" ON "Project"("studentId");

-- CreateIndex
CREATE INDEX "Project_leadId_idx" ON "Project"("leadId");

-- CreateIndex
CREATE INDEX "RecommendationRun_projectId_createdAt_idx" ON "RecommendationRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationRun_status_idx" ON "RecommendationRun"("status");

-- CreateIndex
CREATE INDEX "RecommendationItem_state_idx" ON "RecommendationItem"("state");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationItem_runId_competitionId_key" ON "RecommendationItem"("runId", "competitionId");

-- CreateIndex
CREATE INDEX "VerificationEvent_status_idx" ON "VerificationEvent"("status");

-- CreateIndex
CREATE INDEX "ChatSession_anonId_idx" ON "ChatSession"("anonId");

-- CreateIndex
CREATE INDEX "ChatSession_leadId_idx" ON "ChatSession"("leadId");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_createdAt_idx" ON "ChatMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailSend_status_scheduledAt_idx" ON "EmailSend"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSend_toEmail_journey_step_key" ON "EmailSend"("toEmail", "journey", "step");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "EnrolledRosterEntry" ADD CONSTRAINT "EnrolledRosterEntry_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SheetSyncRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramEnrolment" ADD CONSTRAINT "ProgramEnrolment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionMilestone" ADD CONSTRAINT "CompetitionMilestone_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationRun" ADD CONSTRAINT "RecommendationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationItem" ADD CONSTRAINT "RecommendationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RecommendationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationItem" ADD CONSTRAINT "RecommendationItem_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvent" ADD CONSTRAINT "VerificationEvent_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
