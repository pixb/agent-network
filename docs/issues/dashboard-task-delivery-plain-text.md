# Task body and delivery text are shown as plain text in the web Dashboard

## Summary

The task detail panel and the Messages pages render `tasks.content` and `tasks.result` with
`whitespace-pre-wrap` plain text, while the node chat panel already renders the same fields through
`react-markdown`. Workers follow the protocol's line format and write Markdown (lists, headings,
tables) because the chat panel is where deliveries are read. On the plain-text surfaces the markup
appears as its own characters.

## Environment

- Repository: `agent-network-dashboard` (Next.js app, Tailwind v4)
- Observed at: current `pixb` checkout, 2026-11-09
- Area: Tasks detail, Messages, Nodes (cards and list rows)

## Measured facts

| surface | renderer today | visible | code |
|---|---|---|---|
| Task detail: task body | plain text `whitespace-pre-wrap break-words … font-sans`, `max-h-64 overflow-y-auto` | scrolls | `app/components/TaskDetail.tsx:329` |
| Task detail: `task.result` | plain text, same classes | scrolls | `app/components/TaskDetail.tsx:345` |
| Messages page message body | plain text `whitespace-pre-wrap break-words` | — | `app/messages/page.tsx:443`, `:488` |
| Inbox page body | plain text `whitespace-pre-wrap break-words` | — | `app/messages/inbox/page.tsx:187` |
| Node chat panel (opened from a node) | **`react-markdown` + `remark-gfm`**, per-element classes, image lightbox, `CollapsibleText` collapsed at `COLLAPSE_MAX_PX = 300` (≈12 lines) | expandable | `app/components/TaskChatPanel.tsx:492-493`, `:561`, `m.result :1725`, `m.content :1769`, `:601` |
| Node card current task | plain text, `line-clamp-2` | 2 lines | `app/nodes/NodesView.tsx:803` |
| Node list row / compact grid | plain text, `truncate` | 1 line (`title` carries the rest) | `app/nodes/NodesView.tsx:872`, `:927` |

The repository already solved exactly this problem for requirement comments: `app/components/CommentMarkdown.tsx`
documents that `## 归因更正`, `**错误**` and backticks were displayed as raw characters and adds a
`react-markdown` + `remark-gfm` component map with per-element classes (no `prose`, because
`@tailwindcss/typography` is not installed and Tailwind preflight resets heading and list styles).

## Expected behaviour

`TaskDetail.tsx` renders `task.content` and `task.result` through the existing Markdown component
(the `CommentMarkdown` element map, or an equivalent shared component), and the Messages / inbox
message bodies through the same component. `CollapsibleText` (collapse at 300px with an expand
control) should apply to the delivery text the way it does in the chat panel.

## Out of scope

- No changes to the hub, the API, or stored text.
- No `rehype-raw`: HTML in task text must stay text (the existing component already takes this position).
- No change to the node card / list row rendering: those show the hub's 200-character preview slice and
  are intentionally one line. The protocol keeps line 1 self-sufficient for them.
- No change to Markdown syntax rules on the agent side; the protocol skill keeps its
  "markdown-safe subset" rule until this lands.

## Why it matters

The delivery text is the human's acceptance surface. A 1200-character delivery with three evidence
lines is readable when it is rendered; when it is not, the reviewer sees `**`, `|`, `##` characters and
has to open the raw text elsewhere.
