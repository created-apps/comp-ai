-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "submissionType" TEXT,
ADD COLUMN     "primaryDomain" TEXT,
ADD COLUMN     "secondaryDomainsRaw" TEXT,
ADD COLUMN     "additionalRoundText" TEXT,
ADD COLUMN     "geographicEligibilityRaw" TEXT,
ADD COLUMN     "applicationRestrictions" TEXT,
ADD COLUMN     "minimumProjectStage" TEXT,
ADD COLUMN     "registrationOpensText" TEXT,
ADD COLUMN     "registrationOpensDate" TIMESTAMP(3),
ADD COLUMN     "registrationDeadlineText" TEXT,
ADD COLUMN     "registrationDeadlineDate" TIMESTAMP(3),
ADD COLUMN     "cycleStatusNotes" TEXT,
ADD COLUMN     "verificationConfidence" TEXT;
