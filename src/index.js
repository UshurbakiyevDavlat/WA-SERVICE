/**
 * wa-service — HTTP API сервер.
 * Дроп-ин замена WAHA с совместимым API.
 *
 * Ключевые эндпоинты (идентичны WAHA):
 *   GET  /api/sessions/:session           → статус
 *   PUT  /api/sessions/:session           → configure webhook + start
 *   POST /api/sessions/:session/start     → запустить сессию
 *   POST /api/sessions/:session/stop      → stop (logout + удалить creds)
 *   POST /api/sessions/:session/logout    → logout (для рекавери из FAILED)
 *   GET  /api/:session/auth/qr            → QR как base64 PNG data URL
 *   POST /api/sendText                    → отправить сообщение
 *
 * Auth: X-Api-Key header (опционально — если WAHA_API_KEY задан в env)
 */

import express from 'express'
import { SessionManager } from './sessions.js'

const app = express()
app.use(express.json())

const manager = new SessionManager()
const PORT = process.env.PORT || 3000
const API_KEY = process.env.WAHA_API_KEY || ''


// ── API Key middleware ─────────────────────────────────────────────────────────

app.use('/api', (req, res, next) => {
  if (!API_KEY) return next()   // ключ не задан → открытый доступ (dev режим)
  const key = req.headers['x-api-key']
  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' })
  }
  next()
})


// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: manager.listSessions().length })
})


// ── Session management ────────────────────────────────────────────────────────

/**
 * GET /api/sessions/:session
 * Получить статус сессии.
 * Возвращает { name, status, me } — совместимо с WAHA.
 */
app.get('/api/sessions/:session', (req, res) => {
  const { session } = req.params
  const data = manager.status(session)

  // WAHA возвращает 404 если сессии нет → наш клиент интерпретирует как STOPPED
  if (data.status === 'STOPPED' && !manager.sessions.has(session)) {
    return res.status(404).json({ message: `Session not found: ${session}` })
  }

  res.json(data)
})


/**
 * PUT /api/sessions/:session
 * Upsert сессии — создать или обновить конфигурацию (webhook) и запустить.
 * Наш бэкенд вызывает PUT перед POST /start (логика WAHAClient.start_session).
 */
app.put('/api/sessions/:session', async (req, res) => {
  const { session } = req.params
  const webhookUrl = req.body?.config?.webhooks?.[0]?.url || null

  try {
    const data = await manager.start(session, webhookUrl)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


/**
 * POST /api/sessions/:session/start
 * Запустить сессию. Если уже запущена — возвращает текущий статус (не ошибку).
 */
app.post('/api/sessions/:session/start', async (req, res) => {
  const { session } = req.params

  try {
    // PUT уже мог создать сессию — просто убеждаемся что запущена
    const data = await manager.start(session, null)

    // WAHA возвращает 422 если сессия уже запускалась — мы возвращаем 200
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


/**
 * POST /api/sessions/:session/stop
 * Остановить сессию + удалить creds. Следующий start = новый QR.
 */
app.post('/api/sessions/:session/stop', async (req, res) => {
  const { session } = req.params
  try {
    await manager.stop(session)
    res.json({ name: session, status: 'STOPPED' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


/**
 * POST /api/sessions/:session/logout
 * Logout без stop (для рекавери из FAILED).
 * После logout → start() = свежий QR код.
 */
app.post('/api/sessions/:session/logout', async (req, res) => {
  const { session } = req.params
  try {
    await manager.logout(session)
    res.json({ name: session, status: 'STOPPED' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


// ── QR Code ───────────────────────────────────────────────────────────────────

/**
 * GET /api/:session/auth/qr
 * Возвращает QR как JSON { image: "data:image/png;base64,..." }
 * Наш WAHAClient.get_qr_base64() парсит именно этот формат.
 */
app.get('/api/:session/auth/qr', (req, res) => {
  const { session } = req.params
  const qr = manager.qr(session)

  if (!qr) {
    return res.status(404).json({ message: 'QR not available (session not in SCAN_QR_CODE state)' })
  }

  // data URL format: "data:image/png;base64,XXX"
  res.json({ image: qr })
})


// ── Sending messages ──────────────────────────────────────────────────────────

/**
 * POST /api/sendText
 * Отправить текстовое сообщение.
 * Body: { session, chatId, text }
 * Совместимо с WAHA.
 */
app.post('/api/sendText', async (req, res) => {
  const { session, chatId, text } = req.body

  if (!session || !chatId || !text) {
    return res.status(400).json({ error: 'session, chatId and text are required' })
  }

  try {
    await manager.sendMessage(session, chatId, text)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


// ── Sessions list ─────────────────────────────────────────────────────────────

/**
 * GET /api/sessions
 * Список всех сессий — используется для мониторинга.
 */
app.get('/api/sessions', (_req, res) => {
  res.json(manager.listSessions())
})


// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[wa-service] Started on port ${PORT}`)
  console.log(`[wa-service] API key: ${API_KEY ? 'set' : 'not set (open access)'}`)
})
