/**
 * Competition AI — the conversation loop.
 *
 * Uses the SDK's tool runner rather than a hand-written loop: the tools are our
 * own functions, and the runner handles the request → execute → continue cycle.
 *
 * Sessions are persisted so a conversation survives a reload and, more
 * importantly, so what the assistant told a family is auditable afterwards.
 */

import type { PrismaClient } from '@prisma/client';
import { getClaude, MODEL, assertNotRefused } from '../../lib/claude.js';
import { buildTools, CHAT_SYSTEM, type ChatContext } from './tools.js';

/** Enough for a real exchange; a cap stops a runaway loop costing unbounded tokens. */
const MAX_HISTORY_MESSAGES = 30;

export interface AskInput {
  studentId: string;
  userId: string;
  sessionId?: string;
  message: string;
}

export interface AskResult {
  sessionId: string;
  reply: string;
  /** Competition slugs the tools surfaced, for the UI to render as sources. */
  sources: string[];
}

export async function ask(prisma: PrismaClient, input: AskInput): Promise<AskResult> {
  const student = await prisma.student.findUnique({
    where: { id: input.studentId },
    select: { id: true, grade: true, age: true, country: true },
  });
  if (!student) throw new Error('student not found');

  const session = input.sessionId
    ? await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      })
    : null;

  // A session belongs to one account; never continue someone else's.
  if (input.sessionId && (!session || session.userId !== input.userId)) {
    throw new Error('session not found');
  }

  const active =
    session ??
    (await prisma.chatSession.create({
      data: { userId: input.userId, persona: 'ENROLLED' },
      include: { messages: true },
    }));

  const ctx: ChatContext = {
    prisma,
    studentId: student.id,
    country: student.country,
    grade: student.grade,
    age: student.age,
    seen: new Set<string>(),
  };

  // Only user/assistant text is replayed. Tool results are deliberately not
  // rehydrated: they can be large, and stale competition data replayed as
  // context is exactly how a superseded deadline gets repeated as fact.
  const history = (session?.messages ?? [])
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String((m.content as { text?: string })?.text ?? ''),
    }))
    .filter((m) => m.content.length > 0);

  const client = getClaude();
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 4096,
    system: CHAT_SYSTEM,
    thinking: { type: 'adaptive' },
    // Answering from retrieved records is not a hard reasoning task, and a
    // student is waiting on the response.
    output_config: { effort: 'low' },
    tools: buildTools(ctx),
    messages: [...history, { role: 'user', content: input.message }],
  });

  const final = await runner.runUntilDone();
  assertNotRefused(final);

  const reply = final.content
    .filter((block): block is { type: 'text'; text: string } & typeof block => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const sources = [...ctx.seen];

  await prisma.$transaction([
    prisma.chatMessage.create({
      data: { sessionId: active.id, role: 'user', content: { text: input.message } },
    }),
    prisma.chatMessage.create({
      data: {
        sessionId: active.id,
        role: 'assistant',
        content: { text: reply },
        citations: sources,
      },
    }),
    prisma.chatSession.update({
      where: { id: active.id },
      data: {
        turnCount: { increment: 1 },
        competitionsSeen: { set: [...new Set([...active.competitionsSeen, ...sources])] },
      },
    }),
  ]);

  return { sessionId: active.id, reply, sources };
}

export async function history(prisma: PrismaClient, userId: string, sessionId: string) {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!session || session.userId !== userId) return null;

  return {
    id: session.id,
    messages: session.messages.map((m) => ({
      role: m.role,
      text: String((m.content as { text?: string })?.text ?? ''),
      createdAt: m.createdAt,
    })),
  };
}
