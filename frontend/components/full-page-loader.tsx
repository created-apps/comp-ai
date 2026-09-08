'use client'

import { Loader2 } from 'lucide-react'

/**
 * The one thing this app server-renders.
 *
 * Both pages fetch their session in `useEffect`, so the initial loading state is
 * the entire SSR output — everything else renders after hydration and cannot
 * mismatch.
 *
 * `suppressHydrationWarning` is here because Dark Reader (and similar theme
 * extensions) rewrite an inline SVG's stroke before React hydrates, adding
 * `data-darkreader-inline-stroke` and a `--darkreader-inline-stroke` style to
 * this exact element. React then reports a hydration mismatch for markup we did
 * not write.
 *
 * It is deliberately scoped to these two elements rather than sprinkled around:
 * the flag only applies one level deep (which is why putting it on <html>/<body>
 * did nothing for this), and using it more widely would start hiding real
 * mismatches in our own components.
 */
export default function FullPageLoader() {
  return (
    <div
      suppressHydrationWarning
      className="grid min-h-screen place-items-center bg-background text-muted-foreground"
    >
      <Loader2 suppressHydrationWarning className="size-5 animate-spin" />
    </div>
  )
}
