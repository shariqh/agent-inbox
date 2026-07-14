import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { listItems, resolveItem, dismissItem, annotateItem, listBoards, archiveBoard, annotateBoardRow } from './store.js'
import { groupItems } from './group.js'

export function createViewer(db: Database.Database): Hono {
  const app = new Hono()

  app.get('/api/items', (c) => c.json(groupItems(listItems(db))))

  app.post('/api/items/:id/resolve', (c) => {
    resolveItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/dismiss', (c) => {
    dismissItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateItem(db, c.req.param('id'), text)
    return c.json({ ok: true })
  })

  app.get('/api/boards', (c) => c.json(listBoards(db)))

  app.post('/api/boards/:id/archive', (c) => {
    archiveBoard(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/boards/:id/rows/:rowId/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateBoardRow(db, c.req.param('rowId'), text)
    return c.json({ ok: true })
  })

  return app
}
