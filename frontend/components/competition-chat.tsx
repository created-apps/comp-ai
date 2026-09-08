'use client'

/**
 * Competition AI.
 *
 * Enrolled students only — the page does not render this for anyone else, and
 * the backend refuses the request independently.
 *
 * The assistant answers strictly from the competition repository, so the UI
 * shows which competitions each answer drew on. That is not decoration: it is
 * how a student checks an answer rather than trusting it.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, MessageSquare, Sparkles, X } from 'lucide-react'
import { chat } from '@/lib/api'

interface Turn {
  role: 'user' | 'assistant'
  text: string
  sources?: string[]
}

const SUGGESTIONS = [
  'What could I enter with my project?',
  'What are my next deadlines?',
  'What does IRIS expect in a submission?',
]

/** Slugs are region-qualified ids ("crest-awards--in"); show them readably. */
function prettySlug(slug: string): string {
  return slug
    .replace(/--(in|us)$/i, '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export default function CompetitionChat() {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, busy])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return

    setTurns((t) => [...t, { role: 'user', text: message }])
    setInput('')
    setBusy(true)
    setError('')

    try {
      const reply = await chat.ask(message, sessionId)
      setSessionId(reply.sessionId)
      setTurns((t) => [
        ...t,
        { role: 'assistant', text: reply.reply, sources: reply.sources },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not get an answer')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-lg"
      >
        <MessageSquare className="size-4" />
        Ask Competition AI
      </button>
    )
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex h-[70vh] flex-col border-t border-border bg-card shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[560px] sm:w-[420px] sm:rounded-2xl sm:border">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <div>
            <p className="text-sm font-semibold">Competition AI</p>
            <p className="text-[10px] text-muted-foreground">
              Answers from CreatED&apos;s competition repository
            </p>
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div>
            <p className="text-sm leading-6 text-muted-foreground">
              Ask about competitions, what they expect, or when things are due. I only answer
              from CreatED&apos;s repository — if something isn&apos;t in it, I&apos;ll say so
              rather than guess.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-lg border border-border px-3 py-2 text-left text-xs font-medium text-primary hover:bg-muted"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={turn.role === 'user' ? 'flex justify-end' : ''}>
            <div
              className={
                turn.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground'
                  : 'max-w-full text-sm leading-6'
              }
            >
              <p className="whitespace-pre-wrap">{turn.text}</p>
              {turn.sources && turn.sources.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {turn.sources.map((slug) => (
                    <span
                      key={slug}
                      className="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground"
                    >
                      {prettySlug(slug)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Searching the repository…
          </p>
        )}
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
        className="flex items-center gap-2 border-t border-border p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about a competition…"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>
    </div>
  )
}
