'use client'

/**
 * The competitions this student has activated.
 *
 * Activation creates their workspace in COSMIC, and that push can legitimately
 * still be queued — a kid whose CreatED project has not been set up there yet is
 * the ordinary case, not an error. So the card states plainly whether the
 * workspace is ready rather than implying it always is: the student should never
 * follow a promise into an empty page.
 */

import { CalendarDays, CheckCircle2, Clock3 } from 'lucide-react'
import type { MyCompetition } from '@/lib/api'

export default function MyCompetitions({ competitions }: { competitions: MyCompetition[] }) {
  return (
    <section className="mb-8 rounded-2xl border border-border bg-card p-5 md:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-primary">
            Your competitions
          </p>
          <h2 className="mt-2 font-serif text-2xl tracking-tight">
            {competitions.length === 1
              ? 'This is what you are working towards.'
              : 'These are what you are working towards.'}
          </h2>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          {competitions.length} active
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-3">
        {competitions.map(({ competition, reason, workspace }) => {
          // Same honesty rule as the match cards: a deadline we never verified is
          // described, not asserted.
          const deadline = competition.deadline.isRolling
            ? 'Rolling deadline'
            : (competition.deadline.text ?? 'Deadline not published')

          return (
            <article key={competition.slug} className="rounded-xl border border-border p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{competition.name}</h3>
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold ${
                    workspace.ready
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {workspace.ready ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <Clock3 className="size-3" />
                  )}
                  {workspace.status}
                </span>
              </div>

              <p className="mt-2 text-sm leading-6 text-muted-foreground">{reason}</p>

              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1">
                  <CalendarDays className="size-3" />
                  {deadline}
                </span>
                {competition.registrationStatus && (
                  <span className="rounded-md border border-border px-2 py-1">
                    {competition.registrationStatus}
                  </span>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
