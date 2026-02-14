/*
  Warnings:

  - The values [SMS] on the enum `IntegrationType` will be removed. If these variants are still used in the database, this will fail.
  - The values [SMS] on the enum `MessageChannel` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'STAFF_LOGIN';
ALTER TYPE "AlertType" ADD VALUE 'STAFF_JOINED';

-- AlterEnum
BEGIN;
CREATE TYPE "IntegrationType_new" AS ENUM ('EMAIL', 'CALENDAR', 'WEBHOOK', 'FILE_STORAGE', 'WHATSAPP');
ALTER TABLE "Integration" ALTER COLUMN "type" TYPE "IntegrationType_new" USING ("type"::text::"IntegrationType_new");
ALTER TYPE "IntegrationType" RENAME TO "IntegrationType_old";
ALTER TYPE "IntegrationType_new" RENAME TO "IntegrationType";
DROP TYPE "IntegrationType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "MessageChannel_new" AS ENUM ('EMAIL', 'SYSTEM', 'WHATSAPP');
ALTER TABLE "Message" ALTER COLUMN "channel" TYPE "MessageChannel_new" USING ("channel"::text::"MessageChannel_new");
ALTER TYPE "MessageChannel" RENAME TO "MessageChannel_old";
ALTER TYPE "MessageChannel_new" RENAME TO "MessageChannel";
DROP TYPE "MessageChannel_old";
COMMIT;

-- AlterTable
ALTER TABLE "FormTemplate" ADD COLUMN     "googleFormUrl" TEXT,
ALTER COLUMN "fields" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "contactFormFields" JSONB;

-- CreateIndex
CREATE INDEX "Alert_workspaceId_isRead_createdAt_idx" ON "Alert"("workspaceId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_workspaceId_status_dateTime_idx" ON "Booking"("workspaceId", "status", "dateTime");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_createdAt_idx" ON "Contact"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_updatedAt_idx" ON "Conversation"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_idx" ON "Conversation"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "FormSubmission_formTemplateId_status_idx" ON "FormSubmission"("formTemplateId", "status");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
