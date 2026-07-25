import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TranscriptEntry } from '@shared/types'

function summarizeArgs(name: string, input: Record<string, unknown>): string {
  const pick = (key: string): string => String(input[key] ?? '')
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return pick('path')
    case 'glob':
      return pick('pattern')
    case 'grep':
      return pick('pattern')
    case 'bash':
      return pick('command')
    default:
      return Object.keys(input).length ? JSON.stringify(input).slice(0, 120) : ''
  }
}

function ToolCard({ entry }: { entry: Extract<TranscriptEntry, { kind: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const done = entry.result !== undefined

  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        {done ? <span className="chev">{open ? '▾' : '▸'}</span> : <span className="spin" />}
        <span className="tool-name">{entry.name}</span>
        <span className="tool-arg">{summarizeArgs(entry.name, entry.input)}</span>
        {entry.isError && <span className="badge deleted">error</span>}
      </button>
      {open && done && (
        <div className={`tool-body${entry.isError ? ' error' : ''}`}>
          {entry.result || '(no output)'}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({
  entry
}: {
  entry: Extract<TranscriptEntry, { kind: 'thinking' }>
}): JSX.Element {
  return (
    <div className="thinking">
      <div className="thinking-label">Reasoning</div>
      {entry.text}
    </div>
  )
}

export default function Transcript({
  entries,
  running
}: {
  entries: TranscriptEntry[]
  running: boolean
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Follow new output, but stop following the moment the user scrolls up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <div className="scroll" ref={scrollRef}>
      <div className="transcript">
        {entries.map((entry) => {
          switch (entry.kind) {
            case 'user':
              return (
                <div key={entry.id} className="msg-user">
                  {entry.text}
                </div>
              )
            case 'assistant':
              return (
                <div key={entry.id} className="msg-assistant">
                  {entry.text}
                </div>
              )
            case 'thinking':
              return <ThinkingBlock key={entry.id} entry={entry} />
            case 'tool':
              return <ToolCard key={entry.id} entry={entry} />
            case 'error':
              return (
                <div key={entry.id} className="msg-error">
                  {entry.text}
                </div>
              )
            case 'usage':
              return (
                <div key={entry.id} className="usage">
                  {entry.usage.inputTokens?.toLocaleString() ?? 0} in ·{' '}
                  {entry.usage.outputTokens?.toLocaleString() ?? 0} out
                </div>
              )
            default:
              return null
          }
        })}
        {running && entries.length === 0 && <div className="usage">Starting…</div>}
      </div>
    </div>
  )
}