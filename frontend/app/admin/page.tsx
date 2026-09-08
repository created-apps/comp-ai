'use client'

/**
 * Internal admin console.
 *
 * Gated by the shared ADMIN_PASSWORD on the backend, which is exchanged for an
 * HttpOnly cookie — the password never lives in this component's state beyond
 * the submit, and no admin token is readable from JS.
 *
 * The one operation today is flipping an account between TOF and ENROLLED.
 * Because the roster sync runs every 5 hours and would otherwise revert a
 * manual change, a manual flip pins the account; "follow roster" releases it.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Clock3, LogOut, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import FullPageLoader from '@/components/full-page-loader'
import Link from 'next/link'
import {
  admin,
  ApiError,
  type AdminAssignment,
  type AdminOverview,
  type AdminReview,
  type AdminUser,
  type Persona,
} from '@/lib/api'

/** Why an assignment has not reached COSMIC yet, in words an operator can act on. */
const ASSIGNMENT_REASON: Record<string, string> = {
  SENT: 'assigned in COSMIC',
  READY: 'queued — will be pushed on the next tick',
  WAITING_FOR_STUDENT: 'no COSMIC student matched this email — set the COSMIC id below',
  WAITING_FOR_PROJECT: 'the student has no project in COSMIC yet',
  FAILED: 'COSMIC could not be reached',
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [reviews, setReviews] = useState<AdminReview[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Persona | 'ALL'>('ALL')
  const [pending, setPending] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<AdminAssignment[]>([])
  const [assignmentCounts, setAssignmentCounts] = useState<Record<string, number>>({})
  const [toast, setToast] = useState('')

  const notify = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }

  const load = useCallback(async () => {
    try {
      const [nextOverview, nextUsers, nextReviews, nextAssignments] = await Promise.all([
        admin.overview(),
        admin.users({
          ...(query ? { q: query } : {}),
          ...(filter !== 'ALL' ? { persona: filter } : {}),
        }),
        admin.reviews(),
        admin.assignments(),
      ])
      setOverview(nextOverview)
      setReviews(nextReviews.reviews)
      setUsers(nextUsers.users)
      setTotal(nextUsers.total)
      setAssignments(nextAssignments.assignments)
      setAssignmentCounts(nextAssignments.counts)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthed(false)
      else setError(err instanceof Error ? err.message : 'failed to load')
    }
  }, [query, filter])

  useEffect(() => {
    admin
      .session()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    if (authed) void load()
  }, [authed, load])

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await admin.login(password)
      setPassword('')
      setAuthed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed')
    } finally {
      setBusy(false)
    }
  }

  const changePersona = async (user: AdminUser, persona: Persona, followRoster = false) => {
    setPending(user.id)
    try {
      await admin.setPersona(user.id, persona, followRoster)
      notify(
        followRoster
          ? `${user.email} now follows the roster`
          : `${user.email} set to ${persona} and pinned`,
      )
      await load()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'update failed')
    } finally {
      setPending(null)
    }
  }

  const setAllowance = async (user: AdminUser, allowance: number) => {
    if (!user.student) return
    setPending(user.id)
    try {
      await admin.setAllowance(user.student.id, allowance)
      notify(`${user.email} may activate ${allowance}`)
      await load()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'update failed')
    } finally {
      setPending(null)
    }
  }

  const setCosmicId = async (user: AdminUser, value: string) => {
    if (!user.student) return
    const next = value.trim() === '' ? null : value.trim()
    if (next === (user.student.cosmicStudentId ?? null)) return
    setPending(user.id)
    try {
      await admin.setCosmicId(user.student.id, next)
      notify(next ? `${user.email} mapped to COSMIC ${next}` : 'COSMIC mapping cleared')
      await load()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'update failed')
    } finally {
      setPending(null)
    }
  }

  const retryAssignment = async (assignment: AdminAssignment) => {
    setPending(assignment.id)
    try {
      const { outcome } = await admin.retryAssignment(assignment.id)
      notify(`${assignment.competition.name}: ${ASSIGNMENT_REASON[outcome.status] ?? outcome.status}`)
      await load()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'retry failed')
    } finally {
      setPending(null)
    }
  }

  const drainAssignments = async () => {
    setPending('drain')
    try {
      const { summary } = await admin.drainAssignments()
      notify(
        `${summary.attempted} attempted · ${summary.sent} assigned · ${summary.waiting} still waiting`,
      )
      await load()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'drain failed')
    } finally {
      setPending(null)
    }
  }

  if (authed === null) {
    return <FullPageLoader />
  }

  if (!authed) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-5">
        <form onSubmit={submitPassword} className="w-full max-w-sm rounded-2xl border border-border bg-card p-7">
          <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="size-5" />
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight">Admin access</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Enter the shared admin password to manage account status.
          </p>
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="mt-5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          {error && <p className="mt-3 text-xs font-medium text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-5 w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-5 py-5 md:px-10">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-primary">CreatED internal</p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">Account status</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-primary"
          >
            <RefreshCw className="size-3.5" /> Refresh
          </button>
          <button
            onClick={async () => {
              await admin.logout()
              setAuthed(false)
            }}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-5 md:p-10">
        {overview?.warning && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[.07] p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">{overview.warning}</p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Enrolled accounts" value={overview?.users.enrolled} />
          <Stat label="TOF accounts" value={overview?.users.tof} />
          <Stat label="Manually pinned" value={overview?.users.overridden} hint="ignored by roster sync" />
          <Stat
            label="Roster rows"
            value={overview?.rosterEntries}
            hint={
              overview?.lastRosterSync
                ? `last sync ${overview.lastRosterSync.status.toLowerCase()}`
                : 'never synced'
            }
          />
          <Stat
            label="Awaiting review"
            value={overview?.pendingReviews}
            hint="held from students until approved"
          />
          <Stat
            label="Students with 3 picks"
            value={overview?.studentsWithPicks}
            hint="ready for the Day 9 email"
          />
          <Stat
            label="Roster rows with no project"
            value={overview?.rosterWithoutProject}
            hint="cannot produce picks — fill in on the sheet"
          />
        </div>

        {/* Nothing here has reached a family yet — this is the gate. */}
        <div className="mt-8 rounded-2xl border border-border bg-card">
          <div className="border-b border-border p-5">
            <h2 className="font-semibold">Awaiting review</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {reviews.length === 0
                ? 'Nothing waiting. Students see their matches once a set is approved.'
                : `${reviews.length} recommendation ${reviews.length === 1 ? 'set is' : 'sets are'} held from students until approved.`}
            </p>
          </div>
          {reviews.length > 0 && (
            <div className="divide-y divide-border">
              {reviews.map((review) => (
                <Link
                  key={review.id}
                  href={`/admin/reviews/${review.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 p-5 hover:bg-muted"
                >
                  <div>
                    <p className="text-sm font-semibold">{review.studentName ?? 'Student'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {review.projectName ?? 'Unnamed project'}
                      {review.grade ? ` · Grade ${review.grade}` : ''}
                      {review.school ? ` · ${review.school}` : ''}
                    </p>
                  </div>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                    {review.itemCount} competitions · review
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Selected competitions on their way to COSMIC. Most of what sits here
            is waiting on something a person can fix — a project that has not
            been created, or a family whose addresses do not line up. */}
        <div className="mt-8 rounded-2xl border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-semibold">COSMIC assignments</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {Object.entries(assignmentCounts)
                  .map(([status, count]) => `${count} ${status.toLowerCase().replaceAll('_', ' ')}`)
                  .join(' · ') || 'Nothing selected yet.'}
              </p>
            </div>
            <button
              onClick={() => void drainAssignments()}
              disabled={pending === 'drain' || assignments.length === 0}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-primary disabled:opacity-40"
            >
              <RefreshCw className="size-3.5" /> Push the queue now
            </button>
          </div>

          {assignments.length > 0 && (
            <div className="divide-y divide-border">
              {assignments
                .filter((a) => a.status !== 'SENT')
                .concat(assignments.filter((a) => a.status === 'SENT').slice(0, 5))
                .map((assignment) => (
                  <div
                    key={assignment.id}
                    className="flex flex-col gap-3 p-5 md:flex-row md:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">
                          {assignment.competition.name}
                        </p>
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            assignment.status === 'SENT'
                              ? 'bg-primary/10 text-primary'
                              : assignment.status === 'FAILED'
                                ? 'bg-destructive/10 text-destructive'
                                : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {assignment.status === 'SENT' ? (
                            <Check className="size-3" />
                          ) : (
                            <Clock3 className="size-3" />
                          )}
                          {assignment.status.replaceAll('_', ' ')}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {assignment.student.name} · {assignment.student.user.email} ·{' '}
                        {ASSIGNMENT_REASON[assignment.status] ?? assignment.status}
                        {assignment.attempts > 0 ? ` · ${assignment.attempts} attempts` : ''}
                      </p>
                      {assignment.status === 'FAILED' && assignment.lastError && (
                        <p className="mt-1.5 truncate text-xs text-destructive">
                          {assignment.lastError}
                        </p>
                      )}
                    </div>
                    {assignment.status !== 'SENT' && (
                      <button
                        disabled={pending === assignment.id}
                        onClick={() => void retryAssignment(assignment)}
                        className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-primary disabled:opacity-40"
                      >
                        Retry now
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="mt-8 rounded-2xl border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-semibold">Accounts</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {total} total · switching a status pins it against the 5-hourly roster sync
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search email"
                  className="w-56 rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-xs outline-none focus:border-primary"
                />
              </div>
              {(['ALL', 'ENROLLED', 'TOF'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setFilter(option)}
                  className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                    filter === option
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border text-muted-foreground'
                  }`}
                >
                  {option === 'ALL' ? 'All' : option === 'ENROLLED' ? 'Enrolled' : 'TOF'}
                </button>
              ))}
            </div>
          </div>

          {users.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No accounts match.</p>
          ) : (
            <div className="divide-y divide-border">
              {users.map((user) => (
                <div key={user.id} className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold">{user.email}</p>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          user.persona === 'ENROLLED'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {user.persona}
                      </span>
                      {user.personaLockedAt && (
                        <span className="rounded-md border border-border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          pinned
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {user.student?.name ?? 'No student profile'}
                      {user.student?.country ? ` · ${user.student.country}` : ''} · roster says{' '}
                      <span className="font-medium">{user.rosterPersona}</span> (
                      {user.rosterReason.toLowerCase().replaceAll('_', ' ')})
                    </p>
                    {user.overridden && (
                      <p className="mt-1.5 text-xs font-medium text-amber-600">
                        Manual status disagrees with the sheet.
                      </p>
                    )}

                    {/* Entitlement and the COSMIC mapping only mean anything for
                        an enrolled student: a TOF account selects nothing. */}
                    {user.persona === 'ENROLLED' && user.student && (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          Competitions included
                          <input
                            type="number"
                            min={0}
                            max={20}
                            disabled={pending === user.id}
                            defaultValue={user.entitlement?.allowance ?? 2}
                            onBlur={(e) => {
                              const next = Number(e.target.value)
                              if (
                                Number.isFinite(next) &&
                                next !== (user.entitlement?.allowance ?? -1)
                              ) {
                                void setAllowance(user, next)
                              }
                            }}
                            className="w-16 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
                          />
                        </label>
                        {user.entitlement && (
                          <span className="text-xs text-muted-foreground">
                            {user.entitlement.used} active
                            {user.entitlement.isDefault ? ' · using the default' : ''}
                          </span>
                        )}
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          COSMIC student id
                          <input
                            type="text"
                            disabled={pending === user.id}
                            defaultValue={user.student.cosmicStudentId ?? ''}
                            placeholder="matched by email"
                            onBlur={(e) => void setCosmicId(user, e.target.value)}
                            className="w-64 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
                          />
                        </label>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {(['TOF', 'ENROLLED'] as const).map((option) => (
                      <button
                        key={option}
                        disabled={pending === user.id || user.persona === option}
                        onClick={() => void changePersona(user, option)}
                        className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40 ${
                          user.persona === option
                            ? 'bg-muted text-muted-foreground'
                            : 'border border-border text-primary hover:bg-muted'
                        }`}
                      >
                        {user.persona === option ? (
                          <>
                            <Check className="mr-1 inline size-3" />
                            {option}
                          </>
                        ) : (
                          `Set ${option}`
                        )}
                      </button>
                    ))}
                    {user.personaLockedAt && (
                      <button
                        disabled={pending === user.id}
                        onClick={() => void changePersona(user, user.rosterPersona, true)}
                        className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground disabled:opacity-40"
                      >
                        Follow roster
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {overview && (
          <p className="mt-6 text-xs text-muted-foreground">
            Competition repository: {overview.competitions.total} documents (
            {Object.entries(overview.competitions.byRegion)
              .map(([region, count]) => `${region} ${count}`)
              .join(' · ')}
            )
          </p>
        )}
      </main>

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-foreground px-4 py-3 text-xs font-medium text-background shadow-xl">
          <Check className="size-4 text-primary" />
          {toast}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value?: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value ?? '—'}</p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
