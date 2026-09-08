'use client'

/**
 * Two inputs, as the TOF requirement specifies: a domain and a one-sentence
 * project description. Enrolled students get the same form — the pipeline is
 * shared, and a longer description simply produces a better classification.
 */

import { useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { projects, recommendations } from '@/lib/api'

const DOMAINS = [
  'AI / Machine learning',
  'Computer science',
  'Robotics',
  'Engineering',
  'Biology / Life sciences',
  'Medicine / Health',
  'Chemistry',
  'Physics / Astronomy',
  'Mathematics',
  'Sustainability / Climate',
  'Entrepreneurship / Business',
  'Economics',
  'Social impact',
  'Psychology',
  'Humanities / Writing',
  'Design / Art / Film',
]

export default function ProjectForm({
  onComplete,
}: {
  onComplete: (projectId: string, runId: string) => void
}) {
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      setStatus('Saving your project…')
      const { project } = await projects.create({
        ...(name.trim() ? { name: name.trim() } : {}),
        domain,
        description,
      })

      // Two model calls plus retrieval — slow enough that silence looks broken.
      setStatus('Reading your project and searching the competition repository…')
      const run = await recommendations.generate(project.id)

      if (run.itemCount === 0) {
        setError(
          run.warning ??
            'No competitions matched this project. Try describing what you actually built in more detail.',
        )
        return
      }
      onComplete(project.id, run.runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <label className="block text-xs font-semibold text-muted-foreground" htmlFor="name">
        Project name
      </label>
      <input
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Construction Impact Forecast Platform"
        className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
      />
      <p className="mt-2 text-[11px] text-muted-foreground">
        What you call it. We use this when we write to you about the project.
      </p>

      <label className="mt-5 block text-xs font-semibold text-muted-foreground" htmlFor="domain">
        Project domain
      </label>
      <select
        id="domain"
        required
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
      >
        <option value="">Choose a domain…</option>
        {DOMAINS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>

      <label
        className="mt-5 block text-xs font-semibold text-muted-foreground"
        htmlFor="description"
      >
        What are you building or researching?
      </label>
      <textarea
        id="description"
        required
        rows={4}
        minLength={20}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One or two sentences. What problem, who it is for, and how far you have got."
        className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-6 outline-none focus:border-primary"
      />
      <p className="mt-2 text-[11px] text-muted-foreground">
        Be concrete about what exists today — an idea, a prototype, or a written study. It changes
        which competitions actually fit.
      </p>

      {error && <p className="mt-4 text-xs font-medium text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={busy || !domain || description.trim().length < 20}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {busy ? (status || 'Working…') : 'Get my competitions'}
        {!busy && <ArrowRight className="size-4" />}
      </button>
    </form>
  )
}
