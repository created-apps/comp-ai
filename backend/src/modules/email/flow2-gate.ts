/**
 * The one precondition for Flow 2: a real project name in the database.
 *
 * Four of the five emails reference {{Project Name}} — "It has been great to see
 * {{Student Name}} develop {{Project Name}}" only works if we actually know what
 * they built. Sending with a placeholder, or with wording bent to avoid naming
 * the project, reads as a broken mail merge to a family who paid us to know.
 *
 * So the journey does not start until the name exists. It is deferred, not
 * cancelled: the moment a project name lands — from the roster sheet or from the
 * app — `startEnrolledJourneyIfReady` picks it up.
 */

import type { PrismaClient } from '@prisma/client';

export interface ProjectNameLookup {
  projectName: string | null;
  projectId: string | null;
}

/**
 * The most recent project that actually carries a name.
 *
 * A project row with only a description does not qualify: the copy needs
 * something that reads as a title, not a paragraph truncated to 60 characters.
 */
export async function resolveProjectName(
  prisma: PrismaClient,
  studentId: string,
): Promise<ProjectNameLookup> {
  const project = await prisma.project.findFirst({
    // A dismissed project is one the student told us they are not continuing
    // with — emailing them about it would be worse than not emailing at all.
    where: { studentId, NOT: { name: null }, dismissedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true },
  });

  const name = project?.name?.trim();
  if (!name) return { projectName: null, projectId: null };
  return { projectName: name, projectId: project!.id };
}
