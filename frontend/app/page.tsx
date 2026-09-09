'use client'

/**
 * Single entry point for both flows.
 *
 * There is no separate TOF app. The session's persona — resolved on the backend
 * from the enrolled roster — decides what renders here, and the same project
 * form and recommendation pipeline serve both.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Clock3, Loader2, LogOut } from 'lucide-react'
import LeadForm from '@/components/lead-form'
import ProjectConfirm from '@/components/project-confirm'
import CompetitionChat from '@/components/competition-chat'
import FullPageLoader from '@/components/full-page-loader'
import ProjectForm from '@/components/project-form'
import RecommendationList from '@/components/recommendation-list'
import MyCompetitions from '@/components/my-competitions'
import {
  ApiError,
  type Entitlement,
  entitlement as entitlementApi,
  leads,
  type LeadDetails,
  logout,
  type PendingProject,
  projects as projectsApi,
  recommendations as recommendationsApi,
  refresh,
  type MyCompetition,
  type RecommendationPayload,
  type Session,
} from '@/lib/api'

export default function Home() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [payload, setPayload] = useState<RecommendationPayload | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const [showLeadForm, setShowLeadForm] = useState(false)
  const [pendingProject, setPendingProject] = useState<PendingProject | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [alreadyUnlocked, setAlreadyUnlocked] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [mine, setMine] = useState<MyCompetition[]>([])
  const [selecting, setSelecting] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  /**
   * A run takes ~35 seconds. Without this the page falls straight through to the
   * blank project form the moment the student confirms their programme project —
   * so they are asked to describe a project we already have, and a second one
   * gets created if they do.
   */
  const [generating, setGenerating] = useState(false)
  /** The project a retry would re-run, when generation failed. */
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  /** The pipeline ran fine and simply matched nothing — not the same as a failure. */
  const [noMatches, setNoMatches] = useState(false)

  /**
   * On every load, a TOF account that has already been sent a report is shown
   * that same report — never the project form. The report they received by email
   * and the one on screen must stay the same document, and re-running would also
   * let one address mine the repository project by project.
   */
  useEffect(() => {
    let cancelled = false
    refresh()
      .then(async (nextSession) => {
        if (cancelled) return
        setSession(nextSession)

        if (nextSession?.user.persona === 'ENROLLED') {
          // What their programme includes, and what they have already chosen.
          // Both are needed before any card can be rendered as selectable.
          await Promise.all([
            entitlementApi
              .get()
              .then((r) => !cancelled && setEntitlement(r.entitlement))
              .catch(() => undefined),
            entitlementApi
              .mine()
              .then((r) => !cancelled && setMine(r.competitions))
              .catch(() => undefined),
          ])

          // An enrolled family already has a project on the programme sheet.
          // Ask about it before offering a blank form.
          try {
            const pending = await projectsApi.pendingConfirmation()
            if (!cancelled) setPendingProject(pending.project)
          } catch {
            // No pending project, or it could not be loaded — the project form
            // is a fine fallback.
          }
          return
        }

        if (nextSession?.user.persona !== 'TOF') return
        try {
          const status = await leads.status()
          if (cancelled || !status.unlocked || !status.runId) return
          const run = await recommendationsApi.get(status.runId)
          if (cancelled) return
          setRunId(status.runId)
          setAlreadyUnlocked(true)
          if (run.payload) setPayload(run.payload)
        } catch {
          // No saved report, or it could not be loaded — fall through to the
          // project form rather than blocking the page.
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleComplete = async (_projectId: string, newRunId: string) => {
    setRunId(newRunId)
    try {
      const run = await recommendationsApi.get(newRunId)
      if (run.payload) setPayload(run.payload)
      else setAwaitingReview(true)
    } catch (err) {
      // 409 specifically means "held for internal review" — the requirement
      // working, not a failure. Anything else is a real error and must not be
      // dressed up as "a mentor is reviewing it".
      if (err instanceof ApiError && err.status === 409) setAwaitingReview(true)
      else setError(err instanceof Error ? err.message : 'could not load your matches')
    }
  }

  /**
   * Pass the lead gate: record the lead, email the report, and re-fetch the run
   * so the previously redacted competitions come back from the server. The
   * unlocked data is never already in the browser — it has to be re-requested.
   */
  const handleUnlock = async (details: LeadDetails) => {
    if (!runId) return
    setUnlocking(true)
    setError('')
    try {
      const result = await leads.unlock(runId, details)
      // Re-fetch: the unlocked competitions were never in the browser, because
      // the server redacted them out of the earlier response.
      const run = await recommendationsApi.get(result.runId)
      if (run.payload) setPayload(run.payload)
      setShowLeadForm(false)
      setAlreadyUnlocked(true)
      setNotice(
        result.resent
          ? 'We had already prepared a report for this address — we have resent it to your inbox.'
          : 'Your full report is on its way to your inbox.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not unlock your report')
    } finally {
      setUnlocking(false)
    }
  }

  const handleConfirmProject = async () => {
    if (!pendingProject) return
    setConfirming(true)
    setError('')
    try {
      await projectsApi.confirm(pendingProject.id)
      const confirmed = pendingProject
      // Cleared only once the run is under way — `generating` takes over as the
      // thing keeping the project form off the screen.
      setPendingProject(null)
      setRunId(null)
      setConfirming(false)
      // Straight into matching — they have told us what they are working on.
      // runFor owns its own errors and its own busy state.
      await runFor(confirmed.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not confirm your project')
      setConfirming(false)
    }
  }

  const handleDismissProject = async () => {
    if (!pendingProject) return
    setConfirming(true)
    try {
      await projectsApi.dismiss(pendingProject.id)
      setPendingProject(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not update your project')
    } finally {
      setConfirming(false)
    }
  }

  /**
   * Confirm a selection.
   *
   * Activation is immediate — the internal review gate already happened when the
   * run was approved — and the assignment to the student's CreatED workspace is
   * queued by the backend. A queued assignment is a normal outcome, so the
   * confirmation never claims the workspace is ready; `MyCompetitions` reports
   * the real state.
   */
  const handleSelect = async (competitionIds: string[]) => {
    if (!runId || competitionIds.length === 0) return
    setSelecting(true)
    setSelectionError('')
    try {
      const result = await entitlementApi.select(runId, competitionIds)
      setEntitlement(result.entitlement)
      const refreshed = await entitlementApi.mine()
      setMine(refreshed.competitions)
      setNotice(
        result.activated.length === 1
          ? `${result.activated[0]?.name} is now yours to work on.`
          : `${result.activated.length} competitions are now yours to work on.`,
      )
    } catch (err) {
      setSelectionError(err instanceof Error ? err.message : 'could not confirm your selection')
    } finally {
      setSelecting(false)
    }
  }

  /**
   * Generate against an existing project id and show the result.
   *
   * Holds `generating` for the whole call so the page shows that work is
   * happening instead of an empty form, and remembers the project so a failure
   * can be retried against it rather than sending the student back to describe
   * the same project again.
   */
  const runFor = async (projectId: string) => {
    setGenerating(true)
    setActiveProjectId(projectId)
    setError('')
    setNoMatches(false)
    try {
      const run = await recommendationsApi.generate(projectId)
      if (run.itemCount === 0) {
        setNoMatches(true)
        setError(
          run.warning ??
            'Nothing in the repository fit this project closely enough to recommend.',
        )
        return
      }
      await handleComplete(projectId, run.runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not find your matches')
    } finally {
      setGenerating(false)
    }
  }

  if (loading) {
    return <FullPageLoader />
  }

  if (!session) return <SignedOut />

  const persona = session.user.persona

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-5 py-4 md:px-10">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            C
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">CreatED</p>
            <p className="text-[11px] text-muted-foreground">Competition AI</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden rounded-full bg-muted px-3 py-1.5 text-[11px] font-semibold text-muted-foreground sm:block">
            {persona === 'ENROLLED' ? 'Enrolled programme' : 'Public matcher'}
          </span>
          <button
            onClick={async () => {
              await logout()
              setSession(null)
              setPayload(null)
            }}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-5 md:p-10">
        {/* What the student has actually committed to. It sits above everything
            else because, once they have chosen, this is the page — the matches
            below are the rest of the shortlist, not the main event. */}
        {mine.length > 0 && <MyCompetitions competitions={mine} />}

        {pendingProject && !generating && !payload && !awaitingReview && (
          <ProjectConfirm
            project={pendingProject}
            busy={confirming}
            onConfirm={handleConfirmProject}
            onDismiss={handleDismissProject}
          />
        )}

        {/* The run takes about half a minute. Saying nothing here is what put a
            blank project form in front of enrolled students who had just told us
            which project to use. */}
        {generating && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <div className="mx-auto grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Loader2 className="size-5 animate-spin" />
            </div>
            <h2 className="mt-5 text-xl font-semibold tracking-tight">
              Finding your competitions
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              We are reading your project and searching the competition repository. This takes
              about half a minute.
            </p>
          </div>
        )}

        {/* A failed run must not drop an enrolled student onto a blank form:
            they would describe again a project we already hold, and creating a
            second one is worse than waiting. */}
        {!generating && error && activeProjectId && !payload && !awaitingReview && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <h2 className="text-xl font-semibold tracking-tight">
              {noMatches ? 'No competitions matched this project yet' : 'We could not finish your matches'}
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              {error}
            </p>
            <button
              onClick={() => void runFor(activeProjectId)}
              className="mt-5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              Try again
            </button>
          </div>
        )}

        {!pendingProject && !generating && !activeProjectId && !payload && !awaitingReview && (
          <>
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[.16em] text-primary">
                {persona === 'ENROLLED' ? 'Your competition pathway' : 'Competition matcher'}
              </p>
              <h1 className="mt-3 text-balance font-serif text-4xl tracking-tight md:text-5xl">
                Let&apos;s find the right competition for your project.
              </h1>
              <p className="mt-4 text-pretty text-sm leading-7 text-muted-foreground">
                {persona === 'ENROLLED'
                  ? 'Your matches are reviewed by the CreatED team before they reach you, so what you see has been checked by a person.'
                  : 'Tell us what you are building. We match it against competitions that fit your stage, your region and your timeline.'}
              </p>
            </div>
            <div className="mt-8">
              <ProjectForm onComplete={handleComplete} />
            </div>
          </>
        )}

        {awaitingReview && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <div className="mx-auto grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Clock3 className="size-5" />
            </div>
            <h2 className="mt-5 text-xl font-semibold tracking-tight">
              Your matches are with the CreatED team
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              We generated your recommendations and a mentor is reviewing them now. You will see
              them here once they are approved.
            </p>
          </div>
        )}

        {payload && (
          <>
            <div className="mb-8 max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[.16em] text-primary">
                Your matches
              </p>
              <h1 className="mt-3 text-balance font-serif text-3xl tracking-tight md:text-4xl">
                {persona === 'ENROLLED'
                  ? 'Choose what you want to pursue.'
                  : 'Here is where your project could compete.'}
              </h1>
              {persona === 'TOF' && alreadyUnlocked && (
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  This is the report we prepared and emailed you. It stays the same each time you
                  sign in, so it always matches the copy in your inbox.
                </p>
              )}
            </div>
            <RecommendationList
              payload={payload}
              persona={persona}
              {...(entitlement ? { allowance: entitlement.allowance } : {})}
              activeIds={entitlement?.activeCompetitionIds ?? []}
              onConfirm={handleSelect}
              confirming={selecting}
              {...(selectionError ? { selectionError } : {})}
              unlocking={unlocking}
              onUnlock={() => setShowLeadForm(true)}
              leadForm={
                showLeadForm ? (
                  <LeadForm
                    email={session.user.email}
                    lockedCount={
                      payload.items.filter((i) => i.locked === true || !i.competition).length
                    }
                    busy={unlocking}
                    {...(error ? { error } : {})}
                    onSubmit={handleUnlock}
                    onCancel={() => setShowLeadForm(false)}
                  />
                ) : null
              }
            />
            {notice && (
              <p className="mt-4 text-center text-xs font-medium text-primary">{notice}</p>
            )}
            {error && <p className="mt-4 text-center text-xs text-destructive">{error}</p>}
          </>
        )}
      </main>

      {/* Enrolled only. The backend refuses anyone else independently. */}
      {persona === 'ENROLLED' && <CompetitionChat />}
    </div>
  )
}

function SignedOut() {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-5">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          C
        </div>
        <h1 className="mt-6 text-balance font-serif text-4xl tracking-tight">
          Find the right competition for your project.
        </h1>
        <p className="mt-4 text-pretty text-sm leading-7 text-muted-foreground">
          Tell us what you are building and we will match it against the competitions that
          actually fit your stage, your region and your timeline.
        </p>
        <Link
          href="/login"
          className="mt-7 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground"
        >
          Get started <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  )
}
