/**
 * Lead capture — the gate on the public matcher.
 *
 * This is where the profile is collected: name, phone, grade, school, city and
 * country. The student has already seen a real match by this point, so the
 * exchange is legible rather than a wall in front of a stranger.
 *
 * The rule that matters is one report per email address. A second submission
 * resends the original report; it never generates a new one. Otherwise the
 * matcher becomes a way to walk the repository one project description at a time.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { normalizeEmail } from '../../lib/persona.js';
import { requireUser } from '../auth/require-user.js';
import { enqueueImmediate } from '../email/queue.js';
import { safeJobId } from '../email/contract.js';

interface ReportItem {
  competition?: { name?: string } | null;
  reason?: string;
}

/** Flatten the run into the numbered variables the report template expects. */
function reportVariables(payload: unknown, studentName: string): Record<string, string> {
  const items = ((payload as { items?: ReportItem[] } | null)?.items ?? []).filter(
    (item) => item.competition?.name,
  );

  const vars: Record<string, string> = {
    'Student Name': studentName,
    'Competition Count': String(items.length),
  };
  items.forEach((item, i) => {
    vars[`Competition ${i + 1}`] = item.competition!.name!;
    vars[`Why it fits ${i + 1}`] = item.reason ?? '';
  });
  return vars;
}

/** The fields the requirements list for lead capture. */
const leadCapture = z.object({
  runId: z.string(),
  name: z.string().trim().min(1, 'name is required'),
  phone: z.string().trim().min(5, 'phone number is required'),
  grade: z.coerce.number().int().min(1).max(13),
  school: z.string().trim().min(1, 'school is required'),
  city: z.string().trim().min(1, 'city is required'),
  /**
   * "Others" is a real answer, not a gap: it means no region filter, so the
   * student is matched against the whole repository rather than an empty slice.
   */
  country: z.enum(['US', 'India', 'Others']),
});

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Unlock the full report for the caller and email it.
   *
   * Rate limited: this is the endpoint an abuser would drive to mine matches.
   */
  app.post(
    '/leads/report',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const parsed = leadCapture.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid details' });
      }
      const details = parsed.data;
      const emailNormalized = normalizeEmail(user.email);

      // Write the profile onto the student record too. Grade and country are
      // pipeline inputs — country scopes retrieval by region, grade is a hard
      // eligibility filter — so capturing them here makes every future run for
      // this account sharper than the one they just saw.
      const student = await prisma.student.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          name: details.name,
          phone: details.phone,
          grade: details.grade,
          school: details.school,
          city: details.city,
          country: details.country,
        },
        update: {
          name: details.name,
          phone: details.phone,
          grade: details.grade,
          school: details.school,
          city: details.city,
          country: details.country,
        },
      });
      const existing = await prisma.lead.findUnique({ where: { emailNormalized } });

      // Repository protection: one report per address, resent rather than regenerated.
      if (existing?.firstReportRunId) {
        const original = await prisma.recommendationRun.findUnique({
          where: { id: existing.firstReportRunId },
          select: { id: true, payload: true },
        });
        if (original) {
          await enqueueImmediate({
            journey: 'TOF_NURTURE_8',
            step: 0,
            to: user.email,
            toName: student.name,
            variables: reportVariables(original.payload, student.name),
            // A distinct key per resend, so BullMQ does not dedupe the resend
            // against the original send.
            idempotencyKey: safeJobId(`TOF_REPORT-resend__${emailNormalized}__${Date.now()}`),
          });
          return reply.send({
            unlocked: true,
            resent: true,
            runId: original.id,
            message: 'We already built a report for this address — we have resent it.',
          });
        }
      }

      const run = await prisma.recommendationRun.findUnique({
        where: { id: details.runId },
        include: { project: true },
      });
      if (!run) return reply.code(404).send({ error: 'run not found' });
      if (run.project.studentId && run.project.studentId !== student.id) {
        return reply.code(403).send({ error: 'not your report' });
      }

      const leadData = {
        email: user.email,
        name: details.name,
        phone: details.phone,
        grade: String(details.grade),
        school: details.school,
        city: details.city,
        country: details.country,
        source: 'MATCHER',
        firstReportRunId: run.id,
        reportGeneratedAt: new Date(),
      };

      const lead = await prisma.lead.upsert({
        where: { emailNormalized },
        create: { emailNormalized, ...leadData },
        update: leadData,
      });

      await enqueueImmediate({
        journey: 'TOF_NURTURE_8',
        step: 0,
        to: user.email,
        toName: student.name,
        variables: reportVariables(run.payload, student.name),
        idempotencyKey: safeJobId(`TOF_REPORT__${emailNormalized}`),
      });

      await prisma.recommendationRun.update({
        where: { id: run.id },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });

      return reply.send({ unlocked: true, resent: false, runId: run.id, leadId: lead.id });
    },
  );

  /** Whether this account has already unlocked, so the UI can render correctly. */
  app.get('/leads/me', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const lead = await prisma.lead.findUnique({
      where: { emailNormalized: normalizeEmail(user.email) },
      select: { firstReportRunId: true, reportGeneratedAt: true },
    });
    return reply.send({
      unlocked: Boolean(lead?.firstReportRunId),
      // The frontend loads this run on every subsequent login instead of
      // offering to generate a new one.
      runId: lead?.firstReportRunId ?? null,
      reportGeneratedAt: lead?.reportGeneratedAt ?? null,
    });
  });
}
